// PDFy's Windows window. All the app logic lives in the web folder. This file gives it a native
// window, hands it files, and brings it back if the engine underneath ever crashes.

using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace PDFy;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        // The last line of defence. A message box is better than a window that just vanishes.
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) => Log("UI thread: " + e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Log("Fatal: " + e.ExceptionObject);
        TaskScheduler.UnobservedTaskException += (_, e) => { Log("Task: " + e.Exception); e.SetObserved(); };

        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new MainForm(args));
    }

    internal static readonly string DataDir =
        Environment.GetEnvironmentVariable("PDFY_DEV") == "1" &&
        Environment.GetEnvironmentVariable("PDFY_TEST_DATA_DIR") is { Length: > 0 } testDataDir
            ? Path.GetFullPath(testDataDir)
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PDFy");

    internal static void Log(string message)
    {
        try
        {
            Directory.CreateDirectory(DataDir);
            var path = Path.Combine(DataDir, "pdfy.log");
            // Keep the log from ever growing large.
            if (File.Exists(path) && new FileInfo(path).Length > 256 * 1024) File.Delete(path);
            File.AppendAllText(path, $"{DateTime.Now:s} {message}{Environment.NewLine}");
        }
        catch
        {
            // Logging must never be the thing that fails.
        }
    }
}

internal sealed partial class MainForm : Form
{
    private const string Host = "pdfy.local";
    private const string PrintHost = "print.pdfy.local";
    private const string FontHost = "fonts.pdfy.local";
    private const int MaxRestarts = 5;

    private WebView2 _web = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = HeaderColor };
    private readonly Queue<string> _pendingFiles = new();
    private CoreWebView2Environment? _env;
    private bool _pageReady;
    private bool _closeApproved;
    private int _restarts;
    private DateTime _lastRestart = DateTime.MinValue;

    public MainForm(string[] args)
    {
        Text = "PDFy";
        BackColor = HeaderColor;
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        MinimumSize = new Size(640, 420);
        Controls.Add(_web);
        RestoreBounds_();
        foreach (var a in args)
        {
            if (File.Exists(a)) _pendingFiles.Enqueue(Path.GetFullPath(a));
        }
        Shown += async (_, _) => await StartAsync();
        FormClosing += OnFormClosing;
        Resize += (_, _) => TrimWhenMinimised();
    }

    private static string WebRoot => Path.Combine(AppContext.BaseDirectory, "web");

    private async Task StartAsync()
    {
        try
        {
            if (!File.Exists(Path.Combine(WebRoot, "index.html")))
            {
                Fatal("The app files are missing. Reinstall PDFy, or run the build again.");
                return;
            }
            // Measured on a 144 MB file: no GPU saves about 40% of memory and returns it after closing,
            // while scrolling stays above 60 frames a second, even zoomed to 300%.
            var args = "--disable-gpu --disable-software-rasterizer --disable-features=msSmartScreenProtection --disable-background-networking";
            var port = Environment.GetEnvironmentVariable("PDFY_DEBUG_PORT");
            if (!string.IsNullOrEmpty(port)) args += $" --remote-debugging-port={port}";
            _env ??= await CoreWebView2Environment.CreateAsync(null, Path.Combine(Program.DataDir, "engine"), new CoreWebView2EnvironmentOptions(args));
            await _web.EnsureCoreWebView2Async(_env);
            Configure(_web.CoreWebView2);
            var testing = Environment.GetEnvironmentVariable("PDFY_DEV") == "1" ? "?test=1" : "";
            _web.CoreWebView2.Navigate($"https://{Host}/index.html{testing}");
        }
        catch (WebView2RuntimeNotFoundException)
        {
            Fatal("PDFy needs the Microsoft Edge WebView2 Runtime, which is part of Windows 11.\n\nIt can be installed from Microsoft's website.");
        }
        catch (Exception e)
        {
            Program.Log("Start: " + e);
            Fatal("PDFy could not start: " + e.Message);
        }
    }

    private void Configure(CoreWebView2 core)
    {
        core.SetVirtualHostNameToFolderMapping(Host, WebRoot, CoreWebView2HostResourceAccessKind.Allow);
        ClearPrintFolder();
        core.SetVirtualHostNameToFolderMapping(PrintHost, PrintDir, CoreWebView2HostResourceAccessKind.Allow);
        // Windows fonts are embedded into saved PDFs, so any language stays real, selectable text.
        core.SetVirtualHostNameToFolderMapping(FontHost, Environment.GetFolderPath(Environment.SpecialFolder.Fonts), CoreWebView2HostResourceAccessKind.Allow);

        var s = core.Settings;
        // Only the main view uses HTML title-bar regions, including after crash recovery.
        try { s.IsNonClientRegionSupportEnabled = true; }
        catch (Exception e) { UseStandardFrame(e); }
        // The page has its own shortcuts for print, search and zoom.
        s.AreBrowserAcceleratorKeysEnabled = false;
        s.IsZoomControlEnabled = false;
        s.IsPinchZoomEnabled = false;
        s.IsStatusBarEnabled = false;
        s.IsGeneralAutofillEnabled = false;
        s.IsPasswordAutosaveEnabled = false;
        s.IsSwipeNavigationEnabled = false;
        s.AreDevToolsEnabled = Environment.GetEnvironmentVariable("PDFY_DEV") == "1";
        s.AreDefaultScriptDialogsEnabled = true;

        core.DocumentTitleChanged += (_, _) => Text = string.IsNullOrEmpty(core.DocumentTitle) ? "PDFy" : core.DocumentTitle;
        core.ProcessFailed += OnProcessFailed;
        core.WebMessageReceived += OnWebMessage;
        core.ContainsFullScreenElementChanged += (_, _) => SetFullScreen(core.ContainsFullScreenElement);
        _web.KeyDown += OnWindowKeyDown;

        // This is the user's own app and their own files, so these never need a browser-style prompt:
        // pasting after a click, and getting back to a file they already opened, for example after a crash.
        core.PermissionRequested += (_, e) =>
        {
            if (e.PermissionKind == CoreWebView2PermissionKind.ClipboardRead && e.IsUserInitiated) e.State = CoreWebView2PermissionState.Allow;
            if (e.PermissionKind == CoreWebView2PermissionKind.FileReadWrite) e.State = CoreWebView2PermissionState.Allow;
        };

        // Web links open in the user's browser, never inside the editor.
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            OpenExternal(e.Uri);
        };
        core.NavigationStarting += (_, e) =>
        {
            if (!e.Uri.StartsWith($"https://{Host}/", StringComparison.OrdinalIgnoreCase))
            {
                e.Cancel = true;
                OpenExternal(e.Uri);
            }
        };
    }

    /// <summary>A minimised window hands back whatever memory the engine can spare.</summary>
    private void TrimWhenMinimised()
    {
        var core = _web.CoreWebView2;
        if (core is null) return;
        try
        {
            core.MemoryUsageTargetLevel = WindowState == FormWindowState.Minimized
                ? CoreWebView2MemoryUsageTargetLevel.Low
                : CoreWebView2MemoryUsageTargetLevel.Normal;
        }
        catch (Exception e)
        {
            Program.Log("Memory level: " + e.Message);
        }
    }

    private static void OpenExternal(string uri)
    {
        if (!Uri.TryCreate(uri, UriKind.Absolute, out var parsed)) return;
        if (parsed.Scheme is not ("http" or "https" or "mailto")) return;
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(parsed.AbsoluteUri) { UseShellExecute = true });
        }
        catch (Exception e)
        {
            Program.Log("Open link: " + e.Message);
        }
    }

    /// <summary>
    /// The engine underneath died, for example out of memory on a page. The window stays open and the
    /// page reloads, and the page then offers to restore unsaved work from its recovery data.
    /// </summary>
    private async void OnProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs e)
    {
        Program.Log($"Engine failed: {e.ProcessFailedKind} {e.Reason} code {e.ExitCode}");
        if ((DateTime.Now - _lastRestart).TotalMinutes > 5) _restarts = 0;
        _lastRestart = DateTime.Now;
        if (++_restarts > MaxRestarts)
        {
            Fatal("The PDF engine keeps stopping. Your unsaved work is kept and will be offered next time PDFy starts.");
            return;
        }

        switch (e.ProcessFailedKind)
        {
            case CoreWebView2ProcessFailedKind.BrowserProcessExited:
                // The whole engine went away, so the control must be rebuilt.
                _pageReady = false;
                await RebuildAsync();
                break;
            case CoreWebView2ProcessFailedKind.RenderProcessExited:
            case CoreWebView2ProcessFailedKind.RenderProcessUnresponsive:
                _pageReady = false;
                _web.CoreWebView2.Reload();
                break;
            // A GPU or helper process failure heals itself.
        }
    }

    private async Task RebuildAsync()
    {
        try
        {
            Controls.Remove(_web);
            _web.Dispose();
            var fresh = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = BackColor };
            _web = fresh;
            Controls.Add(fresh);
            _env = null;
            await StartAsync();
        }
        catch (Exception e)
        {
            Program.Log("Rebuild: " + e);
            Fatal("PDFy could not recover. Your unsaved work will be offered next time it starts.");
        }
    }

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var type = doc.RootElement.TryGetProperty("type", out var t) ? t.GetString() : null;
            switch (type)
            {
                case "ready":
                    _pageReady = true;
                    SendWindowState();
                    SendPendingFiles();
                    break;
                case "win":
                    HandleWindowAction(doc.RootElement.GetProperty("action").GetString());
                    break;
                case "win-color":
                    SetWindowColor(doc.RootElement.GetProperty("color").GetString());
                    break;
                case "close-ok":
                    _closeApproved = true;
                    Close();
                    break;
                case "print":
                    _ = PrintAsync(doc.RootElement.Clone());
                    break;
                case "web-fetch":
                    _ = FetchPageAsync(doc.RootElement.GetProperty("id").GetInt32(), doc.RootElement.GetProperty("url").GetString() ?? "");
                    break;
                case "font-list":
                    _ = SendFontListAsync();
                    break;
                case "reference":
                    _ = OpenReferenceAsync(
                        doc.RootElement.TryGetProperty("url", out var u) ? u.GetString() ?? "" : "",
                        doc.RootElement.TryGetProperty("title", out var ti) ? ti.GetString() ?? "" : "");
                    break;
            }
        }
        catch (Exception ex)
        {
            Program.Log("Message: " + ex.Message);
        }
    }

    /// <summary>Every font family Windows has for this user, for the font picker.</summary>
    private async Task SendFontListAsync()
    {
        try
        {
            var names = await Task.Run(() =>
            {
                using var fonts = new System.Drawing.Text.InstalledFontCollection();
                return fonts.Families.Select(f => f.Name).Where(n => !string.IsNullOrWhiteSpace(n)).Distinct().OrderBy(n => n, StringComparer.CurrentCultureIgnoreCase).ToList();
            });
            _web.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "font-list", names }));
        }
        catch (Exception e)
        {
            Program.Log("Font list: " + e.Message);
        }
    }

    private static readonly string[] DictionaryHosts = { "dictionary.cambridge.org", "www.oxfordlearnersdictionaries.com", "www.ldoceonline.com" };
    private static readonly HttpClient Web = CreateWebClient();

    private static HttpClient CreateWebClient()
    {
        var handler = new HttpClientHandler { AutomaticDecompression = System.Net.DecompressionMethods.All, AllowAutoRedirect = true, MaxAutomaticRedirections = 5 };
        var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(12), MaxResponseContentBufferSize = 4 * 1024 * 1024 };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("PDFy/1.0 (personal dictionary reader)");
        client.DefaultRequestHeaders.AcceptLanguage.ParseAdd("en");
        return client;
    }

    /// <summary>
    /// Reads one dictionary page for a word the user looked up, the same page they could open themselves.
    /// Only the three dictionary sites are allowed, and nothing is kept on disk.
    /// </summary>
    private async Task FetchPageAsync(int id, string url)
    {
        object reply;
        try
        {
            if (!Uri.TryCreate(url, UriKind.Absolute, out var parsed) || parsed.Scheme != "https" || !DictionaryHosts.Contains(parsed.Host))
            {
                throw new InvalidOperationException("Only the dictionary sites are read.");
            }
            using var response = await Web.GetAsync(parsed);
            var final = response.RequestMessage?.RequestUri;
            if (final is null || final.Scheme != "https" || !DictionaryHosts.Contains(final.Host)) throw new InvalidOperationException("The page moved to another site.");
            var html = await response.Content.ReadAsStringAsync();
            reply = new { type = "web-page", id, ok = true, url = final.AbsoluteUri, status = (int)response.StatusCode, html };
        }
        catch (Exception e)
        {
            reply = new { type = "web-page", id, ok = false, error = e is TaskCanceledException ? "The site took too long to answer." : e.Message };
        }
        try
        {
            var json = JsonSerializer.Serialize(reply);
            BeginInvoke(() => _web.CoreWebView2?.PostWebMessageAsJson(json));
        }
        catch (Exception e)
        {
            Program.Log("Page reply: " + e.Message);
        }
    }

    private Form? _refForm;
    private WebView2? _refWeb;
    private string? _refUrl;

    /// <summary>
    /// A small window for the publishers' own dictionary pages. It sits beside the document, is created
    /// only when asked for, and gives its memory back when closed.
    /// </summary>
    private async Task OpenReferenceAsync(string url, string title)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var parsed) || parsed.Scheme != "https" || _env is null) return;
        // The latest request wins, even if it arrives while the window is still starting.
        _refUrl = parsed.AbsoluteUri;
        try
        {
            if (_refForm is null || _refForm.IsDisposed || _refWeb is null)
            {
                var area = Screen.FromControl(this).WorkingArea;
                var w = Math.Min(620, area.Width / 2);
                var h = Math.Min(860, area.Height - 40);
                var form = new Form
                {
                    Text = title, Icon = Icon, Owner = this, ShowInTaskbar = false, StartPosition = FormStartPosition.Manual,
                    Bounds = new Rectangle(area.Right - w - 12, area.Top + 20, w, h), MinimumSize = new Size(360, 320),
                };
                var web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.White };
                form.Controls.Add(web);
                form.FormClosed += (_, _) =>
                {
                    web.Dispose();
                    _refWeb = null;
                    _refForm = null;
                };
                _refForm = form;
                _refWeb = web;
                form.Show(this);
                await web.EnsureCoreWebView2Async(_env);
                var core = web.CoreWebView2;
                core.Settings.IsWebMessageEnabled = false;
                core.Settings.IsGeneralAutofillEnabled = false;
                core.Settings.IsPasswordAutosaveEnabled = false;
                core.Settings.AreDevToolsEnabled = false;
                // Nothing a dictionary page needs: no downloads, no pop-ups, no camera or location.
                core.DownloadStarting += (_, e) => e.Cancel = true;
                core.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
                core.NewWindowRequested += (_, e) =>
                {
                    e.Handled = true;
                    if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var next) && next.Scheme == "https") core.Navigate(next.AbsoluteUri);
                };
                core.NavigationStarting += (_, e) =>
                {
                    if (!e.Uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase) && !e.Uri.StartsWith("about:", StringComparison.OrdinalIgnoreCase)) e.Cancel = true;
                };
                core.DocumentTitleChanged += (_, _) =>
                {
                    if (!form.IsDisposed && !string.IsNullOrEmpty(core.DocumentTitle)) form.Text = core.DocumentTitle;
                };
            }
            _refForm.Text = title;
            _refForm.Activate();
            if (_refWeb?.CoreWebView2 is { } view && _refUrl is not null) view.Navigate(_refUrl);
        }
        catch (Exception e)
        {
            Program.Log("Reference window: " + e.Message);
            OpenExternal(parsed.AbsoluteUri);
        }
    }

    private static string PrintDir => Path.Combine(Program.DataDir, "print");

    private static void ClearPrintFolder()
    {
        try
        {
            if (Directory.Exists(PrintDir)) Directory.Delete(PrintDir, true);
        }
        catch (Exception e)
        {
            Program.Log("Clear print folder: " + e.Message);
        }
        Directory.CreateDirectory(PrintDir);
    }

    /// <summary>
    /// Loads a page in a hidden view and prints it to a PDF. Office conversion and "web page to PDF"
    /// both end up here. Only one kind of failure can reach the user: a message saying it did not work.
    /// </summary>
    private async Task PrintAsync(JsonElement job)
    {
        var id = job.GetProperty("id").GetInt32();
        CoreWebView2Controller? controller = null;
        string? htmlPath = null;
        try
        {
            if (_env is null) throw new InvalidOperationException("The engine is not ready.");
            var name = Guid.NewGuid().ToString("N");
            var output = Path.Combine(PrintDir, name + ".pdf");
            Directory.CreateDirectory(PrintDir);

            controller = await _env.CreateCoreWebView2ControllerAsync(Handle);
            controller.IsVisible = false;
            controller.Bounds = new Rectangle(0, 0, 1280, 900);
            var view = controller.CoreWebView2;
            view.Settings.IsWebMessageEnabled = false;
            view.Settings.AreDefaultScriptDialogsEnabled = false;
            view.NewWindowRequested += (_, e) => e.Handled = true;
            view.DownloadStarting += (_, e) => e.Cancel = true;

            var loaded = new TaskCompletionSource<bool>();
            view.NavigationCompleted += (_, e) => loaded.TrySetResult(e.IsSuccess);

            var isHtml = job.TryGetProperty("html", out var html) && html.ValueKind == JsonValueKind.String;
            if (isHtml)
            {
                view.Settings.IsScriptEnabled = false;
                view.SetVirtualHostNameToFolderMapping(PrintHost, PrintDir, CoreWebView2HostResourceAccessKind.Allow);
                htmlPath = Path.Combine(PrintDir, name + ".html");
                await File.WriteAllTextAsync(htmlPath, html.GetString());
                view.NavigationStarting += (_, e) =>
                {
                    if (!e.Uri.StartsWith($"https://{PrintHost}/", StringComparison.OrdinalIgnoreCase)) e.Cancel = true;
                };
                view.Navigate($"https://{PrintHost}/{name}.html");
            }
            else
            {
                var url = job.GetProperty("url").GetString() ?? "";
                if (!Uri.TryCreate(url, UriKind.Absolute, out var parsed) || parsed.Scheme is not ("http" or "https"))
                {
                    throw new InvalidOperationException("That is not a valid web address.");
                }
                view.Navigate(parsed.AbsoluteUri);
            }

            var finished = await Task.WhenAny(loaded.Task, Task.Delay(TimeSpan.FromSeconds(90)));
            if (finished != loaded.Task) throw new TimeoutException("The page took too long to load.");
            if (!await loaded.Task) throw new InvalidOperationException("The page could not be loaded.");
            // Web pages often keep drawing just after they report being loaded.
            await Task.Delay(isHtml ? 150 : 2000);

            var settings = _env.CreatePrintSettings();
            settings.PageWidth = job.GetProperty("widthIn").GetDouble();
            settings.PageHeight = job.GetProperty("heightIn").GetDouble();
            var margin = job.GetProperty("marginIn").GetDouble();
            settings.MarginTop = settings.MarginBottom = settings.MarginLeft = settings.MarginRight = margin;
            settings.ShouldPrintBackgrounds = true;
            settings.ShouldPrintHeaderAndFooter = false;
            if (!await view.PrintToPdfAsync(output, settings)) throw new InvalidOperationException("The print engine reported a failure.");

            _web.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "printed", id, ok = true, file = name + ".pdf" }));
        }
        catch (Exception e)
        {
            Program.Log("Print: " + e);
            try { _web.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "printed", id, ok = false, error = e.Message })); }
            catch { /* The page will time out and tell the user. */ }
        }
        finally
        {
            controller?.Close();
            if (htmlPath is not null) { try { File.Delete(htmlPath); } catch { /* Cleared at next start. */ } }
        }
    }

    private void SendPendingFiles()
    {
        if (!_pageReady || _env is null) return;
        while (_pendingFiles.Count > 0)
        {
            var path = _pendingFiles.Dequeue();
            try
            {
                // A real file handle, so the page reads only what it needs and can save back.
                var handle = _env.CreateWebFileSystemFileHandle(path, CoreWebView2FileSystemHandlePermission.ReadWrite);
                _web.CoreWebView2.PostWebMessageAsJson("{\"type\":\"open\"}", new List<object> { handle });
            }
            catch (Exception e)
            {
                Program.Log($"Open {path}: {e.Message}");
            }
        }
    }

    /// <summary>Lets the page ask about unsaved work before the window really closes.</summary>
    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        SaveBounds();
        if (_closeApproved || !_pageReady || _web.CoreWebView2 is null) return;
        e.Cancel = true;
        try { _web.CoreWebView2.PostWebMessageAsJson("{\"type\":\"close-request\"}"); }
        catch { _closeApproved = true; e.Cancel = false; }
    }

    private void Fatal(string message)
    {
        _pageReady = false;
        MessageBox.Show(this, message, "PDFy", MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }

    private sealed record WindowPlace(int X, int Y, int W, int H, bool Max);

    private static string BoundsFile => Path.Combine(Program.DataDir, "window.json");

    private void RestoreBounds_()
    {
        StartPosition = FormStartPosition.Manual;
        var area = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1280, 800);
        var fallback = new Rectangle(area.X + 40, area.Y + 30, Math.Min(1360, area.Width - 80), Math.Min(860, area.Height - 60));
        Bounds = fallback;
        try
        {
            if (!File.Exists(BoundsFile)) return;
            var b = JsonSerializer.Deserialize<WindowPlace>(File.ReadAllText(BoundsFile));
            if (b is null) return;
            var r = new Rectangle(b.X, b.Y, b.W, b.H);
            // A saved position might be on a monitor that is no longer attached.
            if (Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(r))) Bounds = r;
            if (b.Max) WindowState = FormWindowState.Maximized;
        }
        catch (Exception e)
        {
            Program.Log("Window position: " + e.Message);
        }
    }

    private void SaveBounds()
    {
        try
        {
            Directory.CreateDirectory(Program.DataDir);
            var r = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            File.WriteAllText(BoundsFile, JsonSerializer.Serialize(new WindowPlace(r.X, r.Y, r.Width, r.Height, WindowState == FormWindowState.Maximized)));
        }
        catch (Exception e)
        {
            Program.Log("Window position: " + e.Message);
        }
    }
}

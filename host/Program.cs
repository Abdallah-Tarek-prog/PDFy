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
        if (AppUpdater.TryApply(args)) return;
        ShellIdentity.SetProcess();
        if (args.FirstOrDefault() == "--repair-taskbar") { ShellIdentity.RepairShortcuts(); return; }
        // The last line of defence. A message box is better than a window that just vanishes.
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) => Log("UI thread: " + e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Log("Fatal: " + e.ExceptionObject);
        TaskScheduler.UnobservedTaskException += (_, e) => { Log("Task: " + e.Exception); e.SetObserved(); };

        // PDFy already open: give it the files, so they appear as tabs in that one window.
        if (!SingleInstance.TryBecomePrimary(args)) return;
        CrashLog.SessionStarted();

        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        if (Environment.GetEnvironmentVariable("PDFY_DEV") != "1")
        {
            try { ShellIdentity.RepairShortcuts(); }
            catch (Exception e) { Log("Taskbar shortcut: " + e.Message); }
        }
        Application.Run(new MainForm(args));
        SingleInstance.Release();
        CrashLog.SessionEnded();
    }

    internal static readonly string DataDir =
        Environment.GetEnvironmentVariable("PDFY_DEV") == "1" &&
        Environment.GetEnvironmentVariable("PDFY_TEST_DATA_DIR") is { Length: > 0 } testDataDir
            ? Path.GetFullPath(testDataDir)
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PDFy");

    internal static void Log(string message) => CrashLog.Write(message);
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
    private readonly HashSet<string> _knownFiles = LoadKnownFiles();
    private bool _pageReady;
    private bool _closeApproved;
    private readonly AppUpdater _updater;
    private bool _restartForUpdate;
    private bool _applyingUpdate;
    private readonly System.Windows.Forms.Timer _updateTimer = new() { Interval = 60 * 60 * 1000 };
    private int _restarts;
    private DateTime _lastRestart = DateTime.MinValue;
    private string _lastMemory = "none yet";
    private long _loggedMemoryStep;
    private bool _loggedLowMemory;
    private readonly System.Windows.Forms.Timer _memoryTimer = new() { Interval = 60_000 };

    public MainForm(string[] args)
    {
        Text = "Meletiq PDF";
        _updater = new AppUpdater(message => _web.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(message)));
        BackColor = HeaderColor;
        Icon = File.Exists(ShellIdentity.IconPath) ? new Icon(ShellIdentity.IconPath) : Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        MinimumSize = new Size(640, 420);
        Controls.Add(_web);
        RestoreBounds_();
        foreach (var a in args.Where(File.Exists).Select(Path.GetFullPath).OrderBy(p => p, Comparer<string>.Create(ByExplorerName)))
        {
            _pendingFiles.Enqueue(a);
        }
        Shown += async (_, _) =>
        {
            SingleInstance.Listen(paths => BeginInvoke(() => OpenFromOtherLaunch(paths)));
            await StartAsync();
        };
        FormClosing += OnFormClosing;
        Resize += (_, _) => TrimWhenMinimised();
        _memoryTimer.Tick += (_, _) => SampleMemory();
        _memoryTimer.Start();
        _updateTimer.Tick += (_, _) => { if (_pageReady) _ = _updater.CheckAsync(false); };
        if (Environment.GetEnvironmentVariable("PDFY_DEV") != "1") _updateTimer.Start();
    }

    /// <summary>
    /// Once a minute, a few milliseconds: how much memory PDFy uses. Kept for the next crash line, and
    /// written to the log only when it passes a new whole gigabyte or the computer runs low.
    /// </summary>
    private void SampleMemory()
    {
        try
        {
            var ids = _web.CoreWebView2?.Environment.GetProcessInfos().Select(p => p.ProcessId).ToArray() ?? [];
            var mb = CrashLog.ProcessMemoryMb(ids);
            var system = CrashLog.SystemMemory();
            _lastMemory = $"PDFy {mb:N0} MB in {ids.Length + 1} processes at {DateTime.Now:HH:mm}, {system}";
            var step = mb / 1024;
            if (step > _loggedMemoryStep)
            {
                _loggedMemoryStep = step;
                Program.Log("Memory high: " + _lastMemory);
            }
            var low = CrashLog.FreeMemoryPercent() is >= 0 and < 10;
            if (low && !_loggedLowMemory) Program.Log("Computer is low on memory: " + _lastMemory);
            _loggedLowMemory = low;
        }
        catch (Exception e)
        {
            _lastMemory = "reading failed: " + e.Message;
        }
    }

    private static string WebRoot => Path.Combine(AppContext.BaseDirectory, "web");

    private async Task StartAsync()
    {
        try
        {
            if (!File.Exists(Path.Combine(WebRoot, "index.html")))
            {
                Fatal("The app files are missing. Reinstall Meletiq PDF, or run the build again.");
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
            Fatal("Meletiq PDF needs the Microsoft Edge WebView2 Runtime, which is part of Windows 11.\n\nIt can be installed from Microsoft's website.");
        }
        catch (Exception e)
        {
            Program.Log("Start: " + e);
            Fatal("Meletiq PDF could not start: " + e.Message);
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
        // Deliver touchpad pinch input to the page, which zooms the PDF instead of the window UI.
        s.IsPinchZoomEnabled = true;
        s.IsStatusBarEnabled = false;
        s.IsGeneralAutofillEnabled = false;
        s.IsPasswordAutosaveEnabled = false;
        s.IsSwipeNavigationEnabled = false;
        s.AreDevToolsEnabled = Environment.GetEnvironmentVariable("PDFY_DEV") == "1";
        s.AreDefaultScriptDialogsEnabled = true;

        core.DocumentTitleChanged += (_, _) => Text = string.IsNullOrEmpty(core.DocumentTitle) ? "Meletiq PDF" : core.DocumentTitle;
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

    /// <summary>
    /// A minimised window hands back whatever memory the engine can spare. Not during the minimise
    /// animation, which still shows the page: two seconds later, if it is still minimised.
    /// </summary>
    private System.Windows.Forms.Timer? _trimTimer;

    private void TrimWhenMinimised()
    {
        if (_web.CoreWebView2 is null) return;
        if (WindowState != FormWindowState.Minimized)
        {
            _trimTimer?.Stop();
            SetMemoryLevel(CoreWebView2MemoryUsageTargetLevel.Normal);
            return;
        }
        if (_trimTimer is null)
        {
            _trimTimer = new System.Windows.Forms.Timer { Interval = 2000 };
            _trimTimer.Tick += (_, _) =>
            {
                _trimTimer.Stop();
                if (WindowState == FormWindowState.Minimized) SetMemoryLevel(CoreWebView2MemoryUsageTargetLevel.Low);
            };
        }
        _trimTimer.Stop();
        _trimTimer.Start();
    }

    private void SetMemoryLevel(CoreWebView2MemoryUsageTargetLevel level)
    {
        try
        {
            var core = _web.CoreWebView2;
            if (core is not null && core.MemoryUsageTargetLevel != level) core.MemoryUsageTargetLevel = level;
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
        string module = "", dump = "";
        try { if (!string.IsNullOrEmpty(e.FailureSourceModulePath)) module = $", in {Path.GetFileName(e.FailureSourceModulePath)}"; } catch { }
        if (CrashLog.NewestDump() is { } d) dump = $", newest dump {d}";
        Program.Log($"Engine failed: {e.ProcessFailedKind} {e.Reason} code 0x{e.ExitCode:X8} ({CrashLog.Explain(e.ExitCode)}){module}. " +
                    $"Last memory reading: {_lastMemory}. Now: {CrashLog.SystemMemory()}{dump}");
        if ((DateTime.Now - _lastRestart).TotalMinutes > 5) _restarts = 0;
        _lastRestart = DateTime.Now;
        if (++_restarts > MaxRestarts)
        {
            Fatal("The PDF engine keeps stopping. Your unsaved work is kept and will be offered next time Meletiq PDF starts.");
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
            Fatal("Meletiq PDF could not recover. Your unsaved work will be offered next time it starts.");
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
                    SampleMemory();
                    SendWindowState();
                    SendPendingFiles();
                    _updater.SendState();
                    if (Environment.GetEnvironmentVariable("PDFY_DEV") != "1") _ = _updater.CheckAsync(false);
                    break;
                case "update-state":
                    if (e.Source.StartsWith($"https://{Host}/", StringComparison.OrdinalIgnoreCase)) _updater.SendState();
                    break;
                case "update-check":
                    if (e.Source.StartsWith($"https://{Host}/", StringComparison.OrdinalIgnoreCase)) _ = _updater.CheckAsync(true);
                    break;
                case "update-enabled":
                    if (e.Source.StartsWith($"https://{Host}/", StringComparison.OrdinalIgnoreCase)) _updater.SetEnabled(doc.RootElement.GetProperty("enabled").GetBoolean());
                    break;
                case "update-install":
                    if (e.Source.StartsWith($"https://{Host}/", StringComparison.OrdinalIgnoreCase) && _updater.Ready)
                    { _restartForUpdate = true; Close(); }
                    break;
                case "close-cancel":
                    _restartForUpdate = false;
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
                case "file-location":
                    LocateFile(e, doc.RootElement);
                    break;
                case "file-picker":
                    RequestFilePicker(e, doc.RootElement.Clone());
                    break;
                case "file-access":
                    RenewFileAccess(e, doc.RootElement);
                    break;
                case "log":
                    // Errors inside the page. The page already limits how many it sends.
                    if (e.Source.StartsWith($"https://{Host}/", StringComparison.OrdinalIgnoreCase) &&
                        doc.RootElement.TryGetProperty("text", out var lt) && lt.GetString() is { Length: > 0 } text)
                        Program.Log("Page: " + CrashLog.Trim(text.ReplaceLineEndings(" | "), 3000));
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

    /// <summary>
    /// Where a dropped or pasted file lives on disk: its full path and a fresh handle to it. Only a real
    /// file passed over by PDFy's own page is used, never a path the page names. WebView2 passes over
    /// files only, not file handles, so files opened through PDFy's own file windows carry their path instead.
    /// </summary>
    private void LocateFile(CoreWebView2WebMessageReceivedEventArgs e, JsonElement message)
    {
        if (!e.Source.StartsWith($"https://{Host}/", StringComparison.OrdinalIgnoreCase)) return;
        var id = message.GetProperty("id").GetInt32();
        string? path = null, error = null;
        object? handle = null;
        try
        {
            path = e.AdditionalObjects is { Count: > 0 } objects && objects[0] is CoreWebView2File file ? file.Path : null;
            if (string.IsNullOrEmpty(path) || !Path.IsPathFullyQualified(path)) error = "unsupported";
            else if (!File.Exists(path)) error = "missing";
            else
            {
                handle = (_env ?? throw new InvalidOperationException("The engine is not ready.")).CreateWebFileSystemFileHandle(path, CoreWebView2FileSystemHandlePermission.ReadWrite);
                RememberKnownFile(path);
            }
        }
        catch (Exception ex)
        {
            Program.Log("Locate file: " + ex.Message);
            error = "failed";
            handle = null;
        }
        if (error is not null) path = null;
        try
        {
            var json = JsonSerializer.Serialize(new { type = "file-location", id, ok = error is null, path, error });
            if (handle is null) _web.CoreWebView2?.PostWebMessageAsJson(json);
            else _web.CoreWebView2?.PostWebMessageAsJson(json, new List<object> { handle });
        }
        catch (Exception ex)
        {
            Program.Log("Locate reply: " + ex.Message);
        }
    }

    private bool _pickerOpen;

    private static string KnownFilesPath => Path.Combine(Program.DataDir, "file-access.json");

    private static HashSet<string> LoadKnownFiles()
    {
        try { return new HashSet<string>(JsonSerializer.Deserialize<string[]>(File.ReadAllText(KnownFilesPath)) ?? [], StringComparer.OrdinalIgnoreCase); }
        catch { return new HashSet<string>(StringComparer.OrdinalIgnoreCase); }
    }

    private void RememberKnownFile(string path)
    {
        if (!_knownFiles.Add(Path.GetFullPath(path))) return;
        try
        {
            Directory.CreateDirectory(Program.DataDir);
            File.WriteAllText(KnownFilesPath + ".tmp", JsonSerializer.Serialize(_knownFiles));
            File.Move(KnownFilesPath + ".tmp", KnownFilesPath, true);
        }
        catch (Exception ex) { Program.Log("File access record: " + ex.Message); }
    }

    /// <summary>Refreshes a restored browser handle only for files the user already opened in PDFy.</summary>
    private void RenewFileAccess(CoreWebView2WebMessageReceivedEventArgs e, JsonElement message)
    {
        if (!e.Source.StartsWith($"https://{Host}/", StringComparison.OrdinalIgnoreCase)) return;
        var id = message.GetProperty("id").GetInt32();
        string? path = null, error = null;
        object? handle = null;
        try
        {
            path = Path.GetFullPath(message.GetProperty("path").GetString() ?? "");
            if (!_knownFiles.Contains(path)) error = "unsupported";
            else if (!File.Exists(path)) error = "missing";
            else handle = (_env ?? throw new InvalidOperationException("The engine is not ready.")).CreateWebFileSystemFileHandle(path, CoreWebView2FileSystemHandlePermission.ReadWrite);
        }
        catch (Exception ex) { Program.Log("File access renewal: " + ex.Message); error = "failed"; }
        var json = JsonSerializer.Serialize(new { type = "file-access", id, ok = error is null, path = error is null ? path : null, error });
        if (handle is null) _web.CoreWebView2?.PostWebMessageAsJson(json);
        else _web.CoreWebView2?.PostWebMessageAsJson(json, new List<object> { handle });
    }

    /// <summary>
    /// The page's Open and Save windows, shown as Windows' own so every chosen file comes back with its
    /// full path as well as its handle. Shown once this message has been handled, on the window's own
    /// thread and owned by it. One at a time; cancelling is reported as such.
    /// </summary>
    private void RequestFilePicker(CoreWebView2WebMessageReceivedEventArgs e, JsonElement message)
    {
        if (!e.Source.StartsWith($"https://{Host}/", StringComparison.OrdinalIgnoreCase)) return;
        var id = message.GetProperty("id").GetInt32();
        if (_pickerOpen)
        {
            ReplyFilePicker(id, null, "busy");
            return;
        }
        _pickerOpen = true;
        try
        {
            BeginInvoke(() =>
            {
                try { ShowFilePicker(id, message); }
                finally { _pickerOpen = false; }
            });
        }
        catch (Exception ex)
        {
            _pickerOpen = false;
            Program.Log("File window: " + ex.Message);
            ReplyFilePicker(id, null, "failed");
        }
    }

    private void ShowFilePicker(int id, JsonElement message)
    {
        string[]? paths = null;
        string? error = null;
        try
        {
            var save = message.TryGetProperty("kind", out var k) && k.ValueKind == JsonValueKind.String && k.GetString() == "save";
            using FileDialog dialog = save
                ? new SaveFileDialog { OverwritePrompt = true, AddExtension = true }
                : new OpenFileDialog { CheckFileExists = true, Multiselect = message.TryGetProperty("multiple", out var m) && m.ValueKind == JsonValueKind.True };
            dialog.CheckPathExists = true;
            dialog.ValidateNames = true;
            dialog.RestoreDirectory = true;
            var (filter, firstExtension) = PickerFilter(message);
            try { dialog.Filter = filter; }
            catch (ArgumentException) { dialog.Filter = "All files (*.*)|*.*"; }
            if (save && firstExtension is not null) dialog.DefaultExt = firstExtension[1..];
            if (PickerFileName(message) is { } name) dialog.FileName = name;
            if (dialog.ShowDialog(this) != DialogResult.OK) error = "cancelled";
            else
            {
                paths = save ? new[] { dialog.FileName } : ((OpenFileDialog)dialog).FileNames;
                if (paths.Length == 0 || paths.Any(p => !Path.IsPathFullyQualified(p))) error = "failed";
            }
        }
        catch (Exception ex)
        {
            Program.Log("File window: " + ex.Message);
            error = "failed";
        }
        ReplyFilePicker(id, error is null ? paths : null, error);
    }

    private void ReplyFilePicker(int id, string[]? paths, string? error)
    {
        var handles = new List<object>();
        try
        {
            if (paths is not null)
            {
                var env = _env ?? throw new InvalidOperationException("The engine is not ready.");
                // A file chosen in the Save window may not exist yet; its handle is still valid.
                foreach (var p in paths)
                {
                    handles.Add(env.CreateWebFileSystemFileHandle(p, CoreWebView2FileSystemHandlePermission.ReadWrite));
                    RememberKnownFile(p);
                }
            }
        }
        catch (Exception ex)
        {
            Program.Log("File window handles: " + ex.Message);
            error = "failed";
            paths = null;
            handles.Clear();
        }
        try
        {
            var json = JsonSerializer.Serialize(new { type = "file-picker", id, ok = error is null, paths, error });
            if (handles.Count == 0) _web.CoreWebView2?.PostWebMessageAsJson(json);
            else _web.CoreWebView2?.PostWebMessageAsJson(json, handles);
        }
        catch (Exception ex)
        {
            Program.Log("File window reply: " + ex.Message);
        }
    }

    /// <summary>The page's file types as a Windows filter. Anything malformed is left out, never passed on.</summary>
    private static (string Filter, string? FirstExtension) PickerFilter(JsonElement message)
    {
        var parts = new List<string>();
        string? first = null;
        if (message.TryGetProperty("types", out var types) && types.ValueKind == JsonValueKind.Array)
        {
            foreach (var t in types.EnumerateArray().Take(20))
            {
                if (t.ValueKind != JsonValueKind.Object || !t.TryGetProperty("extensions", out var list) || list.ValueKind != JsonValueKind.Array) continue;
                var extensions = list.EnumerateArray()
                    .Where(x => x.ValueKind == JsonValueKind.String)
                    .Select(x => x.GetString() ?? "")
                    .Where(IsExtension)
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .Take(30)
                    .ToList();
                if (extensions.Count == 0) continue;
                first ??= extensions[0];
                var patterns = string.Join(";", extensions.Select(x => "*" + x));
                var label = t.TryGetProperty("description", out var d) && d.ValueKind == JsonValueKind.String
                    ? new string((d.GetString() ?? "").Where(c => c != '|' && !char.IsControl(c)).Take(100).ToArray()).Trim()
                    : "";
                parts.Add($"{(label.Length > 0 ? label : "Files")} ({patterns})|{patterns}");
            }
        }
        var acceptAll = !(message.TryGetProperty("acceptAll", out var a) && a.ValueKind == JsonValueKind.False);
        if (acceptAll || parts.Count == 0) parts.Add("All files (*.*)|*.*");
        return (string.Join("|", parts), first);
    }

    private static bool IsExtension(string x) =>
        x.Length is >= 2 and <= 17 && x[0] == '.' && x.Skip(1).All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '+' or '-');

    /// <summary>The suggested name, reduced to a plain file name; nothing that could point elsewhere.</summary>
    private static string? PickerFileName(JsonElement message)
    {
        if (!message.TryGetProperty("suggestedName", out var s) || s.ValueKind != JsonValueKind.String) return null;
        var invalid = Path.GetInvalidFileNameChars();
        var name = new string((s.GetString() ?? "").Where(c => !invalid.Contains(c)).Take(200).ToArray()).Trim().TrimEnd('.', ' ');
        return name.Length > 0 ? name : null;
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
                // A real file handle, so the page reads only what it needs and can save back, and its
                // path, which the page cannot learn from a handle.
                var handle = _env.CreateWebFileSystemFileHandle(path, CoreWebView2FileSystemHandlePermission.ReadWrite);
                RememberKnownFile(path);
                _web.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "open", path }), new List<object> { handle });
            }
            catch (Exception e)
            {
                Program.Log($"Open {path}: {e.Message}");
            }
        }
    }

    /// <summary>A file opened from Explorer while PDFy was already running: a new tab, window to the front.</summary>
    private void OpenFromOtherLaunch(string[] paths)
    {
        foreach (var p in paths)
        {
            if (Path.IsPathFullyQualified(p) && File.Exists(p)) _arriving.Add(Path.GetFullPath(p));
        }
        if (IsIconic(Handle)) ShowWindow(Handle, 9 /* SW_RESTORE: back to maximised if it was */);
        SetForegroundWindow(Handle);
        Activate();
        // Several files opened together in Explorer arrive one launch each, in no set order. Wait a
        // moment for the rest, then open them A–Z.
        _arrivalTimer.Stop();
        _arrivalTimer.Start();
    }

    private readonly List<string> _arriving = new();
    private System.Windows.Forms.Timer? _arrivalTimerField;
    private System.Windows.Forms.Timer _arrivalTimer => _arrivalTimerField ??= MakeArrivalTimer();

    private System.Windows.Forms.Timer MakeArrivalTimer()
    {
        var t = new System.Windows.Forms.Timer { Interval = 350 };
        t.Tick += (_, _) =>
        {
            t.Stop();
            _arriving.Sort(ByExplorerName);
            foreach (var p in _arriving.Distinct(StringComparer.OrdinalIgnoreCase)) _pendingFiles.Enqueue(p);
            _arriving.Clear();
            SendPendingFiles();
        };
        return t;
    }

    /// <summary>Explorer's own name order: "Part 2" before "Part 10".</summary>
    internal static int ByExplorerName(string a, string b) => StrCmpLogicalW(Path.GetFileName(a), Path.GetFileName(b));

    [System.Runtime.InteropServices.DllImport("shlwapi.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private static extern int StrCmpLogicalW(string a, string b);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hwnd);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hwnd, int command);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hwnd);

    /// <summary>Lets the page ask about unsaved work before the window really closes.</summary>
    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        SaveBounds();
        if (_closeApproved || !_pageReady || _web.CoreWebView2 is null)
        {
            if (_updater.Ready && !_applyingUpdate)
            {
                try { _updater.ApplyAfterExit(_restartForUpdate); _applyingUpdate = true; }
                catch (Exception ex) { Program.Log("Starting update: " + ex.Message); }
            }
            SingleInstance.StopAccepting();
            return;
        }
        e.Cancel = true;
        try { _web.CoreWebView2.PostWebMessageAsJson("{\"type\":\"close-request\"}"); }
        catch { _closeApproved = true; e.Cancel = false; }
    }

    private void Fatal(string message)
    {
        Program.Log("Shown to the user: " + message.ReplaceLineEndings(" "));
        _pageReady = false;
        MessageBox.Show(this, message, "Meletiq PDF", MessageBoxButtons.OK, MessageBoxIcon.Warning);
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

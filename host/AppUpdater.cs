using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;

namespace PDFy;

internal sealed class AppUpdater(Action<object> notify)
{
    internal const string Repository = "Abdallah-Tarek-prog/PDFy";
    internal const string AssetName = "Meletiq-PDF-win-x64.zip";
    private const long MaxDownload = 64 * 1024 * 1024;
    private static readonly HttpClient Client = CreateClient();
    private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };
    private readonly string _settingsPath = Path.Combine(Program.DataDir, "updates.json");
    private Preferences _preferences = LoadPreferences();
    private bool _busy;
    private string _phase = "idle";
    private string _message = "Updates are checked automatically.";
    private string? _latest;
    private string? _payload;
    internal static string CurrentVersion => typeof(Program).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";
    internal bool Ready => _payload is not null;
    private sealed record Preferences(bool Enabled = true, DateTime LastCheckUtc = default);

    private static HttpClient CreateClient()
    {
        var client = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("Meletiq-PDF/" + CurrentVersion);
        return client;
    }

    private static Preferences LoadPreferences()
    {
        try { return JsonSerializer.Deserialize<Preferences>(File.ReadAllText(Path.Combine(Program.DataDir, "updates.json")), Json) ?? new(); }
        catch { return new(); }
    }

    private void SavePreferences()
    {
        Directory.CreateDirectory(Program.DataDir);
        File.WriteAllText(_settingsPath, JsonSerializer.Serialize(_preferences));
    }

    internal void SendState() => notify(new { type = "app-update", phase = _phase,
        message = _phase == "idle" && !_preferences.Enabled ? "Automatic updates are off. You can still check manually." : _message,
        enabled = _preferences.Enabled, currentVersion = CurrentVersion, latestVersion = _latest });

    internal void SetEnabled(bool enabled)
    {
        _preferences = _preferences with { Enabled = enabled };
        SavePreferences(); SendState();
        if (enabled) _ = CheckAsync(false);
    }

    private void Status(string phase, string message)
    {
        _phase = phase; _message = message; SendState();
    }

    internal async Task CheckAsync(bool manual)
    {
        if (_busy || Ready) { SendState(); return; }
        if (!manual && (!_preferences.Enabled || DateTime.UtcNow - _preferences.LastCheckUtc < TimeSpan.FromHours(6))) { SendState(); return; }
        _busy = true;
        try
        {
            Status("checking", "Checking for updates…");
            using var request = new HttpRequestMessage(HttpMethod.Get, $"https://api.github.com/repos/{Repository}/releases/latest");
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            using var response = await Client.SendAsync(request, timeout.Token);
            if (response.StatusCode == HttpStatusCode.NotFound)
            {
                _preferences = _preferences with { LastCheckUtc = DateTime.UtcNow }; SavePreferences();
                Status("idle", "No published updates yet."); return;
            }
            response.EnsureSuccessStatusCode();
            var metadata = await response.Content.ReadAsByteArrayAsync(timeout.Token);
            if (metadata.Length > 1024 * 1024) throw new InvalidDataException("Release metadata is too large.");
            using var doc = JsonDocument.Parse(metadata);
            var release = doc.RootElement;
            if (release.GetProperty("draft").GetBoolean() || release.GetProperty("prerelease").GetBoolean())
                throw new InvalidDataException("The update is not a stable release.");
            var tag = release.GetProperty("tag_name").GetString() ?? "";
            var version = UpdatePackage.ParseVersion(tag);
            _preferences = _preferences with { LastCheckUtc = DateTime.UtcNow }; SavePreferences();
            if (version <= UpdatePackage.ParseVersion(CurrentVersion)) { Status("idle", "You’re up to date."); return; }
            var asset = release.GetProperty("assets").EnumerateArray().FirstOrDefault(a => a.GetProperty("name").GetString() == AssetName);
            if (asset.ValueKind != JsonValueKind.Object) throw new InvalidDataException("This release has no Windows update package.");
            var size = asset.GetProperty("size").GetInt64();
            var digest = asset.GetProperty("digest").GetString() ?? "";
            if (size is <= 0 or > MaxDownload || !digest.StartsWith("sha256:") || digest.Length != 71 || !digest[7..].All(Uri.IsHexDigit))
                throw new InvalidDataException("The update checksum or size is invalid.");
            _latest = version.ToString(3);
            Status("downloading", $"Downloading version {_latest}…");
            var cache = Path.Combine(Program.DataDir, "updates");
            Directory.CreateDirectory(cache);
            var work = Path.Combine(cache, Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(work);
            try
            {
                var zip = Path.Combine(work, "update.zip");
                var assetId = asset.GetProperty("id").GetInt64();
                using var download = new HttpRequestMessage(HttpMethod.Get, $"https://api.github.com/repos/{Repository}/releases/assets/{assetId}");
                download.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
                using var result = await Client.SendAsync(download, HttpCompletionOption.ResponseHeadersRead);
                result.EnsureSuccessStatusCode();
                await using (var input = await result.Content.ReadAsStreamAsync())
                await using (var output = File.Create(zip))
                {
                    var buffer = new byte[81920]; long total = 0; int read;
                    while ((read = await input.ReadAsync(buffer)) > 0)
                    {
                        total += read;
                        if (total > size || total > MaxDownload) throw new InvalidDataException("The update download is too large.");
                        await output.WriteAsync(buffer.AsMemory(0, read));
                    }
                    if (total != size) throw new InvalidDataException("The update download is incomplete.");
                }
                using (var stream = File.OpenRead(zip))
                    if (!Convert.ToHexString(SHA256.HashData(stream)).Equals(digest[7..], StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("The downloaded update failed verification.");
                var payload = Path.Combine(work, "payload");
                await Task.Run(() => UpdatePackage.Extract(zip, payload, version));
                File.Delete(zip);
                _payload = payload;
                Status("ready", $"Version {_latest} is ready. It installs when you close the app, or restart now.");
            }
            catch { Directory.Delete(work, true); throw; }
        }
        catch (Exception e)
        {
            Program.Log("Update: " + e.Message);
            Status("error", "Could not check or download updates. Check your connection and try again.");
        }
        finally { _busy = false; }
    }

    // Called only after the normal unsaved-document close flow has approved closing.
    internal void ApplyAfterExit(bool restart)
    {
        if (_payload is null) return;
        UpdatePackage.Validate(_payload);
        var work = Path.GetDirectoryName(_payload)!;
        var helper = Path.Combine(work, "apply.exe");
        File.Copy(Application.ExecutablePath, helper, true);
        var start = new ProcessStartInfo(helper) { UseShellExecute = false, CreateNoWindow = true };
        foreach (var arg in new[] { "--apply-update", Environment.ProcessId.ToString(), AppContext.BaseDirectory, _payload, restart ? "restart" : "close" }) start.ArgumentList.Add(arg);
        _ = Process.Start(start) ?? throw new IOException("The update helper could not start.");
        _payload = null;
    }

    internal static bool TryApply(string[] args)
    {
        if (args.FirstOrDefault() != "--apply-update") return false;
        try
        {
            if (args.Length != 5 || !int.TryParse(args[1], out var pid)) throw new InvalidDataException("Invalid update request.");
            var payload = Path.GetFullPath(args[3]);
            if (payload != Path.Combine(AppContext.BaseDirectory, "payload")) throw new InvalidDataException("Invalid staged update path.");
            try { using var parent = Process.GetProcessById(pid); if (!parent.WaitForExit(120_000)) throw new IOException("The app is still open. The update was not installed."); }
            catch (ArgumentException) { /* Already exited. */ }
            UpdatePackage.Install(payload, args[2]);
            var exe = Path.Combine(args[2], "PDFy.exe");
            if (args[4] == "restart") Process.Start(new ProcessStartInfo(exe) { UseShellExecute = false, WorkingDirectory = args[2] });
            else Process.Start(new ProcessStartInfo(exe, "--repair-taskbar") { UseShellExecute = false, CreateNoWindow = true });
            Directory.Delete(payload, true);
        }
        catch (Exception e)
        {
            Program.Log("Install update: " + e);
            MessageBox.Show("The update could not be installed. Your documents are unchanged.\n\n" + e.Message, "Meletiq PDF update", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        return true;
    }
}

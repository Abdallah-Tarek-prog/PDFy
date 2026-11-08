using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;

namespace PDFy;

internal static class UpdatePackage
{
    internal static readonly string[] Roots = ["PDFy.exe", "Meletiq.ico", "WebView2Loader.dll", "runtimes", "web", "release.json"];
    private const long MaxExpandedBytes = 128 * 1024 * 1024;
    internal sealed record Manifest(string Version, Dictionary<string, string> Files);
    private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };

    internal static Version ParseVersion(string text)
    {
        if (!Version.TryParse(text.TrimStart('v'), out var version) || version.Major < 0 || version.Build < 0)
            throw new InvalidDataException("The release version is invalid.");
        return version;
    }

    private static string SafePath(string root, string relative)
    {
        var parts = relative.Replace('\\', '/').Split('/');
        if (parts.Any(p => p is "" or "." or ".." || p.Contains(':')) || !Roots.Contains(parts[0], StringComparer.OrdinalIgnoreCase))
            throw new InvalidDataException("The update contains an unexpected path.");
        var path = Path.GetFullPath(Path.Combine(root, Path.Combine(parts)));
        if (!path.StartsWith(Path.GetFullPath(root) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("The update path is outside its folder.");
        return path;
    }

    internal static void Extract(string zipPath, string destination, Version expected)
    {
        Directory.CreateDirectory(destination);
        using var zip = ZipFile.OpenRead(zipPath);
        long expanded = 0;
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in zip.Entries)
        {
            if (entry.FullName.EndsWith('/')) continue;
            expanded += entry.Length;
            if (expanded > MaxExpandedBytes || seen.Count >= 2000 || !seen.Add(entry.FullName.Replace('\\', '/')) ||
                ((entry.ExternalAttributes >> 16) & 0xF000) == 0xA000)
                throw new InvalidDataException("The update archive is invalid or too large.");
            var file = SafePath(destination, entry.FullName);
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            entry.ExtractToFile(file);
        }
        Validate(destination, expected);
    }

    internal static Manifest Validate(string payload, Version? expected = null)
    {
        var manifestPath = Path.Combine(payload, "release.json");
        if (!File.Exists(manifestPath) || new FileInfo(manifestPath).Length > 512 * 1024)
            throw new InvalidDataException("The release manifest is missing or too large.");
        var manifest = JsonSerializer.Deserialize<Manifest>(File.ReadAllText(manifestPath), Json)
            ?? throw new InvalidDataException("The release manifest is invalid.");
        var version = ParseVersion(manifest.Version);
        if (expected is not null && version != expected) throw new InvalidDataException("Release versions do not match.");
        if (manifest.Files is null || manifest.Files.Count is < 5 or > 2000 ||
            !manifest.Files.ContainsKey("PDFy.exe") || !manifest.Files.ContainsKey("web/index.html") ||
            !manifest.Files.ContainsKey("web/app.js") || !manifest.Files.ContainsKey("Meletiq.ico") || !manifest.Files.ContainsKey("WebView2Loader.dll"))
            throw new InvalidDataException("Required app files are missing.");
        var actual = Directory.GetFiles(payload, "*", SearchOption.AllDirectories);
        if (actual.Length != manifest.Files.Count + 1) throw new InvalidDataException("Unexpected app files in the update.");
        long size = 0;
        foreach (var (relative, hash) in manifest.Files)
        {
            var path = SafePath(payload, relative);
            if (!File.Exists(path) || (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("An update file is missing or linked.");
            size += new FileInfo(path).Length;
            if (size > MaxExpandedBytes) throw new InvalidDataException("The update is too large.");
            using var stream = File.OpenRead(path);
            if (!Convert.ToHexString(SHA256.HashData(stream)).Equals(hash, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("An update file failed verification.");
        }
        foreach (var directory in Directory.GetDirectories(payload, "*", SearchOption.AllDirectories))
            if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("Linked update folder.");
        return manifest;
    }

    // Build a complete replacement beside the installation before moving any installed files.
    // The backup and replacement are on the same volume, so each directory rename is atomic.
    internal static void Install(string payload, string installation)
    {
        var manifest = Validate(payload);
        installation = Path.GetFullPath(installation);
        if (!Directory.Exists(installation) || (File.GetAttributes(installation) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException("The app installation folder is invalid.");
        var replacement = Path.Combine(installation, ".update-" + Guid.NewGuid().ToString("N"));
        var backup = Path.Combine(installation, ".previous-release");
        var saved = new List<string>();
        var placed = new List<string>();
        try
        {
            Directory.CreateDirectory(replacement);
            foreach (var relative in manifest.Files.Keys.Append("release.json"))
            {
                var target = SafePath(replacement, relative);
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                File.Copy(SafePath(payload, relative), target);
            }
            Validate(replacement, ParseVersion(manifest.Version));
            if (Directory.Exists(backup))
            {
                if ((File.GetAttributes(backup) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("Linked backup folder.");
                Directory.Delete(backup, true);
            }
            Directory.CreateDirectory(backup);
            foreach (var name in Roots)
            {
                var target = Path.Combine(installation, name);
                if (File.Exists(target) || Directory.Exists(target))
                {
                    if ((File.GetAttributes(target) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("Linked installed app file.");
                    Move(target, Path.Combine(backup, name)); saved.Add(name);
                }
                var source = Path.Combine(replacement, name);
                if (File.Exists(source) || Directory.Exists(source)) { Move(source, target); placed.Add(name); }
            }
        }
        catch
        {
            foreach (var name in placed.AsEnumerable().Reverse()) Delete(Path.Combine(installation, name));
            foreach (var name in saved.AsEnumerable().Reverse()) Move(Path.Combine(backup, name), Path.Combine(installation, name));
            throw;
        }
        finally { if (Directory.Exists(replacement)) Directory.Delete(replacement, true); }
    }

    private static void Move(string source, string target)
    {
        if (Directory.Exists(source)) Directory.Move(source, target); else File.Move(source, target);
    }
    private static void Delete(string path)
    {
        if (Directory.Exists(path)) Directory.Delete(path, true); else File.Delete(path);
    }
}

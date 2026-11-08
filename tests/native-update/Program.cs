using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using PDFy;

var root = Path.Combine(Path.GetTempPath(), "meletiq-update-tests-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
var passed = 0;
void Check(bool value, string message) { if (!value) throw new Exception(message); }
void Reject(Action run) { try { run(); } catch (InvalidDataException) { return; } throw new Exception("An invalid update was accepted"); }
void Test(string name, Action run) { run(); passed++; Console.WriteLine("ok " + name); }
string Payload(string name)
{
    var path = Path.Combine(root, name); Directory.CreateDirectory(Path.Combine(path, "web"));
    foreach (var file in new[] { "PDFy.exe", "Meletiq.ico", "WebView2Loader.dll", "web/index.html", "web/app.js" })
        File.WriteAllText(Path.Combine(path, file), "new " + file);
    var files = Directory.GetFiles(path, "*", SearchOption.AllDirectories).ToDictionary(
        file => Path.GetRelativePath(path, file).Replace('\\', '/'), file => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file))));
    File.WriteAllText(Path.Combine(path, "release.json"), JsonSerializer.Serialize(new { version = "0.2.0", files }));
    return path;
}
try
{
    Test("stable version ordering rejects incomplete and prerelease tags", () => {
        Check(UpdatePackage.ParseVersion("v0.2.0") > UpdatePackage.ParseVersion("0.1.0"), "Wrong version ordering");
        Reject(() => UpdatePackage.ParseVersion("v0.2")); Reject(() => UpdatePackage.ParseVersion("v0.2.0-beta"));
    });
    Test("valid release extracts and verifies every file", () => {
        var payload = Payload("valid"); var zip = Path.Combine(root, "valid.zip"); ZipFile.CreateFromDirectory(payload, zip);
        UpdatePackage.Extract(zip, Path.Combine(root, "extracted"), new Version(0,2,0));
        Check(File.ReadAllText(Path.Combine(root, "extracted/web/app.js")) == "new web/app.js", "File missing");
    });
    Test("wrong release version and tampered files are rejected", () => {
        var payload = Payload("tampered"); Reject(() => UpdatePackage.Validate(payload, new Version(0,3,0)));
        File.AppendAllText(Path.Combine(payload, "web/app.js"), "changed"); Reject(() => UpdatePackage.Validate(payload));
    });
    Test("zip traversal cannot write outside the stage", () => {
        var zip = Path.Combine(root, "traversal.zip");
        using (var archive = ZipFile.Open(zip, ZipArchiveMode.Create)) { using var writer = new StreamWriter(archive.CreateEntry("../escaped.txt").Open()); writer.Write("bad"); }
        Reject(() => UpdatePackage.Extract(zip, Path.Combine(root, "traversal"), new Version(0,2,0)));
        Check(!File.Exists(Path.Combine(root, "escaped.txt")), "Path escaped");
    });
    Test("symlinks and duplicate Windows paths are rejected", () => {
        foreach (var linked in new[] { true, false }) {
            var zip = Path.Combine(root, linked ? "linked.zip" : "duplicate.zip");
            using (var archive = ZipFile.Open(zip, ZipArchiveMode.Create)) {
                var entry = archive.CreateEntry("web/app.js"); if (linked) entry.ExternalAttributes = unchecked((int)0xA0000000);
                using (var writer = new StreamWriter(entry.Open())) writer.Write("bad");
                if (!linked) { using var writer = new StreamWriter(archive.CreateEntry("WEB/APP.JS").Open()); writer.Write("bad"); }
            }
            Reject(() => UpdatePackage.Extract(zip, Path.Combine(root, linked ? "links" : "duplicates"), new Version(0,2,0)));
        }
    });
    Test("successful update keeps documents and the previous release", () => {
        var target = Path.Combine(root, "installed"); Directory.CreateDirectory(target);
        File.WriteAllText(Path.Combine(target, "PDFy.exe"), "old exe"); File.WriteAllText(Path.Combine(target, "notes.pdf"), "owner document");
        UpdatePackage.Install(Payload("install"), target);
        Check(File.ReadAllText(Path.Combine(target, "PDFy.exe")) == "new PDFy.exe", "New exe not installed");
        Check(File.ReadAllText(Path.Combine(target, ".previous-release/PDFy.exe")) == "old exe", "Backup missing");
        Check(File.ReadAllText(Path.Combine(target, "notes.pdf")) == "owner document", "Document changed");
    });
    Test("a locked installed file rolls back files already replaced", () => {
        var target = Path.Combine(root, "locked"); Directory.CreateDirectory(target);
        File.WriteAllText(Path.Combine(target, "PDFy.exe"), "old exe"); File.WriteAllText(Path.Combine(target, "Meletiq.ico"), "old icon");
        using var locked = new FileStream(Path.Combine(target, "Meletiq.ico"), FileMode.Open, FileAccess.Read, FileShare.Read);
        try { UpdatePackage.Install(Payload("rollback"), target); throw new Exception("Locked file was unexpectedly replaced"); }
        catch (IOException) { }
        Check(File.ReadAllText(Path.Combine(target, "PDFy.exe")) == "old exe", "Previous exe was not restored");
        Check(!File.Exists(Path.Combine(target, "web/app.js")), "Partial new release remained");
    });
    Console.WriteLine($"Passed {passed} native update checks.");
}
finally { Directory.Delete(root, true); }

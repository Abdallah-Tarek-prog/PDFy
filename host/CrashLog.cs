// PDFy's crash log, in %LOCALAPPDATA%\PDFy\pdfy.log. It records every kind of failure: errors in the
// window, errors in the page, engine crashes with the memory in use at the time, starts that fail,
// and sessions that ended without closing normally. Nothing is kept in memory; each line goes
// straight to disk. Disk use stays under about 1 MB of log (current + one older file), and the
// engine's own crash dumps are kept to the newest few.

using System.Diagnostics;
using System.Diagnostics.Eventing.Reader;
using System.Runtime.InteropServices;

namespace PDFy;

internal static class CrashLog
{
    private const long MaxLogBytes = 512 * 1024;
    private const int KeepDumps = 4;
    private static readonly object Gate = new();

    private static string LogPath => Path.Combine(Program.DataDir, "pdfy.log");
    private static string OldLogPath => Path.Combine(Program.DataDir, "pdfy.old.log");
    private static string MarkerPath => Path.Combine(Program.DataDir, "session.open");

    public static void Write(string message)
    {
        lock (Gate)
        {
            try
            {
                Directory.CreateDirectory(Program.DataDir);
                // When full, the log moves aside instead of being wiped, so the lines just before a crash survive.
                var info = new FileInfo(LogPath);
                if (info.Exists && info.Length > MaxLogBytes) File.Move(LogPath, OldLogPath, overwrite: true);
                File.AppendAllText(LogPath, $"{DateTime.Now:s} {message}{Environment.NewLine}");
            }
            catch
            {
                // Logging must never be the thing that fails.
            }
        }
    }

    /// <summary>Called once at start: notes the session, and reports if the last one ended badly.</summary>
    public static void SessionStarted()
    {
        try
        {
            var version = typeof(CrashLog).Assembly.GetName().Version;
            string? lastStart = File.Exists(MarkerPath) ? File.ReadAllText(MarkerPath).Trim() : null;
            File.WriteAllText(MarkerPath, DateTime.Now.ToString("s"));
            Write($"Started PDFy {version}, Windows {Environment.OSVersion.Version}, {SystemMemory()}");
            if (lastStart is not null)
            {
                Write($"The last session (started {lastStart}) ended without closing normally: a crash, or Windows ended it.");
                var since = DateTime.TryParse(lastStart, out var t) ? t : DateTime.Now.AddDays(-1);
                // Windows keeps a note of hard crashes that PDFy itself cannot catch. Read it off the UI thread.
                new Thread(() => ReportWindowsCrashNotes(since)) { IsBackground = true, Priority = ThreadPriority.BelowNormal }.Start();
            }
            new Thread(PruneDumps) { IsBackground = true, Priority = ThreadPriority.BelowNormal }.Start();
        }
        catch (Exception e)
        {
            Write("Session start note: " + e.Message);
        }
    }

    public static void SessionEnded()
    {
        Write("Closed normally.");
        try { File.Delete(MarkerPath); } catch { /* Next start just reports one false alarm. */ }
    }

    /// <summary>What an engine exit code means, in plain words.</summary>
    public static string Explain(int code) => unchecked((uint)code) switch
    {
        0x80000003 => "the engine stopped itself on an internal check (a bug or a limit it hit, sometimes memory)",
        0xE0000008 or 0xC0000017 or 0x8007000E => "out of memory",
        0xC0000005 => "access violation (a bug in the engine or a plug-in)",
        0xC0000409 => "fail-fast stop (the engine detected corrupted state)",
        0xC00000FD => "stack overflow (very deep recursion, often a malformed file)",
        0xC0000374 => "memory corruption detected",
        0x1 or 0x0 => "normal exit code",
        _ => "unknown code",
    };

    /// <summary>Free and total memory on the computer, for every crash line.</summary>
    public static string SystemMemory()
    {
        var m = new MemoryStatus { Length = (uint)Marshal.SizeOf<MemoryStatus>() };
        if (!GlobalMemoryStatusEx(ref m)) return "memory unknown";
        return $"computer memory {m.AvailPhys / 1048576:N0} MB free of {m.TotalPhys / 1048576:N0} MB";
    }

    /// <summary>Percent of the computer's memory still free, or -1 if unknown.</summary>
    public static int FreeMemoryPercent()
    {
        var m = new MemoryStatus { Length = (uint)Marshal.SizeOf<MemoryStatus>() };
        return GlobalMemoryStatusEx(ref m) ? 100 - (int)m.MemoryLoad : -1;
    }

    /// <summary>The newest engine crash dump, so a log line can point at it.</summary>
    public static string? NewestDump()
    {
        try
        {
            var dir = new DirectoryInfo(Path.Combine(Program.DataDir, "engine", "EBWebView", "Crashpad", "reports"));
            if (!dir.Exists) return null;
            return dir.GetFiles("*.dmp").OrderByDescending(f => f.LastWriteTimeUtc).FirstOrDefault()?.Name;
        }
        catch { return null; }
    }

    // Each engine crash leaves a dump of about 6.5 MB, and the engine never removes them.
    private static void PruneDumps()
    {
        try
        {
            var dir = new DirectoryInfo(Path.Combine(Program.DataDir, "engine", "EBWebView", "Crashpad", "reports"));
            if (!dir.Exists) return;
            foreach (var old in dir.GetFiles("*.dmp").OrderByDescending(f => f.LastWriteTimeUtc).Skip(KeepDumps))
            {
                try { old.Delete(); } catch { /* In use; next start. */ }
            }
        }
        catch (Exception e)
        {
            Write("Dump cleanup: " + e.Message);
        }
    }

    private static void ReportWindowsCrashNotes(DateTime since)
    {
        try
        {
            var ms = Math.Max(0, (long)(DateTime.Now - since).TotalMilliseconds) + 60_000;
            // "Application Error" (1000) and ".NET Runtime" (1026) are Windows' own notes of a hard crash.
            var query = new EventLogQuery("Application", PathType.LogName,
                $"*[System[(EventID=1000 or EventID=1026) and TimeCreated[timediff(@SystemTime) <= {ms}]]]");
            using var reader = new EventLogReader(query);
            var found = 0;
            for (var record = reader.ReadEvent(); record is not null && found < 5; record = reader.ReadEvent())
            {
                using (record)
                {
                    var text = record.FormatDescription() ?? "";
                    if (!text.Contains("PDFy.exe", StringComparison.OrdinalIgnoreCase)) continue;
                    found++;
                    var brief = string.Join(" | ", text.Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0).Take(8));
                    Write($"Windows crash note ({record.TimeCreated:s}): {Trim(brief, 1500)}");
                }
            }
            if (found == 0) Write("Windows has no crash note for PDFy in that time, so it was probably ended by Windows, a shutdown, or Task Manager.");
        }
        catch (Exception e)
        {
            Write("Could not read Windows' crash notes: " + e.Message);
        }
    }

    public static string Trim(string text, int max) => text.Length <= max ? text : text[..max] + "…";

    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryStatus
    {
        public uint Length, MemoryLoad;
        public ulong TotalPhys, AvailPhys, TotalPageFile, AvailPageFile, TotalVirtual, AvailVirtual, AvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalMemoryStatusEx(ref MemoryStatus status);

    /// <summary>Memory used by PDFy itself plus its engine processes, in MB.</summary>
    public static long ProcessMemoryMb(IEnumerable<int> engineProcessIds)
    {
        long bytes = 0;
        using (var self = Process.GetCurrentProcess()) bytes += self.PrivateMemorySize64;
        foreach (var id in engineProcessIds)
        {
            try { using var p = Process.GetProcessById(id); bytes += p.PrivateMemorySize64; }
            catch { /* Already gone. */ }
        }
        return bytes / 1048576;
    }
}

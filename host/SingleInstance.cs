// One PDFy window per user. Opening a PDF from Explorer while PDFy is already running hands the
// file to the open window, which shows it in a new tab, and the second launch quits at once.

using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace PDFy;

internal static class SingleInstance
{
    private const int MaxMessage = 256 * 1024;
    private static Mutex? _mutex;
    private static volatile bool _accepting = true;

    // Keyed by the data folder, so a test copy with its own data folder never takes over the user's window.
    private static readonly string Key = Convert.ToHexString(
        SHA256.HashData(Encoding.UTF8.GetBytes(Program.DataDir.ToLowerInvariant())))[..16];
    private static string PipeName => "PDFy-open-" + Key;

    /// <summary>
    /// True when this launch should open the window. False when the files were handed to the window
    /// that is already open. Waits up to 10 seconds for a window that is still starting or closing;
    /// after that it opens its own window rather than lose the file.
    /// </summary>
    public static bool TryBecomePrimary(IEnumerable<string> files)
    {
        var paths = files.Where(File.Exists).Select(Path.GetFullPath).ToArray();
        _mutex = new Mutex(false, @"Local\PDFy-" + Key);
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (true)
        {
            try { if (_mutex.WaitOne(0)) return true; }
            catch (AbandonedMutexException) { return true; } // The previous window crashed.
            if (TrySend(paths)) return false;
            if (DateTime.UtcNow > deadline)
            {
                Program.Log("Hand-off: the open window did not answer, opening a second one.");
                return true;
            }
            Thread.Sleep(150);
        }
    }

    private static bool TrySend(string[] paths)
    {
        try
        {
            using var pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut, PipeOptions.CurrentUserOnly);
            pipe.Connect(500);
            // This launch came from the user's click, so it may let the open window come to the front.
            AllowSetForegroundWindow(-1);
            var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(paths) + "\n");
            pipe.Write(bytes);
            pipe.Flush();
            return pipe.ReadByte() == 1; // The window confirms it took the files.
        }
        catch (Exception e) when (e is TimeoutException or IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    /// <summary>Listens for later launches and passes their files to the window on its own thread.</summary>
    public static void Listen(Action<string[]> onFiles)
    {
        var thread = new Thread(() =>
        {
            while (_accepting)
            {
                try
                {
                    using var pipe = new NamedPipeServerStream(PipeName, PipeDirection.InOut, 1,
                        PipeTransmissionMode.Byte, PipeOptions.CurrentUserOnly);
                    pipe.WaitForConnection();
                    var text = ReadLine(pipe);
                    var paths = JsonSerializer.Deserialize<string[]>(text) ?? [];
                    if (!_accepting) continue; // Closing: no answer, so the other launch tries again.
                    onFiles(paths);
                    pipe.WriteByte(1);
                    pipe.Flush();
                }
                catch (Exception e)
                {
                    Program.Log("Hand-off listen: " + e.Message);
                    Thread.Sleep(200);
                }
            }
        }) { IsBackground = true, Name = "PDFy hand-off" };
        thread.Start();
    }

    private static string ReadLine(Stream pipe)
    {
        var buffer = new MemoryStream();
        int b;
        while ((b = pipe.ReadByte()) is not (-1 or '\n'))
        {
            buffer.WriteByte((byte)b);
            if (buffer.Length > MaxMessage) throw new InvalidDataException("Hand-off message too large.");
        }
        return Encoding.UTF8.GetString(buffer.ToArray());
    }

    /// <summary>The window is closing for good: later launches open their own window.</summary>
    public static void StopAccepting() => _accepting = false;

    public static void Release()
    {
        _accepting = false;
        try { _mutex?.ReleaseMutex(); } catch { /* Not held, or already released. */ }
    }

    [DllImport("user32.dll")]
    private static extern bool AllowSetForegroundWindow(int processId);
}

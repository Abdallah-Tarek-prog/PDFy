using System.Runtime.InteropServices;

namespace PDFy;

internal static class ShellIdentity
{
    internal const string AppId = "Meletiq.PDF";
    internal static string IconPath => Path.Combine(AppContext.BaseDirectory, "Meletiq.ico");
    private static readonly Guid PropertySet = new("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");

    internal static void SetProcess() => Marshal.ThrowExceptionForHR(SetCurrentProcessExplicitAppUserModelID(AppId));

    // Update this app's links only. A separate ICO path avoids Explorer's old executable-icon cache.
    internal static void RepairShortcuts()
    {
        if (!File.Exists(IconPath)) return;
        var exe = Application.ExecutablePath;
        var programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
        var pinned = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar");
        var links = new List<string> { Path.Combine(programs, "Meletiq PDF.lnk") };
        if (Directory.Exists(pinned)) links.AddRange(Directory.GetFiles(pinned, "*.lnk"));
        dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell")!)!;
        try
        {
            foreach (var path in links)
            {
                dynamic link = shell.CreateShortcut(path);
                try
                {
                    if (File.Exists(path) && !string.Equals((string)link.TargetPath, exe, StringComparison.OrdinalIgnoreCase)) continue;
                    link.TargetPath = exe;
                    link.WorkingDirectory = AppContext.BaseDirectory;
                    link.Description = "Meletiq PDF - PDF editor and study workspace";
                    link.IconLocation = IconPath + ",0";
                    link.Save();
                }
                finally { Marshal.FinalReleaseComObject(link); }
                var iid = typeof(IPropertyStore).GUID;
                Marshal.ThrowExceptionForHR(SHGetPropertyStoreFromParsingName(path, IntPtr.Zero, 2, ref iid, out var store));
                try { Set(store, 5, AppId); store.Commit(); }
                finally { Marshal.FinalReleaseComObject(store); }
                var name = Marshal.StringToCoTaskMemUni(path);
                try { SHChangeNotify(0x2000, 5, name, IntPtr.Zero); } // SHCNE_UPDATEITEM, SHCNF_PATHW
                finally { Marshal.FreeCoTaskMem(name); }
            }
        }
        finally { Marshal.FinalReleaseComObject(shell); }
        SHChangeNotify(0x08000000, 0x1000, IntPtr.Zero, IntPtr.Zero);
    }

    private static void Set(IPropertyStore store, uint id, string text)
    {
        var key = new PropertyKey { Format = PropertySet, Id = id };
        var value = new PropVariant { Type = 31, Pointer = Marshal.StringToCoTaskMemUni(text) };
        try { store.SetValue(ref key, ref value); }
        finally { Marshal.FreeCoTaskMem(value.Pointer); }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PropertyKey { public Guid Format; public uint Id; }
    [StructLayout(LayoutKind.Explicit, Size = 24)]
    private struct PropVariant { [FieldOffset(0)] public ushort Type; [FieldOffset(8)] public IntPtr Pointer; }
    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        void GetCount(out uint count);
        void GetAt(uint index, out PropertyKey key);
        void GetValue(ref PropertyKey key, out PropVariant value);
        void SetValue(ref PropertyKey key, ref PropVariant value);
        void Commit();
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SetCurrentProcessExplicitAppUserModelID(string id);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHGetPropertyStoreFromParsingName(string path, IntPtr bind, uint flags, ref Guid iid, out IPropertyStore store);
    [DllImport("shell32.dll")]
    private static extern void SHChangeNotify(uint eventId, uint flags, IntPtr first, IntPtr second);
}

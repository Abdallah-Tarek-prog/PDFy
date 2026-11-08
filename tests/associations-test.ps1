# Query the same Windows handlers used by Open with, without opening a document or changing defaults.
param([switch]$RequirePdfy)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
namespace PDFyAssociationTest {
    [ComImport, Guid("f04061ac-1659-4a3f-a954-775aa57fc083"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAssocHandler {
        void GetName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        void GetUIName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        void GetIconLocation([MarshalAs(UnmanagedType.LPWStr)] out string path, out int index);
        [PreserveSig] int IsRecommended();
    }
    [ComImport, Guid("973810ae-9599-4b88-9e4d-6ee98c9552da"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IEnumAssocHandlers {
        [PreserveSig] int Next(uint count, out IAssocHandler handler, out uint fetched);
    }
    public class Handler { public string Name; public string Path; public bool Recommended; }
    public static class Shell {
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
        static extern void SHAssocEnumHandlers(string extension, uint filter, out IEnumAssocHandlers handlers);
        public static Handler[] Handlers() {
            IEnumAssocHandlers handlers;
            SHAssocEnumHandlers(".pdf", 0, out handlers);
            var result = new List<Handler>();
            try {
                IAssocHandler handler; uint fetched;
                while (handlers.Next(1, out handler, out fetched) == 0 && fetched == 1) {
                    try {
                        string name, path; handler.GetUIName(out name); handler.GetName(out path);
                        result.Add(new Handler { Name = name, Path = path, Recommended = handler.IsRecommended() == 0 });
                    } finally { Marshal.ReleaseComObject(handler); }
                }
            } finally { Marshal.ReleaseComObject(handlers); }
            return result.ToArray();
        }
    }
}
'@
$handlers = [PDFyAssociationTest.Shell]::Handlers()
$handlers | ConvertTo-Json -Compress
if ($RequirePdfy -and -not ($handlers | Where-Object { $_.Name -eq 'Meletiq PDF' -and $_.Recommended -and $_.Path -eq (Join-Path (Split-Path $PSScriptRoot) 'app\PDFy.exe') })) {
    throw 'Windows does not recommend the installed Meletiq PDF executable for Open with.'
}

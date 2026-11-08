# Removes what install.ps1 added. Your files and the PDFy folder are not touched.

Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Meletiq PDF.lnk" -ErrorAction SilentlyContinue
Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\PDFy.lnk" -ErrorAction SilentlyContinue
Remove-Item 'HKCU:\Software\Classes\PDFy.Document' -Recurse -ErrorAction SilentlyContinue
Remove-Item 'HKCU:\Software\Classes\Applications\PDFy.exe' -Recurse -ErrorAction SilentlyContinue
Remove-ItemProperty -Path 'HKCU:\Software\Classes\.pdf\OpenWithProgids' -Name 'PDFy.Document' -ErrorAction SilentlyContinue
Remove-Item 'HKCU:\Software\PDFy\Capabilities' -Recurse -ErrorAction SilentlyContinue
Remove-ItemProperty -Path 'HKCU:\Software\RegisteredApplications' -Name 'PDFy' -ErrorAction SilentlyContinue
Remove-ItemProperty -Path 'HKCU:\Software\RegisteredApplications' -Name 'Meletiq PDF' -ErrorAction SilentlyContinue
Remove-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\PDFy.exe' -Recurse -ErrorAction SilentlyContinue
$openWith = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.pdf\OpenWithList'
if (Test-Path $openWith) {
    $list = Get-Item -LiteralPath $openWith
    $mru = [string]$list.GetValue('MRUList')
    foreach ($slot in $list.GetValueNames()) {
        if ($slot -cmatch '^[a-z]$' -and $list.GetValue($slot) -ieq 'PDFy.exe') {
            Remove-ItemProperty -Path $openWith -Name $slot
            $mru = $mru.Replace($slot, '')
        }
    }
    Set-ItemProperty -Path $openWith -Name 'MRUList' -Value $mru
}

if (-not ('PDFyShell.Associations' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace PDFyShell {
    public static class Associations {
        [DllImport("shell32.dll")]
        public static extern void SHChangeNotify(uint eventId, uint flags, IntPtr item1, IntPtr item2);
    }
}
'@
}
[PDFyShell.Associations]::SHChangeNotify(0x08000000, 0x1000, [IntPtr]::Zero, [IntPtr]::Zero)

Write-Host 'Meletiq PDF was removed from the Start menu and from "Open with".'

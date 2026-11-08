# Adds Meletiq PDF to the Start menu and to "Open with" for PDF files, for this Windows user only.
# No administrator rights needed. Windows still asks you to choose the default PDF app yourself.
# Undo with uninstall.ps1.

param([switch]$OpenWithOnly)

$ErrorActionPreference = 'Stop'
$exe = (Resolve-Path (Join-Path $PSScriptRoot '..\app\PDFy.exe')).Path

if (-not $OpenWithOnly) {
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Meletiq PDF.lnk")
    $link.TargetPath = $exe
    $link.WorkingDirectory = Split-Path $exe
    $link.Description = 'Meletiq PDF - PDF editor and study workspace'
    $link.IconLocation = "$exe,0"
    $link.Save()
    $legacyShortcut = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\PDFy.lnk"
    if (Test-Path -LiteralPath $legacyShortcut) {
        $legacyLink = $shell.CreateShortcut($legacyShortcut)
        if ($legacyLink.TargetPath -ieq $exe) { Remove-Item -LiteralPath $legacyShortcut }
    }
}

$classes = 'HKCU:\Software\Classes'
New-Item -Path "$classes\PDFy.Document\DefaultIcon" -Force | Out-Null
Set-ItemProperty -Path "$classes\PDFy.Document" -Name '(default)' -Value 'PDF document'
Set-ItemProperty -Path "$classes\PDFy.Document\DefaultIcon" -Name '(default)' -Value "`"$exe`",0"
New-Item -Path "$classes\PDFy.Document\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "$classes\PDFy.Document\shell\open\command" -Name '(default)' -Value "`"$exe`" `"%1`""

# Identify the executable and supported extension for the Open with menu and dialog.
$application = "$classes\Applications\PDFy.exe"
New-Item -Path "$application\SupportedTypes" -Force | Out-Null
Set-ItemProperty -Path $application -Name 'FriendlyAppName' -Value 'Meletiq PDF'
New-ItemProperty -Path "$application\SupportedTypes" -Name '.pdf' -Value '' -PropertyType String -Force | Out-Null
New-Item -Path "$application\DefaultIcon" -Force | Out-Null
Set-ItemProperty -Path "$application\DefaultIcon" -Name '(default)' -Value "`"$exe`",0"
New-Item -Path "$application\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "$application\shell\open\command" -Name '(default)' -Value "`"$exe`" `"%1`""
# Only created if missing: on an existing key, New-Item -Force would erase the other apps listed there.
if (-not (Test-Path "$classes\.pdf\OpenWithProgids")) { New-Item -Path "$classes\.pdf\OpenWithProgids" | Out-Null }
New-ItemProperty -Path "$classes\.pdf\OpenWithProgids" -Name 'PDFy.Document' -Value '' -PropertyType String -Force | Out-Null

# Register with the current Windows app picker and Default apps settings as well.
$capabilities = 'HKCU:\Software\PDFy\Capabilities'
New-Item -Path "$capabilities\FileAssociations" -Force | Out-Null
Set-ItemProperty -Path $capabilities -Name 'ApplicationName' -Value 'Meletiq PDF'
Set-ItemProperty -Path $capabilities -Name 'ApplicationDescription' -Value 'PDF editor and study workspace'
Set-ItemProperty -Path $capabilities -Name 'ApplicationIcon' -Value "`"$exe`",0"
Set-ItemProperty -Path "$capabilities\FileAssociations" -Name '.pdf' -Value 'PDFy.Document'
if (-not (Test-Path 'HKCU:\Software\RegisteredApplications')) { New-Item -Path 'HKCU:\Software\RegisteredApplications' | Out-Null }
Set-ItemProperty -Path 'HKCU:\Software\RegisteredApplications' -Name 'Meletiq PDF' -Value 'Software\PDFy\Capabilities'
$legacyRegistration = (Get-Item -LiteralPath 'HKCU:\Software\RegisteredApplications').GetValue('PDFy')
if ($legacyRegistration -eq 'Software\PDFy\Capabilities') {
    Remove-ItemProperty -Path 'HKCU:\Software\RegisteredApplications' -Name 'PDFy'
}
$appPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\PDFy.exe'
New-Item -Path $appPath -Force | Out-Null
Set-ItemProperty -Path $appPath -Name '(default)' -Value $exe

# Explorer's short Open with submenu prioritises recently used apps. Preserve the other entries.
$openWith = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.pdf\OpenWithList'
if (-not (Test-Path $openWith)) { New-Item -Path $openWith | Out-Null }
$list = Get-Item -LiteralPath $openWith
$letters = @($list.GetValueNames() | Where-Object { $_ -cmatch '^[a-z]$' })
$slot = $letters | Where-Object { $list.GetValue($_) -ieq 'PDFy.exe' } | Select-Object -First 1
if (-not $slot) { $slot = [char[]]'abcdefghijklmnopqrstuvwxyz' | ForEach-Object { [string]$_ } | Where-Object { $_ -notin $letters } | Select-Object -First 1 }
if ($slot) {
    Set-ItemProperty -Path $openWith -Name $slot -Value 'PDFy.exe'
    Set-ItemProperty -Path $openWith -Name 'MRUList' -Value ($slot + ([string]$list.GetValue('MRUList')).Replace($slot, ''))
}

# Tell Explorer that file associations changed; no restart or default-app change is needed.
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

if ($OpenWithOnly) { Write-Host 'Meletiq PDF is registered in "Open with" for PDF files.' }
else { Write-Host 'Meletiq PDF is in the Start menu and in "Open with" for PDF files.' }

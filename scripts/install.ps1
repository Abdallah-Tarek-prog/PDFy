# Adds PDFy to the Start menu and to "Open with" for PDF files, for this Windows user only.
# No administrator rights needed. Windows still asks you to choose the default PDF app yourself.
# Undo with uninstall.ps1.

$exe = (Resolve-Path (Join-Path $PSScriptRoot '..\app\PDFy.exe')).Path

$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\PDFy.lnk")
$link.TargetPath = $exe
$link.WorkingDirectory = Split-Path $exe
$link.Description = 'PDFy PDF editor'
$link.Save()

$classes = 'HKCU:\Software\Classes'
New-Item -Path "$classes\PDFy.Document\DefaultIcon" -Force | Out-Null
Set-ItemProperty -Path "$classes\PDFy.Document" -Name '(default)' -Value 'PDF document'
Set-ItemProperty -Path "$classes\PDFy.Document\DefaultIcon" -Name '(default)' -Value "`"$exe`",0"
New-Item -Path "$classes\PDFy.Document\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "$classes\PDFy.Document\shell\open\command" -Name '(default)' -Value "`"$exe`" `"%1`""
# Only created if missing: on an existing key, New-Item -Force would erase the other apps listed there.
if (-not (Test-Path "$classes\.pdf\OpenWithProgids")) { New-Item -Path "$classes\.pdf\OpenWithProgids" | Out-Null }
New-ItemProperty -Path "$classes\.pdf\OpenWithProgids" -Name 'PDFy.Document' -Value '' -PropertyType String -Force | Out-Null

Write-Host 'PDFy is in the Start menu and in "Open with" for PDF files.'

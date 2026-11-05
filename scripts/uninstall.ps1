# Removes what install.ps1 added. Your files and the PDFy folder are not touched.

Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\PDFy.lnk" -ErrorAction SilentlyContinue
Remove-Item 'HKCU:\Software\Classes\PDFy.Document' -Recurse -ErrorAction SilentlyContinue
Remove-ItemProperty -Path 'HKCU:\Software\Classes\.pdf\OpenWithProgids' -Name 'PDFy.Document' -ErrorAction SilentlyContinue

Write-Host 'PDFy was removed from the Start menu and from "Open with".'

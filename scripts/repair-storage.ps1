# Back up the incomplete IndexedDB folder that prevents collections and history from saving.
# Healthy databases and document files are never changed.
param([string]$DataDir = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PDFy'))
$ErrorActionPreference = 'Stop'
$dataRoot = [IO.Path]::GetFullPath($DataDir)
$database = [IO.Path]::GetFullPath((Join-Path $dataRoot 'engine\EBWebView\Default\IndexedDB\https_pdfy.local_0.indexeddb.leveldb'))
if (-not $database.StartsWith($dataRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected database path.' }
$current = Join-Path $database 'CURRENT'
if (-not (Test-Path -LiteralPath $current)) { Write-Output 'No incomplete database found.'; return }
$manifest = [IO.File]::ReadAllText($current).Trim()
if ($manifest -notmatch '^MANIFEST-\d+$') { throw 'The database needs a separate recovery; nothing was changed.' }
if (Test-Path -LiteralPath (Join-Path $database $manifest)) { Write-Output 'The database manifest is present; nothing was changed.'; return }
if (Test-Path -LiteralPath ($database -replace '\.leveldb$', '.blob')) { throw 'The database has stored assets that need a separate recovery; nothing was changed.' }
$unexpected = @(Get-ChildItem -LiteralPath $database -Force | Where-Object { $_.Name -notin @('CURRENT', 'LOCK', 'LOG', 'LOG.old') })
if ($unexpected.Count) { throw 'The database contains data that needs a separate recovery; nothing was changed.' }
$backupRoot = Join-Path $dataRoot 'storage-backups'
$backup = [IO.Path]::GetFullPath((Join-Path $backupRoot ('incomplete-indexeddb-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))))
if (-not $backup.StartsWith($dataRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected backup path.' }
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
Move-Item -LiteralPath $database -Destination $backup
Write-Output "The incomplete database was backed up to $backup. Collections and history can now save again."

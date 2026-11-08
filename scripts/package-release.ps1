# Builds the exact archive consumed by the app's GitHub Releases updater.
param([switch]$Publish)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $repoRoot
try {
    $version = (Get-Content package.json -Raw | ConvertFrom-Json).version
    $hostVersion = ([xml](Get-Content host/PDFy.Host.csproj -Raw)).Project.PropertyGroup.Version
    if ($version -ne $hostVersion) { throw 'App and host versions must match.' }
    $out = Join-Path $repoRoot "tests\output\release-$version"
    $payload = Join-Path $out 'payload'
    $native = Join-Path $out 'native'
    foreach ($target in @($payload, $native)) {
        $resolved = [IO.Path]::GetFullPath($target)
        if (!$resolved.StartsWith($repoRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Output outside workspace' }
        if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
    }
    New-Item -ItemType Directory -Path $payload -Force | Out-Null
    npm run build
    if ($LASTEXITCODE) { throw 'Web build failed' }
    dotnet publish host/PDFy.Host.csproj -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -p:DebugType=none -o $native
    if ($LASTEXITCODE) { throw 'Windows build failed' }
    foreach ($name in @('PDFy.exe','Meletiq.ico','WebView2Loader.dll','runtimes')) {
        Copy-Item -LiteralPath (Join-Path $native $name) -Destination $payload -Recurse
    }
    Copy-Item -LiteralPath (Join-Path $repoRoot 'dist') -Destination (Join-Path $payload 'web') -Recurse
    $files = [ordered]@{}
    foreach ($file in Get-ChildItem -LiteralPath $payload -File -Recurse | Sort-Object FullName) {
        $relative = $file.FullName.Substring($payload.Length + 1).Replace('\','/')
        $files[$relative] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    @{ version = $version; files = $files } | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $payload 'release.json') -Encoding utf8
    $zip = Join-Path $out 'Meletiq-PDF-win-x64.zip'
    Compress-Archive -Path (Join-Path $payload '*') -DestinationPath $zip -Force
    $size = (Get-Item -LiteralPath $zip).Length
    Write-Host "Release v${version}: $([math]::Round($size/1MB,1)) MB, $($files.Count) verified app files"
    if ($Publish) {
        $commit = (git rev-parse HEAD).Trim()
        if ($LASTEXITCODE) { throw 'Could not read the release commit' }
        gh release create "v$version" $zip --repo Abdallah-Tarek-prog/PDFy --target $commit --title "Meletiq PDF $version" --generate-notes --latest
        if ($LASTEXITCODE) { throw 'Release publication failed' }
    }
} finally { Pop-Location }

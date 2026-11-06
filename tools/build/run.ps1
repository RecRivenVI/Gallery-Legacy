param(
    [Parameter(Mandatory = $true)][string]$Output,
    [switch]$DebugBuild,
    [switch]$Portable,
    [string]$InstanceConfig
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$localFile = Join-Path $PSScriptRoot 'paths.local.json'
$local = if (Test-Path -LiteralPath $localFile) { Get-Content -Raw -LiteralPath $localFile | ConvertFrom-Json } else { @{} }
$outputRoot = [IO.Path]::GetFullPath($Output)
if ($outputRoot.StartsWith($repo + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or $outputRoot -eq $repo) { throw 'Build output must be outside the repository' }
if (Test-Path -LiteralPath $outputRoot) {
    $entries = @(Get-ChildItem -LiteralPath $outputRoot -Force)
    $configuredInstance = if ($InstanceConfig) { [IO.Path]::GetFullPath($InstanceConfig) } else { '' }
    $instancePrefix = (Join-Path $outputRoot 'Instance') + [IO.Path]::DirectorySeparatorChar
    if ($entries.Count -ne 1 -or $entries[0].Name -ne 'Instance' -or !$entries[0].PSIsContainer -or !$configuredInstance.StartsWith($instancePrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Choose a new build output directory, or one containing only its configured Instance' }
}
if (!$local.resources -or !(Test-Path -LiteralPath (Join-Path $local.resources 'misans/manifest.json')) -or !$local.miSansCdn) { throw 'Provide licensed fonts and an official MiSans cache in tools/build/paths.local.json' }
if (!$local.libvipsCache) { throw 'Provide an external libvipsCache in tools/build/paths.local.json' }
$vipsSdk = & (Join-Path $repo 'tools/media/acquire.ps1') -Output $local.libvipsCache
& node (Join-Path $repo 'tools/fonts/acquire.mjs') --output $local.miSansCdn
if ($LASTEXITCODE -ne 0) { throw 'Official MiSans cache verification failed' }
$fontLockFile = Join-Path $repo 'tools/fonts/misans.lock.json'
$fontLock = Get-Content -LiteralPath $fontLockFile -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
$build = if ($local.buildRoot) { [IO.Path]::GetFullPath($local.buildRoot) } else { Join-Path $outputRoot 'Build' }
if ($build.StartsWith($repo + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or $build -eq $repo) { throw 'Build cache must be outside the repository' }
$product = Join-Path $outputRoot 'Gallery'
New-Item -ItemType Directory -Path $build, $product -Force | Out-Null
if ($local.javaHome) { $env:JAVA_HOME = $local.javaHome }
foreach ($pair in @(@('GOCACHE', 'goCache'), @('GOMODCACHE', 'moduleCache'))) {
    $value = $local.($pair[1])
    if ($value) { [Environment]::SetEnvironmentVariable($pair[0], $value, 'Process') }
}
$go = if ($local.go) { $local.go } else { 'go' }
Push-Location $repo
try {
    & $go generate ./api
    if ($LASTEXITCODE -ne 0) { throw 'API generation failed' }
} finally { Pop-Location }
$gradle = if ($local.gradle) { $local.gradle } else { Join-Path $repo 'ui/gradlew.bat' }
Push-Location (Join-Path $repo 'ui')
try {
    & $gradle "-PgalleryBuildRoot=$build" --console=plain formatKotlin wasmJsBrowserDistribution
    if ($LASTEXITCODE -ne 0) { throw 'Compose build failed' }
} finally { Pop-Location }
$frontend = Join-Path $build 'ui/dist/wasmJs/productionExecutable'
Add-Type -AssemblyName Microsoft.VisualBasic.Core
$retiredLatin = Join-Path $frontend 'misans_latin.woff2'
if (Test-Path -LiteralPath $retiredLatin) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($retiredLatin,'OnlyErrorDialogs','SendToRecycleBin') }
$staging = [IO.Path]::GetFullPath((Join-Path $repo 'internal/webui/assets'))
if ($staging -ne (Join-Path $repo 'internal/webui/assets')) { throw 'Unexpected embed staging root' }
$keep = Get-Content -LiteralPath (Join-Path $staging '.keep') -Raw
Add-Type -AssemblyName Microsoft.VisualBasic.Core
if (@(Get-ChildItem -LiteralPath $staging -Force | Where-Object Name -ne '.keep').Count -gt 0) {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($staging,'OnlyErrorDialogs','SendToRecycleBin')
    New-Item -ItemType Directory -Path $staging | Out-Null
    [IO.File]::WriteAllText((Join-Path $staging '.keep'),$keep,[Text.UTF8Encoding]::new($false))
}
Get-ChildItem -LiteralPath $frontend -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $staging -Recurse }
$resources = Join-Path $product 'resources'
New-Item -ItemType Directory -Path (Join-Path $resources 'fonts'), (Join-Path $resources 'misans/files'), (Join-Path $resources 'misans-cdn') -Force | Out-Null
foreach ($name in @('index.css') + @($fontLock.files.name)) {
    Copy-Item -LiteralPath (Join-Path $local.miSansCdn $name) -Destination (Join-Path $resources "misans-cdn/$name")
}
Copy-Item -LiteralPath $fontLockFile -Destination (Join-Path $resources 'misans-cdn/SHA256.json')
$manifest = Get-Content -LiteralPath (Join-Path $local.resources 'misans/manifest.json') -Raw | ConvertFrom-Json
$families = @($manifest.families | Where-Object { $_.key -notin @('misans','misanslatin','misansl3','misanstc') })
foreach ($family in $families) {
    $family.files = @($family.files | Where-Object { $_.name -match 'VF.*\.ttf$' } | Select-Object -First 1)
    foreach ($file in $family.files) {
        $name = ($file.url -split '/')[-1]
        Copy-Item -LiteralPath (Join-Path $local.resources "misans/files/$name") -Destination (Join-Path $resources "misans/files/$name")
    }
}
@{source=$manifest.source;families=$families;latin=@($fontLock.latin)} | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $resources 'misans/manifest.json') -Encoding utf8
Copy-Item -LiteralPath (Join-Path $local.resources 'misans/official-license.pdf') -Destination (Join-Path $resources 'misans/official-license.pdf')
Copy-Item -LiteralPath (Join-Path $local.resources 'fonts/noto-color-emoji.ttf') -Destination (Join-Path $resources 'fonts/noto-color-emoji.ttf')
New-Item -ItemType Directory -Path (Join-Path $resources 'licenses') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $resources 'libvips'), (Join-Path $resources 'licenses/libvips') -Force | Out-Null
Get-ChildItem -LiteralPath (Join-Path $vipsSdk 'bin') -Filter '*.dll' | Where-Object Name -ne 'libvips-cpp-42.dll' | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $resources 'libvips') }
foreach ($name in @('LICENSE','README.md','versions.json')) { Copy-Item -LiteralPath (Join-Path $vipsSdk $name) -Destination (Join-Path $resources 'licenses/libvips') }
Copy-Item -LiteralPath (Join-Path $repo 'tools/media/libvips.lock.json') -Destination (Join-Path $resources 'licenses/libvips/source.json')
foreach($notice in (Get-Content -LiteralPath (Join-Path $repo 'tools/media/libvips.lock.json') -Raw | ConvertFrom-Json).notices) { Copy-Item -LiteralPath (Join-Path $local.libvipsCache "Notices/$($notice.name)") -Destination (Join-Path $resources 'licenses/libvips') }
$thumbHashModule = (& $go env GOMODCACHE).Trim()
$thumbHashVersion = [regex]::Match((Get-Content -LiteralPath (Join-Path $repo 'go.mod') -Raw),'(?m)^\s*go\.n16f\.net/thumbhash\s+(\S+)').Groups[1].Value
Copy-Item -LiteralPath (Join-Path $thumbHashModule "go.n16f.net/thumbhash@$thumbHashVersion/LICENSE") -Destination (Join-Path $resources 'licenses/ThumbHash-ISC.txt')
foreach ($name in @('CanvasKit-LICENSE.txt', 'NotoColorEmoji-OFL.txt')) {
    Copy-Item -LiteralPath (Join-Path $local.resources "licenses/$name") -Destination (Join-Path $resources "licenses/$name")
}
Copy-Item -LiteralPath (Join-Path $repo 'third_party/miuix_webfont/LICENSE') -Destination (Join-Path $resources 'licenses/miuix-webfont-Apache-2.0.txt')
Copy-Item -LiteralPath (Join-Path $repo 'ui/src/wasmJsMain/resources/fluent-icons.LICENSE') -Destination (Join-Path $resources 'licenses/Fluent-System-Icons-MIT.txt')
$version = [regex]::Match((Get-Content -LiteralPath (Join-Path $repo 'src-tauri/Cargo.toml') -Raw),'(?m)^version\s*=\s*"([^"]+)"').Groups[1].Value
if (!$version) { throw 'Cargo product version missing' }
Push-Location $repo
try {
    & $go build -buildvcs=false "-ldflags=-X main.version=$version" -o (Join-Path $product 'gallery-runtime.exe') ./cmd/gallery-runtime
    if ($LASTEXITCODE -ne 0) { throw 'Go build failed' }
    & node tools/icons/build.mjs $build
    if ($LASTEXITCODE -ne 0) { throw 'Icon build failed' }
    $env:CARGO_TARGET_DIR = Join-Path $build 'cargo'
    $env:GALLERY_ICON = Join-Path $build 'app-icon.ico'
    $env:GALLERY_TRAY_ICON = Join-Path $build 'app-icon.png'
    $frontendRelative = [IO.Path]::GetRelativePath((Join-Path $repo 'src-tauri'), $frontend)
    $env:TAURI_CONFIG = @{ build = @{ frontendDist = $frontendRelative } } | ConvertTo-Json -Compress
    $arguments = @('build', '--locked', '--manifest-path', 'src-tauri/Cargo.toml')
    if (!$DebugBuild) { $arguments += '--release' }
    & cargo @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Tauri build failed' }
    $profile = if ($DebugBuild) { 'debug' } else { 'release' }
    Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR "$profile/Gallery.exe") -Destination (Join-Path $product 'Gallery.exe')
    foreach ($file in @('LICENSE','NOTICE')) { Copy-Item -LiteralPath (Join-Path $repo $file) -Destination (Join-Path $product $file) }
    if ($InstanceConfig) {
        $file = (Resolve-Path -LiteralPath $InstanceConfig).Path
        @{configPath=[IO.Path]::GetRelativePath($product,$file).Replace('\','/')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $product 'gallery.instance.json') -Encoding utf8
    }
    if ($Portable) {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [IO.Compression.ZipFile]::CreateFromDirectory($product,(Join-Path $outputRoot "Gallery_${version}_x64_portable.zip"),[IO.Compression.CompressionLevel]::Optimal,$true)
    }
    Write-Output "Build ready: $product"
} finally { Pop-Location }

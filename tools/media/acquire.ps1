param([Parameter(Mandatory = $true)][string]$Output)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$destination = [IO.Path]::GetFullPath($Output)
if ($destination -eq $repo -or $destination.StartsWith($repo + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Native dependencies must stay outside the repository' }
$lock = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'libvips.lock.json') -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Path $destination -Force | Out-Null
$archive = Join-Path $destination ([uri]$lock.url).Segments[-1]
if (!(Test-Path -LiteralPath $archive)) { Invoke-WebRequest -Uri $lock.url -OutFile $archive }
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $lock.sha256) { throw 'Official libvips archive hash mismatch' }
$sdk = Join-Path $destination ('SDK/' + $lock.directory)
if (!(Test-Path -LiteralPath (Join-Path $sdk 'bin/libvips-42.dll'))) { Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $destination 'SDK') }
$notices=Join-Path $destination 'Notices'
New-Item -ItemType Directory -Path $notices -Force | Out-Null
foreach($notice in $lock.notices) {
    $file=Join-Path $notices $notice.name
    if(!(Test-Path -LiteralPath $file)) {
        $data=Invoke-WebRequest -Uri $notice.url
        if($notice.encoding -eq 'base64') { [IO.File]::WriteAllBytes($file,[Convert]::FromBase64String($data.Content)) }
        else { [IO.File]::WriteAllText($file,$data.Content,[Text.UTF8Encoding]::new($false)) }
    }
    if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $notice.sha256) {throw "Dependency notice changed: $($notice.name)"}
}
Write-Output $sdk

param(
    [Parameter(Mandatory = $true)][string]$Product,
    [Parameter(Mandatory = $true)][string]$Config
)
$ErrorActionPreference = 'Stop'
$executable = Join-Path ([IO.Path]::GetFullPath($Product)) 'Gallery.exe'
$configFile = (Resolve-Path -LiteralPath $Config).Path
Start-Process -FilePath $executable -ArgumentList @('--config', ('"' + $configFile + '"')) -WorkingDirectory (Split-Path -Parent $executable) -WindowStyle Hidden

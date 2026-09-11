# _docker-bun.ps1 -- quote-safe Bun script transport for Windows PowerShell.

function Get-ContainerArchonMountSource {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Docker,
    [Parameter(Mandatory = $true)][string]$ContainerName
  )

  $inspectRaw = (& $Docker inspect $ContainerName 2>$null | Out-String)
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($inspectRaw)) {
    throw "container /.archon mount source is unavailable: $ContainerName"
  }

  try {
    $inspect = $inspectRaw | ConvertFrom-Json
    $mount = @($inspect[0].Mounts | Where-Object { $_.Destination -eq "/.archon" })[0]
  } catch {
    throw "container inspect output is invalid: $ContainerName"
  }
  if ($null -eq $mount -or [string]::IsNullOrWhiteSpace($mount.Source)) {
    throw "container /.archon mount source is unavailable: $ContainerName"
  }

  $resolved = Resolve-Path -LiteralPath $mount.Source -ErrorAction Stop
  return $resolved.Path
}

function Invoke-BunScriptInContainer {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Docker,
    [Parameter(Mandatory = $true)][string]$ContainerName,
    [Parameter(Mandatory = $true)][string]$Script,
    [string[]]$DockerExecOptions = @()
  )

  if ($Script -match '[^\x00-\x7F]') {
    throw "container Bun script must contain ASCII characters only"
  }

  $stagingData = Get-ContainerArchonMountSource -Docker $Docker -ContainerName $ContainerName
  $fileName = ".staging-bun-$([Guid]::NewGuid().ToString('N')).ts"
  $hostPath = Join-Path $stagingData $fileName
  $containerPath = "/.archon/$fileName"
  Set-Content -LiteralPath $hostPath -Value $Script -Encoding ascii -NoNewline

  try {
    $previousErrorActionPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = "Continue"
      $output = & $Docker exec @DockerExecOptions $ContainerName bun $containerPath 2>$null
      $exitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }

    if ($exitCode -ne 0) {
      throw "container Bun script failed with exit code $exitCode"
    }
    return $output
  } finally {
    if (Test-Path -LiteralPath $hostPath) {
      Remove-Item -LiteralPath $hostPath -Force -ErrorAction Stop
    }
    if (Test-Path -LiteralPath $hostPath) {
      throw "container Bun script cleanup left residue: $hostPath"
    }
  }
}

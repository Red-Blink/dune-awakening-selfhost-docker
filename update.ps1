#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$WslDistro = '',
    [string]$WorkspaceDir = '',
    [switch]$RebuildConsole,
    [switch]$RebuildOrchestrator,
    [switch]$FullStack
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Script:RepoRoot = $PSScriptRoot
$Script:WslFolder = Join-Path $RepoRoot '.wsl'
$Script:InstallConfigPath = Join-Path $WslFolder 'install.json'

function Get-InstallConfig {
    if (-not (Test-Path -LiteralPath $Script:InstallConfigPath)) {
        return $null
    }
    return Get-Content -LiteralPath $Script:InstallConfigPath -Raw | ConvertFrom-Json
}

function Invoke-Wsl {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,
        [string]$Distro,
        [string]$User = ''
    )
    $wslArgs = @('-d', $Distro)
    if ($User) {
        $wslArgs += @('-u', $User)
    }
    $wslArgs += @('--', 'bash', '-lc', $Command)
    $output = & wsl.exe @wslArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "WSL command failed (exit $LASTEXITCODE): $Command`n$output"
    }
    return $output
}

function Get-ComposeCommand {
    param(
        [string]$ConfiguredRuntime,
        [string]$WorkspaceWsl,
        [string]$Distro,
        [string]$User
    )
    if ($ConfiguredRuntime -eq 'podman') {
        $detect = @"
set -euo pipefail
cd '$WorkspaceWsl'
if podman info >/dev/null 2>&1; then echo podman; else echo none; fi
"@
    }
    else {
        $detect = @"
set -euo pipefail
cd '$WorkspaceWsl'
if docker info >/dev/null 2>&1; then echo docker; else echo none; fi
"@
    }
    $runtime = (Invoke-Wsl -Distro $Distro -User $User -Command $detect).Trim()
    if ($runtime -eq 'none') {
        throw "Configured runtime '$ConfiguredRuntime' is not available inside WSL. Run install.ps1 first."
    }
    return $runtime
}

function Invoke-ComposeRebuild {
    param(
        [string]$WorkspaceWsl,
        [string]$Distro,
        [string]$User,
        [string]$ConfiguredRuntime,
        [string]$ComposeFile,
        [string[]]$Services
    )
    $runtime = Get-ComposeCommand -ConfiguredRuntime $ConfiguredRuntime -WorkspaceWsl $WorkspaceWsl -Distro $Distro -User $User
    $serviceList = ($Services | ForEach-Object { "'$_'" }) -join ' '
    if ($runtime -eq 'podman') {
        $cmd = @"
set -euo pipefail
cd '$WorkspaceWsl'
export DUNE_HOST_REPO_ROOT="`$(pwd -P)"
export ADMIN_BIND_HOST=0.0.0.0
export ADMIN_BIND_PORT=8088
podman-compose -f '$ComposeFile' up -d --build --force-recreate $serviceList
"@
    }
    else {
        $cmd = @"
set -euo pipefail
cd '$WorkspaceWsl'
export DUNE_HOST_REPO_ROOT="`$(pwd -P)"
$runtime compose -f '$ComposeFile' up -d --build --force-recreate $serviceList
"@
    }
    Write-Host ""
    Write-Host "==> Rebuilding: $ComposeFile ($($Services -join ', ')) via $runtime"
    Invoke-Wsl -Distro $Distro -User $User -Command $cmd | ForEach-Object { Write-Host $_ }
}

$config = Get-InstallConfig
if (-not $config) {
    throw "No .wsl/install.json found. Run install.ps1 from this repository first."
}

$distro = if ($WslDistro) { $WslDistro } else { [string]$config.wslDistro }
if (-not $distro) {
    $distro = 'Debian_Dune'
}
$wslUser = if ($config.wslUser) { [string]$config.wslUser } else { '' }
$configuredRuntime = if ($config.containerRuntime) { [string]$config.containerRuntime } else { 'docker' }

$relative = if ($WorkspaceDir) {
    $WorkspaceDir
}
elseif ($config.workspaceDirRelative) {
    [string]$config.workspaceDirRelative
}
else {
    '.'
}

if ($relative -eq '.' -or [string]::IsNullOrWhiteSpace($relative)) {
    $workspaceWsl = [string]$config.repoRootWsl
    if ($config.workspaceDirWsl) {
        $workspaceWsl = [string]$config.workspaceDirWsl
    }
}
else {
    $workspaceWsl = [string]$config.workspaceDirWsl
    if ($WorkspaceDir) {
        $sep = [IO.Path]::DirectorySeparatorChar
        $windowsPath = Join-Path $Script:RepoRoot ($WorkspaceDir -replace '/', $sep)
        $workspaceWsl = (wsl.exe wslpath -a $windowsPath 2>&1 | Out-String).Trim() -replace '\\', '/'
    }
}

Write-Host ""
Write-Host "==> Pulling latest changes"
$pull = @"
set -euo pipefail
cd '$workspaceWsl'
git pull --ff-only
"@
Invoke-Wsl -Distro $distro -User $wslUser -Command $pull | ForEach-Object { Write-Host $_ }

Write-Host ""
Write-Host "Updated. Shell script changes are live via the repo mount."

if ($FullStack) {
    $RebuildConsole = $true
    $RebuildOrchestrator = $true
}

if ($RebuildConsole) {
    Invoke-ComposeRebuild -WorkspaceWsl $workspaceWsl -Distro $distro -User $wslUser -ConfiguredRuntime $configuredRuntime `
        -ComposeFile 'docker-compose.web.yml' `
        -Services @('redblink-dune-docker-console')
}

if ($RebuildOrchestrator) {
    Invoke-ComposeRebuild -WorkspaceWsl $workspaceWsl -Distro $distro -User $wslUser -ConfiguredRuntime $configuredRuntime `
        -ComposeFile 'docker-compose.yml' `
        -Services @('orchestrator')
}

if (-not $RebuildConsole -and -not $RebuildOrchestrator) {
    Write-Host "No container rebuild requested."
    Write-Host "Use -RebuildConsole, -RebuildOrchestrator, or -FullStack when Dockerfiles or bundled app code changed."
}

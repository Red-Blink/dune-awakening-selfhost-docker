#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$WslDistro = "Ubuntu-26.04",
    [string]$InstallDir = "dune-awakening-selfhost-docker",
    [string]$RepoUrl = "",
    [string]$RepoRef = "main",
    [int]$AdminPort = 8088,
    [switch]$SkipWslInstall,
    [switch]$SkipDockerInstall,
    [switch]$NoStart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Script:RepoRoot = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Script:RepoRoot)) {
    $Script:RepoRoot = (Get-Location).Path
}

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Info {
    param([string]$Message)
    Write-Host "    $Message"
}

function Test-CommandAvailable {
    param([string]$CommandName)
    return $null -ne (Get-Command $CommandName -ErrorAction SilentlyContinue)
}

function Invoke-External {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [string[]]$Arguments = @()
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($Arguments -join ' ')"
    }
}

function ConvertTo-WslPathLiteral {
    param([Parameter(Mandatory = $true)][string]$WindowsPath)

    $resolved = [System.IO.Path]::GetFullPath($WindowsPath)
    if ($resolved -match '^([A-Za-z]):\\(.*)$') {
        $drive = $Matches[1].ToLowerInvariant()
        $rest = $Matches[2] -replace '\\', '/'
        return "/mnt/$drive/$rest"
    }

    throw "Only local drive paths are supported for temporary WSL scripts. Unsupported path: $resolved"
}

function Invoke-WslScript {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ScriptText,
        [string]$User = "",
        [switch]$Root
    )

    $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) "dune-wsl-install"
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
    $scriptPath = Join-Path $tempDir ("script-{0}.sh" -f ([guid]::NewGuid().ToString("N")))
    Set-Content -LiteralPath $scriptPath -Value $ScriptText -Encoding UTF8 -NoNewline
    $wslScriptPath = ConvertTo-WslPathLiteral -WindowsPath $scriptPath

    try {
        if ($Root) {
            Invoke-External -FilePath "wsl.exe" -Arguments @("-d", $WslDistro, "-u", "root", "--", "bash", $wslScriptPath)
        } elseif (-not [string]::IsNullOrWhiteSpace($User)) {
            Invoke-External -FilePath "wsl.exe" -Arguments @("-d", $WslDistro, "-u", $User, "--", "bash", $wslScriptPath)
        } else {
            Invoke-External -FilePath "wsl.exe" -Arguments @("-d", $WslDistro, "--", "bash", $wslScriptPath)
        }
    }
    finally {
        Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue
    }
}

function Get-RegisteredWslDistros {
    if (-not (Test-CommandAvailable "wsl.exe")) {
        return @()
    }

    $output = & wsl.exe --list --quiet 2>$null
    if ($LASTEXITCODE -ne 0 -or $null -eq $output) {
        return @()
    }

    return @($output | ForEach-Object { ($_ -replace "`0", "").Trim() } | Where-Object { $_ })
}

function Test-WslDistroRegistered {
    param([string]$Name)
    return (Get-RegisteredWslDistros) -contains $Name
}

function Ensure-WslInstalled {
    Write-Step "Checking WSL"

    if (-not (Test-CommandAvailable "wsl.exe")) {
        throw "wsl.exe was not found. Use Windows 11 Home or later with WSL enabled, then run this script again."
    }

    if (-not $SkipWslInstall) {
        & wsl.exe --status 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Info "WSL is not fully installed. Starting Microsoft WSL installation."
            Write-Info "Windows may ask you to reboot. If it does, reboot and run this script again."
            Invoke-External -FilePath "wsl.exe" -Arguments @("--install", "--no-distribution")
        }
    }

    & wsl.exe --set-default-version 2 2>$null | Out-Null
    Write-Info "WSL is available."
}

function Ensure-UbuntuDistro {
    Write-Step "Checking $WslDistro"

    if (Test-WslDistroRegistered -Name $WslDistro) {
        Write-Info "$WslDistro is already installed."
        return
    }

    if ($SkipWslInstall) {
        throw "$WslDistro is not registered, and -SkipWslInstall was used. Install the distro first or remove -SkipWslInstall."
    }

    Write-Info "Installing $WslDistro."
    Write-Info "If Ubuntu opens a first-run setup window, create the Ubuntu username and password, then exit Ubuntu and re-run this script."
    & wsl.exe --install --distribution $WslDistro
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "$WslDistro was not available from 'wsl --install --distribution'." -ForegroundColor Yellow
        Write-Host "Run this command to see exact available names:"
        Write-Host "  wsl --list --online"
        Write-Host "If Ubuntu 26.04 is not listed, install it from the official .wsl image, then re-run this script."
        throw "Failed to install $WslDistro."
    }

    Write-Info "Starting $WslDistro once so Ubuntu can finish first-run setup."
    & wsl.exe -d $WslDistro -- echo ready | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "Ubuntu likely still needs first-run username setup." -ForegroundColor Yellow
        Write-Host "Open Ubuntu from the Start Menu, create the username/password, exit Ubuntu, then run this script again."
        throw "$WslDistro first-run setup is not complete."
    }
}

function Enable-Systemd {
    Write-Step "Ensuring systemd is enabled in $WslDistro"

    $script = @'
set -euo pipefail
if ! grep -q '^\[boot\]' /etc/wsl.conf 2>/dev/null || ! grep -q '^systemd=true' /etc/wsl.conf 2>/dev/null; then
  cat >/etc/wsl.conf <<'WSLCONF'
[boot]
systemd=true
WSLCONF
fi
'@

    Invoke-WslScript -ScriptText $script -Root
    Write-Info "Restarting WSL so systemd settings apply."
    & wsl.exe --shutdown
    Start-Sleep -Seconds 3
}

function Get-UbuntuDefaultUser {
    $user = (& wsl.exe -d $WslDistro -- bash -lc "id -un" 2>$null | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($user)) {
        throw "Could not determine the default Linux user for $WslDistro. Open Ubuntu once, finish first-run setup, then re-run this script."
    }
    return $user.Trim()
}

function Resolve-RepoUrl {
    if (-not [string]::IsNullOrWhiteSpace($RepoUrl)) {
        return $RepoUrl
    }

    if (Test-CommandAvailable "git.exe") {
        Push-Location $Script:RepoRoot
        try {
            $origin = (& git.exe config --get remote.origin.url 2>$null | Select-Object -First 1)
            if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($origin)) {
                return $origin.Trim()
            }
        }
        finally {
            Pop-Location
        }
    }

    return "https://github.com/Red-Blink/dune-awakening-selfhost-docker.git"
}

function Install-DockerEngineInUbuntu {
    param([string]$LinuxUser)

    if ($SkipDockerInstall) {
        Write-Step "Skipping Docker installation because -SkipDockerInstall was used"
        return
    }

    Write-Step "Installing Docker Engine inside Ubuntu"

    $escapedUser = $LinuxUser.Replace("'", "'\''")
    $script = @"
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg lsb-release git nano iproute2 apt-transport-https
for pkg in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do
  apt-get remove -y "\$pkg" >/dev/null 2>&1 || true
done
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
codename="\${UBUNTU_CODENAME:-\$VERSION_CODENAME}"
arch="\$(dpkg --print-architecture)"
cat >/etc/apt/sources.list.d/docker.sources <<EOFDOCKER
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: \$codename
Components: stable
Architectures: \$arch
Signed-By: /etc/apt/keyrings/docker.asc
EOFDOCKER
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  systemctl enable --now docker
else
  service docker start || true
fi
usermod -aG docker '$escapedUser' || true
docker version >/dev/null
docker compose version >/dev/null
"@

    Invoke-WslScript -ScriptText $script -Root
    Write-Info "Docker Engine and Docker Compose plugin are installed."
}

function Install-RepositoryAndRunInstaller {
    param(
        [string]$LinuxUser,
        [string]$ResolvedRepoUrl
    )

    Write-Step "Installing Dune Docker Console inside Ubuntu"

    $safeRepoUrl = $ResolvedRepoUrl.Replace("'", "'\''")
    $safeRepoRef = $RepoRef.Replace("'", "'\''")
    $safeInstallDir = $InstallDir.Replace("'", "'\''")
    $safeAdminPort = [string]$AdminPort
    $startFlag = if ($NoStart) { "1" } else { "0" }

    $script = @"
set -euo pipefail
cd "\$HOME"
if [ -d '$safeInstallDir/.git' ]; then
  echo "Repository already exists. Updating it."
  git -C '$safeInstallDir' fetch --all --tags
  git -C '$safeInstallDir' checkout '$safeRepoRef'
  git -C '$safeInstallDir' pull --ff-only || true
else
  git clone '$safeRepoUrl' '$safeInstallDir'
  git -C '$safeInstallDir' checkout '$safeRepoRef' || true
fi
cd '$safeInstallDir'
chmod +x install.sh
if [ '$startFlag' = '1' ]; then
  echo "Repository is ready at \$(pwd). -NoStart was used, so install.sh was not run."
else
  ADMIN_BIND_PORT='$safeAdminPort' ./install.sh
fi
"@

    Invoke-WslScript -ScriptText $script -User $LinuxUser
}

function Show-Finish {
    param(
        [string]$LinuxUser,
        [string]$ResolvedRepoUrl
    )

    Write-Host ""
    Write-Host "Windows / WSL setup finished." -ForegroundColor Green
    Write-Host ""
    Write-Host "Open the Web UI from Windows:"
    Write-Host "  http://localhost:$AdminPort"
    Write-Host ""
    Write-Host "Useful commands:"
    Write-Host "  wsl -d $WslDistro"
    Write-Host "  cd ~/$InstallDir"
    Write-Host "  dune --help"
    Write-Host "  dune status"
    Write-Host "  dune start"
    Write-Host "  dune stop"
    Write-Host ""
    Write-Host "Install details:"
    Write-Host "  WSL distro: $WslDistro"
    Write-Host "  Linux user: $LinuxUser"
    Write-Host "  Repository: $ResolvedRepoUrl"
    Write-Host "  Ubuntu path: ~/$InstallDir"
}

try {
    Write-Host "Dune Docker Console Windows / WSL installer" -ForegroundColor Green
    Write-Host "This script prepares Ubuntu on WSL2, installs Docker Engine inside Ubuntu, then runs install.sh."

    Ensure-WslInstalled
    Ensure-UbuntuDistro
    Enable-Systemd

    $linuxUser = Get-UbuntuDefaultUser
    Write-Step "Using Ubuntu user '$linuxUser'"

    Install-DockerEngineInUbuntu -LinuxUser $linuxUser

    $resolvedRepoUrl = Resolve-RepoUrl
    Write-Step "Using repository $resolvedRepoUrl"

    Install-RepositoryAndRunInstaller -LinuxUser $linuxUser -ResolvedRepoUrl $resolvedRepoUrl
    Show-Finish -LinuxUser $linuxUser -ResolvedRepoUrl $resolvedRepoUrl
}
catch {
    Write-Host ""
    Write-Host "Installation stopped." -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host ""
    Write-Host "See docs/WINDOWS-WSL-INSTALL.md for the manual path and troubleshooting."
    exit 1
}

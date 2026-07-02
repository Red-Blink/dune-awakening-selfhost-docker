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

function Invoke-WslScript {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ScriptText,
        [string]$User = "",
        [switch]$Root
    )

    $scriptBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($ScriptText))
    $bashCommand = "printf '%s' '$scriptBase64' | base64 -d | bash"

    if ($Root) {
        Invoke-External -FilePath "wsl.exe" -Arguments @("-d", $WslDistro, "-u", "root", "--", "bash", "-lc", $bashCommand)
    } elseif (-not [string]::IsNullOrWhiteSpace($User)) {
        Invoke-External -FilePath "wsl.exe" -Arguments @("-d", $WslDistro, "-u", $User, "--", "bash", "-lc", $bashCommand)
    } else {
        Invoke-External -FilePath "wsl.exe" -Arguments @("-d", $WslDistro, "--", "bash", "-lc", $bashCommand)
    }
}

function ConvertTo-ShellSingleQuotedString {
    param([string]$Value)
    return "'" + $Value.Replace("'", "'\''") + "'"
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

function Get-UbuntuDefaultUser {
    param([int]$Retries = 5)

    for ($attempt = 1; $attempt -le $Retries; $attempt++) {
        $userOutput = @(& wsl.exe -d $WslDistro -- sh -lc "id -un 2>/dev/null || whoami 2>/dev/null" 2>$null)
        $user = ($userOutput | ForEach-Object { ($_ -replace "`0", "").Trim() } | Where-Object { $_ } | Select-Object -First 1)
        if (-not [string]::IsNullOrWhiteSpace($user)) {
            return $user
        }

        if ($attempt -lt $Retries) {
            Start-Sleep -Seconds 3
        }
    }

    throw "Could not determine the default Linux user for $WslDistro. Open Ubuntu once with 'wsl -d $WslDistro', create the Linux username/password if prompted, verify with 'whoami', then re-run this script."
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
    Start-Sleep -Seconds 5
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

function Resolve-SourceArchiveUrl {
    param([string]$ResolvedRepoUrl)

    $repo = $ResolvedRepoUrl.Trim()
    $owner = ""
    $name = ""

    if ($repo -match '^https://github\.com/([^/]+)/([^/?#]+?)(\.git)?/?$') {
        $owner = $Matches[1]
        $name = $Matches[2]
    } elseif ($repo -match '^git@github\.com:([^/]+)/(.+?)(\.git)?$') {
        $owner = $Matches[1]
        $name = $Matches[2]
    } else {
        throw "Only GitHub repository URLs are supported by the Windows end-user installer. Use a URL like https://github.com/owner/repo.git."
    }

    $encodedRef = [System.Uri]::EscapeDataString($RepoRef)
    return "https://api.github.com/repos/$owner/$name/tarball/$encodedRef"
}

function Install-DockerEngineInUbuntu {
    param([string]$LinuxUser)

    if ($SkipDockerInstall) {
        Write-Step "Skipping Docker installation because -SkipDockerInstall was used"
        return
    }

    Write-Step "Installing Docker Engine inside Ubuntu"

    $escapedUser = ConvertTo-ShellSingleQuotedString -Value $LinuxUser
    $script = @'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg lsb-release nano iproute2 apt-transport-https tar gzip
for pkg in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do
  apt-get remove -y "$pkg" >/dev/null 2>&1 || true
done
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
codename="${UBUNTU_CODENAME:-$VERSION_CODENAME}"
arch="$(dpkg --print-architecture)"
cat >/etc/apt/sources.list.d/docker.sources <<EOFDOCKER
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $codename
Components: stable
Architectures: $arch
Signed-By: /etc/apt/keyrings/docker.asc
EOFDOCKER
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  systemctl enable --now docker
else
  service docker start || true
fi
usermod -aG docker __LINUX_USER__ || true
docker version >/dev/null
docker compose version >/dev/null
'@

    $script = $script.Replace("__LINUX_USER__", $escapedUser)
    Invoke-WslScript -ScriptText $script -Root
    Write-Info "Docker Engine and Docker Compose plugin are installed."
}

function Install-RepositoryAndRunInstaller {
    param(
        [string]$LinuxUser,
        [string]$SourceArchiveUrl
    )

    Write-Step "Installing Dune Docker Console source archive inside Ubuntu"

    $safeArchiveUrl = ConvertTo-ShellSingleQuotedString -Value $SourceArchiveUrl
    $safeInstallDir = ConvertTo-ShellSingleQuotedString -Value $InstallDir
    $safeAdminPort = [string]$AdminPort
    $startFlag = if ($NoStart) { "1" } else { "0" }

    $script = @'
set -euo pipefail
cd "$HOME"
archive_url=__SOURCE_ARCHIVE_URL__
install_dir="$HOME"/__INSTALL_DIR__

case "$install_dir" in
  "$HOME"/*) ;;
  *) echo "Refusing to install outside HOME: $install_dir"; exit 1 ;;
esac

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
mkdir -p "$work_dir/source"

echo "Downloading source archive."
curl -fsSL "$archive_url" -o "$work_dir/source.tar.gz"
tar -xzf "$work_dir/source.tar.gz" -C "$work_dir/source" --strip-components=1

preserve_dir="$work_dir/preserve"
mkdir -p "$preserve_dir"

if [ -d "$install_dir/runtime" ]; then
  mv "$install_dir/runtime" "$preserve_dir/runtime"
fi
if [ -f "$install_dir/.env" ]; then
  mv "$install_dir/.env" "$preserve_dir/.env"
fi

rm -rf "$install_dir"
mkdir -p "$install_dir"
cp -a "$work_dir/source/." "$install_dir/"

if [ -d "$preserve_dir/runtime" ]; then
  rm -rf "$install_dir/runtime"
  mv "$preserve_dir/runtime" "$install_dir/runtime"
fi
if [ -f "$preserve_dir/.env" ]; then
  mv "$preserve_dir/.env" "$install_dir/.env"
fi

cd "$install_dir"
chmod +x install.sh
if [ '__START_FLAG__' = '1' ]; then
  echo "Source is ready at $(pwd). -NoStart was used, so install.sh was not run."
else
  ADMIN_BIND_PORT='__ADMIN_PORT__' ./install.sh
fi
'@

    $script = $script.Replace("__SOURCE_ARCHIVE_URL__", $safeArchiveUrl)
    $script = $script.Replace("__INSTALL_DIR__", $safeInstallDir)
    $script = $script.Replace("__START_FLAG__", $startFlag)
    $script = $script.Replace("__ADMIN_PORT__", $safeAdminPort)

    Invoke-WslScript -ScriptText $script -User $LinuxUser
}

function Show-Finish {
    param(
        [string]$LinuxUser,
        [string]$SourceArchiveUrl
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
    Write-Host "  Source archive: $SourceArchiveUrl"
    Write-Host "  Ubuntu path: ~/$InstallDir"
}

try {
    Write-Host "Dune Docker Console Windows / WSL installer" -ForegroundColor Green
    Write-Host "This script prepares Ubuntu on WSL2, installs Docker Engine inside Ubuntu, then runs install.sh."

    Ensure-WslInstalled
    Ensure-UbuntuDistro

    $linuxUser = Get-UbuntuDefaultUser -Retries 5
    Write-Step "Using Ubuntu user '$linuxUser'"

    Enable-Systemd
    Install-DockerEngineInUbuntu -LinuxUser $linuxUser

    $resolvedRepoUrl = Resolve-RepoUrl
    $sourceArchiveUrl = Resolve-SourceArchiveUrl -ResolvedRepoUrl $resolvedRepoUrl
    Write-Step "Using source archive $sourceArchiveUrl"

    Install-RepositoryAndRunInstaller -LinuxUser $linuxUser -SourceArchiveUrl $sourceArchiveUrl
    Show-Finish -LinuxUser $linuxUser -SourceArchiveUrl $sourceArchiveUrl
}
catch {
    Write-Host ""
    Write-Host "Installation stopped." -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host ""
    Write-Host "See docs/WINDOWS-WSL-INSTALL.md for the manual path and troubleshooting."
    exit 1
}

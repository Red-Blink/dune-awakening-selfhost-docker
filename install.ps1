#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$WslDistro = 'Debian_Dune',
    [string]$WslDistroDir = '',
    [string]$WslUser = '',
    [SecureString]$WslPassword,
    [string]$WorkspaceDir = '',
    [string]$RepoUrl = 'https://github.com/Red-Blink/dune-awakening-selfhost-docker.git',
    [ValidateSet('docker', 'docker-desktop', 'podman', '')]
    [string]$ContainerRuntime = '',
    [switch]$SkipWslInstall,
    [switch]$Update,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Script:RepoRoot = $PSScriptRoot
$Script:WslFolder = Join-Path $RepoRoot '.wsl'
$Script:InstallConfigPath = Join-Path $WslFolder 'install.json'
$Script:InstallLogPath = Join-Path $WslFolder 'install.log'
$Script:DefaultWorkspaceDir = '.'
$Script:WslUserName = ''
$Script:WslPasswordPlain = ''
$Script:WslDistroPackage = 'Debian'
$Script:WslHelpText = ''
$Script:DockerDesktopNetworkRepairNeedsRestart = $false
$Script:WslDocLinks = @{
    InstallGuide         = 'https://learn.microsoft.com/en-us/windows/wsl/install'
    ManualInstall        = 'https://learn.microsoft.com/en-us/windows/wsl/install-manual'
    Troubleshooting      = 'https://learn.microsoft.com/en-us/windows/wsl/troubleshooting'
    UpdateWsl            = 'https://learn.microsoft.com/en-us/windows/wsl/basic-commands#update-wsl'
    Virtualization       = 'https://learn.microsoft.com/en-us/windows/wsl/troubleshooting#error-0x80370102-the-virtual-machine-platform-is-not-enabled'
    SystemRequirements   = 'https://learn.microsoft.com/en-us/windows/wsl/install-manual#step-2---check-requirements-for-running-wsl-2'
    SetDefaultVersion    = 'https://learn.microsoft.com/en-us/windows/wsl/basic-commands#set-default-version-to-wsl-1-or-wsl-2'
    ExecutionPolicy      = 'https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies'
    DockerDesktopWsl     = 'https://docs.docker.com/desktop/features/wsl/'
    DockerDesktopDownload = 'https://www.docker.com/products/docker-desktop/'
}

function Join-BashScriptLines {
    param(
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Line
    )
    return ($Line -join "`n")
}

function Write-InstallLog {
    param([string]$Message)
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
    if (Test-Path -LiteralPath $Script:WslFolder) {
        Add-Content -LiteralPath $Script:InstallLogPath -Value $line
    }
}

function Write-InstallBanner {
    param([string]$Message)
    Write-Host ""
    Write-Host $Message
}

function Write-InstallStep {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message"
    Write-InstallLog $Message
}

function Initialize-WslFolder {
    if (-not (Test-Path -LiteralPath $Script:WslFolder)) {
        New-Item -ItemType Directory -Path $Script:WslFolder -Force | Out-Null
    }
}

function Resolve-ContainerRuntime {
    if ($ContainerRuntime -eq 'docker') {
        return 'docker'
    }
    if ($ContainerRuntime -eq 'podman') {
        return 'podman'
    }
    if ($ContainerRuntime -eq 'docker-desktop') {
        return 'docker-desktop'
    }

    $config = Get-InstallConfig
    if ($config -and [string]$config.containerRuntime -eq 'podman') {
        return 'podman'
    }

    if (Test-DockerDesktopAvailable) {
        return 'docker-desktop'
    }

    Request-DockerDesktopInstallAndStop
}

function Request-DockerDesktopInstallAndStop {
    $steps = @(
        'Open your web browser.'
        "Go to: $($Script:WslDocLinks.DockerDesktopDownload)"
        'Download Docker Desktop for Windows (choose the right chip: AMD64 for most PCs).'
        'Run the installer and accept the defaults unless you know otherwise.'
        'Start Docker Desktop from the Start menu.'
        'Wait until the whale icon shows Docker is running - not "Starting..." or "Stopped".'
    ) + (Get-DockerDesktopIntegrationSteps) + @(
        "Open PowerShell in this folder (see commands below)."
        'Run install.ps1 again.'
    )
    Write-WslSelfHelp -Title 'Docker Desktop is required - install it first' -Steps $steps -Commands @(
        "cd '$Script:RepoRoot'"
        'powershell -ExecutionPolicy Bypass -File .\install.ps1'
        (Get-DockerDesktopIntegrationStartDistroCommand)
        (Get-DockerDesktopIntegrationVerifyCommand)
    ) -Links @(
        $Script:WslDocLinks.DockerDesktopDownload,
        $Script:WslDocLinks.DockerDesktopWsl
    )
    throw 'Install Docker Desktop, complete WSL integration, then re-run install.ps1.'
}

function Test-DockerDesktopInstalled {
    $candidates = @(
        (Join-Path ${env:ProgramFiles} 'Docker\Docker\Docker Desktop.exe'),
        (Join-Path ${env:ProgramFiles} 'Docker\Docker\resources\docker.exe')
    )
    if (${env:ProgramFiles(x86)}) {
        $candidates += Join-Path ${env:ProgramFiles(x86)} 'Docker\Docker\Docker Desktop.exe'
    }
    foreach ($path in $candidates) {
        if ($path -and (Test-Path -LiteralPath $path)) {
            return $true
        }
    }
    return $false
}

function Test-DockerDesktopRunningOnWindows {
    if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) {
        return $false
    }
    $prevErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    try {
        & docker.exe version 2>$null | Out-Null
        return ($LASTEXITCODE -eq 0)
    }
    finally {
        $ErrorActionPreference = $prevErrorAction
    }
}

function Test-DockerDesktopAvailable {
    if (Test-DockerDesktopInstalled) {
        return $true
    }
    return (Test-DockerDesktopRunningOnWindows)
}

function Test-DockerDesktopWslIntegration {
    param(
        [string]$Distro = $WslDistro,
        [string]$User = $Script:WslUserName
    )
    if (-not $User) {
        return $false
    }
    $check = @'
set -euo pipefail
command -v docker >/dev/null 2>&1
docker info --format '{{.OperatingSystem}}' 2>/dev/null | grep -qi 'docker desktop'
docker compose version >/dev/null 2>&1
'@
    try {
        Invoke-Wsl -Distro $Distro -User $User -Command $check | Out-Null
        return $true
    }
    catch {
        return $false
    }
}

function Wait-DockerDesktopWslIntegration {
    param(
        [string]$Distro = $WslDistro,
        [string]$User = $Script:WslUserName,
        [int]$MaxAttempts = 12,
        [int]$DelaySeconds = 5
    )
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        if (Test-DockerDesktopWslIntegration -Distro $Distro -User $User) {
            return $true
        }
        if ($attempt -eq 1) {
            Write-Host ""
            Write-Host "  REQUIRED: Docker Desktop -> Settings -> Resources -> WSL Integration -> turn ON '$Distro'." -ForegroundColor Yellow
            Write-Host "  If '$Distro' is missing from that list, run: wsl -d $Distro -- echo ok" -ForegroundColor Yellow
            Write-Host ""
        }
        if ($attempt -lt $MaxAttempts) {
            Write-Host "  Docker Desktop WSL integration not ready yet (attempt $attempt/$MaxAttempts)..."
            Start-Sleep -Seconds $DelaySeconds
        }
    }
    return $false
}

function Get-EmbeddedDockerInstallCommand {
    return "powershell -ExecutionPolicy Bypass -File .\install.ps1 -ContainerRuntime docker"
}

function Write-EmbeddedDockerEngineSelfHelp {
    param(
        [string]$Title = 'Docker Desktop cannot pull images - use Docker Engine inside WSL'
    )
    Write-WslSelfHelp -Title $Title -Steps @(
        'Symptom: docker hello-world works, but other images fail to download through Docker Desktop.'
        'Fix: install Docker Engine inside WSL using the official script at https://get.docker.com (the installer runs it for you).'
        'Re-run this installer with -ContainerRuntime docker (command below).'
        'Containers will run in WSL only - they will NOT show in the Docker Desktop UI (that is expected).'
        'Optional: Docker Desktop -> Settings -> Resources -> WSL Integration -> turn OFF this distro to avoid mixing runtimes.'
        'Verify embedded Engine: wsl -d Debian_Dune -- docker info (should NOT say Docker Desktop).'
    ) -Commands @(
        (Get-EmbeddedDockerInstallCommand)
        "cd '$Script:RepoRoot'"
        "wsl -d $WslDistro -- docker info --format '{{.OperatingSystem}}'"
    ) -Links @(
        'https://get.docker.com/',
        $Script:WslDocLinks.DockerDesktopWsl,
        (Join-Path $Script:RepoRoot 'WSL_README.md')
    )
}

function Write-DockerDesktopSelfHelp {
    param(
        [string]$Title = 'Docker Desktop setup required',
        [switch]$IncludeDownloadSteps
    )
    $steps = Get-DockerDesktopIntegrationSteps + @(
        'Run the verify command below. The output should contain the words "Docker Desktop".'
    )
    if ($IncludeDownloadSteps) {
        $steps = @(
            'Download and install Docker Desktop for Windows from the link below.',
            'Start Docker Desktop and wait until it is fully running.'
        ) + $steps
    }
    Write-WslSelfHelp -Title $Title -Steps $steps -Commands @(
        (Get-DockerDesktopIntegrationStartDistroCommand)
        (Get-DockerDesktopIntegrationVerifyCommand)
        "cd '$Script:RepoRoot'"
        'powershell -ExecutionPolicy Bypass -File .\install.ps1'
    ) -Links @(
        $Script:WslDocLinks.DockerDesktopDownload,
        $Script:WslDocLinks.DockerDesktopWsl
    )
}

function Initialize-DockerDesktopForWsl {
    param(
        [string]$Distro = $WslDistro
    )
    if (-not (Test-DockerDesktopAvailable)) {
        Request-DockerDesktopInstallAndStop
    }
    if (-not (Test-DockerDesktopRunningOnWindows)) {
        Write-DockerDesktopSelfHelp -Title 'Docker Desktop is installed but not running - start it first'
        throw 'Start Docker Desktop, wait until it is running, then re-run install.ps1.'
    }
    Start-WslDistroIfNeeded -Distro $Distro
    if (-not (Wait-DockerDesktopWslIntegration -Distro $Distro)) {
        Write-DockerDesktopSelfHelp -Title "Docker Desktop is running but WSL integration is OFF for '$Distro'"
        throw "Enable Docker Desktop -> Settings -> Resources -> WSL Integration for '$Distro', then re-run install.ps1."
    }
    Write-InstallLog "Docker Desktop WSL integration verified for $Distro"
}

function Get-VirtualEthernetAdapters {
    if (-not (Get-Command Get-NetAdapter -ErrorAction SilentlyContinue)) {
        return @()
    }
    return @(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object {
            $_.Name -like 'vEthernet*' -or $_.InterfaceDescription -like 'Hyper-V Virtual Ethernet*'
        })
}

function Get-VmwareBridgeBindingsOnVirtualEthernet {
    if (-not (Get-Command Get-NetAdapterBinding -ErrorAction SilentlyContinue)) {
        return @()
    }
    $bindings = New-Object System.Collections.Generic.List[object]
    foreach ($adapter in (Get-VirtualEthernetAdapters)) {
        $adapterBindings = Get-NetAdapterBinding -Name $adapter.Name -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName -like '*VMware*Bridge*' -and $_.Enabled }
        foreach ($binding in $adapterBindings) {
            [void]$bindings.Add($binding)
        }
    }
    return @($bindings.ToArray())
}

function Repair-DockerDesktopVirtualAdapterBindings {
    $problemBindings = @(Get-VmwareBridgeBindingsOnVirtualEthernet)
    if ($problemBindings.Count -eq 0) {
        return @{
            Changed           = $false
            RepairedAdapters  = @()
            NeedsAdmin        = $false
            NeedsRestart      = $false
        }
    }

    if (-not (Test-IsAdministrator)) {
        Write-WslSelfHelp -Title 'VMware Bridge is breaking Docker/WSL networking - run as Administrator to fix automatically' -Steps @(
            'This often causes players to get stuck on "Connecting" even when the server shows in the browser.'
            'The installer can turn off VMware Bridge on Hyper-V adapters for you - but only when PowerShell is elevated.'
            'Open an admin PowerShell: Start menu -> type PowerShell -> Ctrl+Shift+Enter -> Yes.'
            'Or from this window, run the "open admin PowerShell" command below.'
            'In the admin window, go to this repo folder and run install.ps1 again (commands below).'
            'OR fix manually: press Win+R, type ncpa.cpl, Enter -> right-click "vEthernet (Default Switch)" -> Properties -> uncheck "VMware Bridge Protocol" -> OK.'
            'Then restart Docker Desktop and run: wsl --shutdown'
        ) -Commands @(
            (Get-ElevatedInstallCommand)
            "cd '$Script:RepoRoot'"
            'powershell -ExecutionPolicy Bypass -File .\install.ps1'
            'wsl --shutdown'
        ) -Links @(
            (Join-Path $Script:RepoRoot 'WSL_README.md')
        )
        return @{
            Changed           = $false
            RepairedAdapters  = @()
            NeedsAdmin        = $true
            NeedsRestart      = $false
        }
    }

    Write-InstallStep 'Repairing Hyper-V virtual adapter bindings for Docker Desktop'
    $repaired = New-Object System.Collections.Generic.List[string]
    foreach ($binding in $problemBindings) {
        Write-Host "  Disabling '$($binding.DisplayName)' on '$($binding.Name)'..."
        try {
            Disable-NetAdapterBinding -Name $binding.Name -ComponentID $binding.ComponentID -Confirm:$false -ErrorAction Stop
            [void]$repaired.Add($binding.Name)
            Write-InstallLog "Disabled $($binding.DisplayName) on $($binding.Name)"
        }
        catch {
            Write-Host "  Warning: could not disable '$($binding.DisplayName)' on '$($binding.Name)': $($_.Exception.Message)"
            Write-InstallLog "Failed to disable $($binding.DisplayName) on $($binding.Name): $($_.Exception.Message)"
        }
    }

    if ($repaired.Count -gt 0) {
        Show-NetworkRepairRestartSteps
    }

    return @{
        Changed           = ($repaired.Count -gt 0)
        RepairedAdapters  = $repaired.ToArray()
        NeedsAdmin        = $false
        NeedsRestart      = ($repaired.Count -gt 0)
    }
}

function Ensure-DockerDesktopNetworkAdapters {
    return (Repair-DockerDesktopVirtualAdapterBindings)
}

function Get-ContainerRuntimeDescription {
    param([string]$Runtime)
    switch ($Runtime) {
        'docker-desktop' { return 'Docker Desktop via WSL integration (containers visible in Docker Desktop UI)' }
        'podman' { return 'Podman inside WSL' }
        default { return 'embedded Docker Engine inside WSL' }
    }
}

function Get-InstallConfig {
    if (-not (Test-Path -LiteralPath $Script:InstallConfigPath)) {
        return $null
    }
    return Get-Content -LiteralPath $Script:InstallConfigPath -Raw | ConvertFrom-Json
}

function Set-InstallConfig {
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$Config
    )
    Initialize-WslFolder
    ($Config | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $Script:InstallConfigPath -Encoding UTF8
}

function Get-WslOutputLine {
    param($Item)
    if ($Item -is [System.Management.Automation.ErrorRecord]) {
        return $Item.ToString()
    }
    return [string]$Item
}

$Script:WslStreamProgressLineLength = 0

function Complete-WslStreamProgressLine {
    if ($Script:WslStreamProgressLineLength -gt 0) {
        Write-Host ''
        $Script:WslStreamProgressLineLength = 0
    }
}

function Write-WslStreamLine {
    param([string]$Line)
    if ([string]::IsNullOrEmpty($Line)) {
        return
    }

    # Docker BuildKit uses carriage returns to redraw one progress line on a TTY.
    # Through wsl.exe -> PowerShell those updates become staggered whitespace unless normalized.
    if ($Line -match "`r") {
        $segments = $Line -split "`r"
        $Line = $segments[$segments.Length - 1]
        if ([string]::IsNullOrWhiteSpace($Line)) {
            return
        }
        $pad = [Math]::Max(0, $Script:WslStreamProgressLineLength - $Line.Length)
        Write-Host ("`r$Line$(' ' * $pad)") -NoNewline
        $Script:WslStreamProgressLineLength = [Math]::Max($Script:WslStreamProgressLineLength, $Line.Length)
        if ($Line -match '( done| CACHED| ERROR| CANCELED)\s*$') {
            Complete-WslStreamProgressLine
        }
        return
    }

    Complete-WslStreamProgressLine
    if (-not [string]::IsNullOrWhiteSpace($Line)) {
        Write-Host $Line
    }
}

function New-WslCommandArgs {
    param(
        [string]$Distro,
        [string]$User,
        [string]$Command
    )
    $wslArgList = New-Object 'System.Collections.Generic.List[string]'
    [void]$wslArgList.Add('-d')
    [void]$wslArgList.Add($Distro)
    if ($User) {
        [void]$wslArgList.Add('-u')
        [void]$wslArgList.Add($User)
    }
    [void]$wslArgList.Add('--')
    [void]$wslArgList.Add('bash')
    [void]$wslArgList.Add('-lc')
    [void]$wslArgList.Add($Command)
    return $wslArgList.ToArray()
}

function ConvertTo-WslBashPipeCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ScriptContent
    )
    $unixContent = ($ScriptContent -replace "`r`n", "`n") -replace "`r", "`n"
    $scriptB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($unixContent))
    $run = 'echo ''__SCRIPT_B64__'' | base64 -d | bash'
    return $run.Replace('__SCRIPT_B64__', $scriptB64)
}

function Invoke-Wsl {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,
        [string]$Distro = $WslDistro,
        [string]$User = '',
        [switch]$StreamOutput
    )
    if ($Command -match '[\r\n]') {
        $Command = ConvertTo-WslBashPipeCommand -ScriptContent $Command
    }
    $wslArgs = New-WslCommandArgs -Distro $Distro -User $User -Command $Command

    if ($StreamOutput) {
        $lines = New-Object System.Collections.Generic.List[string]
        $prevErrorAction = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            & wsl.exe @wslArgs 2>&1 | ForEach-Object {
                $line = Get-WslOutputLine $_
                [void]$lines.Add($line)
                Write-WslStreamLine -Line $line
            }
        }
        finally {
            Complete-WslStreamProgressLine
            $ErrorActionPreference = $prevErrorAction
        }
        if ($LASTEXITCODE -ne 0) {
            $joined = ($lines -join [Environment]::NewLine)
            $helpShown = Write-WslCommandFailureHelp -OutputText $joined
            if ($helpShown) {
                throw "WSL install failed. Follow the steps above, then re-run install.ps1 from: $Script:RepoRoot"
            }
            throw ('WSL command failed (exit {0}): {1}{2}{3}' -f $LASTEXITCODE, $Command, [Environment]::NewLine, $joined)
        }
        return $lines
    }

    $output = & wsl.exe @wslArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
        $outputText = if ($output -is [array]) { ($output -join [Environment]::NewLine) } else { [string]$output }
        $helpShown = Write-WslCommandFailureHelp -OutputText $outputText
        if ($helpShown) {
            throw "WSL install failed. Follow the steps above, then re-run install.ps1 from: $Script:RepoRoot"
        }
        throw ('WSL command failed (exit {0}): {1}{2}{3}' -f $LASTEXITCODE, $Command, [Environment]::NewLine, $outputText)
    }
    return $output
}

function Invoke-WslBashScript {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ScriptContent,
        [string]$Distro = $WslDistro,
        [string]$User = '',
        [string]$ScriptName = 'wsl-task.sh'
    )
    $run = ConvertTo-WslBashPipeCommand -ScriptContent $ScriptContent

    Invoke-Wsl -Distro $Distro -User $User -Command $run | Out-Null
}

function Test-WslUsername {
    param([Parameter(Mandatory = $true)][string]$Name)
    if ($Name -notmatch '^[a-z_][a-z0-9_-]*$') {
        throw "Invalid WSL username '$Name'. Use lowercase letters, numbers, underscore, or hyphen."
    }
}

function Test-WslLinuxUserExists {
    param(
        [Parameter(Mandatory = $true)]
        [string]$User,
        [string]$Distro = $WslDistro
    )
    Test-WslUsername -Name $User
    try {
        Invoke-Wsl -Distro $Distro -User root -Command "id -u $User >/dev/null 2>&1" | Out-Null
        return $true
    }
    catch {
        return $false
    }
}

function Repair-WslConfMissingDefaultUser {
    param([string]$Distro = $WslDistro)
    Write-InstallStep 'Checking WSL default user in /etc/wsl.conf'
    $manageArgs = @('--manage', $Distro, '--set-default-user', 'root')
    $null = & wsl.exe @manageArgs 2>&1
    if ($LASTEXITCODE -eq 0) {
        wsl.exe --shutdown | Out-Null
        Start-Sleep -Seconds 2
    }
    $repair = @'
set -euo pipefail
if [ ! -f /etc/wsl.conf ]; then
  exit 0
fi
default="$(awk '
  /^\[user\]/ { in_user=1; next }
  /^\[/ { in_user=0 }
  in_user && /^default=/ { sub(/^default=/, ""); gsub(/[[:space:]]/, ""); print; exit }
' /etc/wsl.conf)"
if [ -z "$default" ]; then
  exit 0
fi
if id "$default" >/dev/null 2>&1; then
  echo "WSL default user '$default' exists."
  exit 0
fi
echo "WSL default user '$default' is missing; resetting default to root until install creates the user."
if grep -q '^default=' /etc/wsl.conf; then
  sed -i 's/^default=.*/default=root/' /etc/wsl.conf
else
  printf '\n[user]\ndefault=root\n' >> /etc/wsl.conf
fi
'@
    try {
        Invoke-WslBashScript -Distro $Distro -User root -ScriptContent $repair -ScriptName 'repair-wsl-conf-default-user.sh' | Out-Null
        wsl.exe --shutdown | Out-Null
        Start-Sleep -Seconds 3
    }
    catch {
        Write-WslSelfHelp -Title 'WSL cannot start because /etc/wsl.conf points at a missing user' -Steps @(
            'The distro default user in /etc/wsl.conf does not exist (often after a partial install).'
            'From PowerShell, open root shell: wsl -d Debian_Dune -u root'
            'Inside that shell run: sed -i "s/^default=.*/default=root/" /etc/wsl.conf'
            'Then from Windows run: wsl --shutdown'
            'Re-run install.ps1 and enter your WSL username and password when prompted.'
        ) -Commands @(
            "wsl -d $Distro -u root"
            "cd '$Script:RepoRoot'"
            'powershell -ExecutionPolicy Bypass -File .\install.ps1'
        )
        throw "WSL default user is missing in $Distro. Follow the steps above, then re-run install.ps1."
    }
}

function Write-WslMissingUserSelfHelp {
    param(
        [Parameter(Mandatory = $true)]
        [string]$User
    )
    Write-WslSelfHelp -Title "WSL user '$User' does not exist inside $WslDistro yet" -Steps @(
        "The installer has username '$User' saved, but that Linux user was never created (partial prior run)."
        'Re-run install.ps1 and enter the WSL password when prompted so the user can be created.'
        'Or pass username and password explicitly on the command line (see below).'
    ) -Commands @(
        "cd '$Script:RepoRoot'"
        "powershell -ExecutionPolicy Bypass -File .\install.ps1 -WslUser $User"
    ) -Links @(
        (Join-Path $Script:RepoRoot 'WSL_README.md')
    )
}

function Convert-SecureStringToPlainText {
    param(
        [Parameter(Mandatory = $true)]
        [SecureString]$SecureString
    )
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureString)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    }
    finally {
        if ($bstr -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
    }
}

function Test-PasswordPromptAnsiTerminal {
    return [bool](
        $env:WT_SESSION -or
        $env:TERM_PROGRAM -or
        $env:CURSOR_TRACE_ID -or
        $env:VSCODE_IPC_HOOK
    )
}

function Write-PasswordPromptBackspace {
    if (Test-PasswordPromptAnsiTerminal) {
        Write-Host "$([char]27)[1D$([char]27)[K" -NoNewline
    }
    else {
        Write-Host "`b `b" -NoNewline
    }
}

function Read-WslSecurePasswordViaCredentialDialog {
    $userLabel = if ($Script:WslUserName) { $Script:WslUserName } else { 'WSL user' }
    Write-Host "Enter the WSL password in the Windows dialog (user: $userLabel)." -ForegroundColor Cyan
    $cred = Get-Credential -UserName $userLabel -Message 'WSL password for Dune install (used only inside WSL, not saved to disk)'
    if (-not $cred -or -not $cred.Password) {
        throw 'WSL password is required.'
    }
    return $cred.Password
}

function Read-WslSecurePassword {
    if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected) {
        return Read-Host 'WSL password' -AsSecureString
    }

    if ($Host.Name -ne 'ConsoleHost') {
        return Read-WslSecurePasswordViaCredentialDialog
    }

    try {
        Write-Host 'WSL password: ' -NoNewline
        $chars = New-Object System.Collections.Generic.List[char]
        while ($true) {
            $key = [Console]::ReadKey($true)
            if ($key.Key -in @('Enter', 'Return') -or $key.KeyChar -in @([char]13, [char]10)) {
                Write-Host ''
                break
            }
            if ($key.Key -in @('Backspace', 'Delete') -or $key.KeyChar -in @([char]8, [char]127)) {
                if ($chars.Count -gt 0) {
                    [void]$chars.RemoveAt($chars.Count - 1)
                    Write-PasswordPromptBackspace
                }
                continue
            }
            if ($key.KeyChar -eq [char]0) {
                continue
            }
            if ([char]::IsControl($key.KeyChar)) {
                continue
            }
            [void]$chars.Add($key.KeyChar)
            Write-Host '*' -NoNewline
        }

        $secure = New-Object System.Security.SecureString
        foreach ($ch in $chars) {
            $secure.AppendChar($ch) | Out-Null
        }
        return $secure
    }
    catch {
        return Read-WslSecurePasswordViaCredentialDialog
    }
}

function Read-WslPasswordPlain {
    return Convert-SecureStringToPlainText -SecureString (Read-WslSecurePassword)
}

function Resolve-WslCredentials {
    param(
        [switch]$RequirePassword
    )
    $config = Get-InstallConfig
    if (-not $WslUser -and $config -and $config.wslUser) {
        $Script:WslUserName = [string]$config.wslUser
    }
    elseif ($WslUser) {
        $Script:WslUserName = $WslUser.Trim()
    }

    if (-not $Script:WslUserName) {
        $Script:WslUserName = (Read-Host 'WSL username').Trim()
    }

    Test-WslUsername -Name $Script:WslUserName

    if ($PSBoundParameters.ContainsKey('WslPassword') -and $WslPassword) {
        $Script:WslPasswordPlain = Convert-SecureStringToPlainText -SecureString $WslPassword
        return
    }
    if ($RequirePassword) {
        $Script:WslPasswordPlain = Read-WslPasswordPlain
        return
    }
    if ($config -and $config.wslUser -eq $Script:WslUserName) {
        if (Test-WslLinuxUserExists -User $Script:WslUserName) {
            return
        }
        Write-InstallStep "Saved WSL user '$($Script:WslUserName)' is missing inside the distro; password required to recreate it."
    }
    if (-not $RequirePassword) {
        Write-WslMissingUserSelfHelp -User $Script:WslUserName
        throw "WSL user '$($Script:WslUserName)' does not exist. Re-run install.ps1 and enter the WSL password when prompted."
    }
    $Script:WslPasswordPlain = Read-WslPasswordPlain
}

function Initialize-WslLinuxUser {
    param(
        [string]$Distro = $WslDistro,
        [string]$User = $Script:WslUserName
    )
    if (Test-WslLinuxUserExists -User $User) {
        return
    }
    if (-not $Script:WslPasswordPlain) {
        Write-WslMissingUserSelfHelp -User $User
        throw "WSL user '$User' does not exist. Re-run install.ps1 and enter the WSL password when prompted."
    }

    Write-InstallStep "Configuring WSL user: $User"
    $userB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($User))
    $passB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Script:WslPasswordPlain))
    $configureUserPath = Join-Path $Script:RepoRoot 'runtime/scripts/configure-wsl-user.sh'
    $configureUser = Get-Content -LiteralPath $configureUserPath -Raw
    $configureUser = $configureUser -replace '__USER_B64__', $userB64 -replace '__PASS_B64__', $passB64

    Invoke-WslBashScript -Distro $Distro -User root -ScriptContent $configureUser -ScriptName 'configure-user.sh' | Out-Null
    wsl.exe --shutdown | Out-Null
    Start-Sleep -Seconds 3
    Invoke-Wsl -Distro $Distro -User $User -Command 'echo WSL user is ready.' | Out-Null
}

function Set-WslInstallUserSudo {
    param(
        [string]$Distro = $WslDistro,
        [string]$User = $Script:WslUserName
    )
    if (-not $User) {
        return
    }

    Test-WslUsername -Name $User
    if (-not (Test-WslLinuxUserExists -User $User)) {
        Write-WslMissingUserSelfHelp -User $User
        throw "Cannot configure sudo until WSL user '$User' exists. Re-run install.ps1 with the WSL password."
    }
    Write-InstallStep "Ensuring passwordless sudo for WSL install user: $User"
    $enableSudoPath = Join-Path $Script:RepoRoot 'runtime/scripts/enable-wsl-install-sudo.sh'
    $enableSudo = Get-Content -LiteralPath $enableSudoPath -Raw
    $enableSudo = $enableSudo -replace '__USER__', $User
    Invoke-WslBashScript -Distro $Distro -User root -ScriptContent $enableSudo -ScriptName 'enable-wsl-install-sudo.sh' | Out-Null
}

function Get-WindowsDnsServerList {
    $servers = @()
    try {
        $addresses = Get-DnsClientServerAddress -ErrorAction SilentlyContinue |
            Where-Object { $_.AddressFamily -eq 2 -and $_.ServerAddresses } |
            ForEach-Object { $_.ServerAddresses } |
            Select-Object -Unique
        foreach ($addr in $addresses) {
            if ($addr -match '^\d{1,3}(\.\d{1,3}){3}$') {
                $servers += $addr
            }
        }
    }
    catch {
        # Best effort when Get-DnsClientServerAddress is unavailable.
    }
    return @($servers)
}

function Initialize-WslDns {
    param([string]$Distro = $WslDistro)
    Write-InstallStep 'Configuring WSL DNS (/etc/wsl.conf and /etc/resolv.conf)'
    $dnsServers = @(Get-WindowsDnsServerList)
    $dnsEnv = if ($dnsServers.Count -gt 0) { ($dnsServers -join ',') } else { '' }
    $repoWsl = ConvertTo-WslPath -WindowsPath $Script:RepoRoot -Distro $Distro
    $configureDns = @(
        "cd '$repoWsl'"
        if ($dnsEnv) { "export DUNE_WSL_DNS='$dnsEnv'" }
        'bash runtime/scripts/configure-wsl-dns.sh'
    ) -join '; '
    try {
        Invoke-WslBashScript -Distro $Distro -User root -ScriptContent $configureDns -ScriptName 'configure-wsl-dns.sh' | Out-Null
        wsl.exe --shutdown | Out-Null
        Start-Sleep -Seconds 3
        Invoke-Wsl -Distro $Distro -User root -Command 'echo WSL DNS configured.' | Out-Null
    }
    catch {
        Write-WslSelfHelp -Title 'WSL DNS configuration failed' -Steps @(
            'The installer could not write /etc/wsl.conf or /etc/resolv.conf inside WSL.'
            'Create .wsl/dns-servers.txt in the repo (one IPv4 DNS server per line), then re-run install.ps1.'
            'Example contents: your router IP (often 192.168.x.1) or 1.1.1.1'
        ) -Commands @(
            "cd '$Script:RepoRoot'"
            'powershell -ExecutionPolicy Bypass -File .\install.ps1'
        ) -Links @(
            (Join-Path $Script:RepoRoot 'WSL_README.md')
        )
        throw "WSL DNS configuration failed. See steps above, then re-run install.ps1."
    }
}

function Invoke-WslAsInstallUser {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,
        [string]$Distro = $WslDistro,
        [switch]$StreamOutput
    )
    Invoke-Wsl -Distro $Distro -User $Script:WslUserName -Command $Command -StreamOutput:$StreamOutput
}

function Get-WslDistroBasePath {
    param([string]$Distro = $WslDistro)
    $keys = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' -ErrorAction SilentlyContinue
    foreach ($key in $keys) {
        $props = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
        if ($props -and [string]$props.DistributionName -eq $Distro) {
            return [string]$props.BasePath
        }
    }
    return ''
}

function Resolve-WslDistroInstallDir {
    $config = Get-InstallConfig
    if ($WslDistroDir) {
        $relative = $WslDistroDir.Trim()
        if ([IO.Path]::IsPathRooted($relative)) {
            return (Resolve-Path -LiteralPath $relative).Path
        }
        return (Join-Path $Script:RepoRoot ($relative -replace '/', [IO.Path]::DirectorySeparatorChar))
    }
    if ($config -and $config.wslDistroInstallDir) {
        return [string]$config.wslDistroInstallDir
    }
    return Join-Path (Join-Path $Script:WslFolder 'distro') $WslDistro
}

function Test-WslDistroAtInstallDir {
    param(
        [string]$Distro = $WslDistro,
        [string]$InstallDir
    )
    if (-not (Test-Path -LiteralPath $InstallDir)) {
        return $false
    }
    $current = Get-WslDistroBasePath -Distro $Distro
    if (-not $current) {
        return $false
    }
    try {
        $expected = (Resolve-Path -LiteralPath $InstallDir).Path
        $actual = (Resolve-Path -LiteralPath $current).Path
        return $expected -eq $actual
    }
    catch {
        return $false
    }
}

function Write-WslSelfHelp {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Title,
        [string[]]$Steps = @(),
        [string[]]$Commands = @(),
        [string[]]$Links = @(),
        [string]$Footer = 'When you have finished the steps above, run install.ps1 again from this folder.'
    )
    Write-Host ""
    Write-Host "================================================================" -ForegroundColor Yellow
    Write-Host "  $Title" -ForegroundColor Yellow
    Write-Host "================================================================" -ForegroundColor Yellow
    Write-Host ""
    if ($Steps.Count -gt 0) {
        for ($i = 0; $i -lt $Steps.Count; $i++) {
            Write-Host ("  {0}. {1}" -f ($i + 1), $Steps[$i])
        }
    }
    if ($Commands.Count -gt 0) {
        Write-Host ""
        Write-Host "  Copy and paste (one line at a time):" -ForegroundColor Cyan
        foreach ($cmd in $Commands) {
            Write-Host "    $cmd" -ForegroundColor White
        }
    }
    if ($Links.Count -gt 0) {
        Write-Host ""
        Write-Host "  Links:"
        foreach ($link in $Links) {
            Write-Host "    $link"
        }
    }
    Write-Host ""
    Write-Host "  Full guide: $(Join-Path $Script:RepoRoot 'WSL_README.md')"
    if (Test-Path -LiteralPath $Script:InstallLogPath) {
        Write-Host "  Install log: $($Script:InstallLogPath)"
    }
    if ($Footer) {
        Write-Host ""
        Write-Host "  $Footer" -ForegroundColor Cyan
    }
    Write-Host ""
}

function Start-WslDistroIfNeeded {
    param([string]$Distro = $WslDistro)
    Write-InstallStep "Starting WSL distro '$Distro' (Docker Desktop must see it under Settings -> Resources -> WSL Integration)"
    wsl.exe -d $Distro -- echo ok 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Could not start WSL distro '$Distro'. Run: wsl -l -v"
    }
}

function Get-DockerDesktopIntegrationStartDistroCommand {
    return "wsl -d $WslDistro -- echo ok"
}

function Get-DockerDesktopIntegrationSteps {
    return @(
        'Open Docker Desktop (whale icon in the Windows system tray - bottom-right).'
        'Wait until Docker Desktop is fully running (not "Starting..." or "Stopped").'
        'Click the gear icon -> Settings.'
        'Settings -> General: turn ON "Use the WSL 2 based engine".'
        'Settings -> Resources -> WSL Integration: this is the screen you must enable (easy to miss).'
        "On that WSL Integration page, turn ON the switch next to '$WslDistro'."
        "If '$WslDistro' is not listed: run the start-distro command below, restart Docker Desktop, open Settings -> Resources -> WSL Integration again."
        'Click Apply & restart (or Apply) and wait until Docker is running again.'
        'If you do not see "WSL Integration" at all: right-click the whale icon -> Switch to Linux containers, then open Settings again.'
    )
}

function Get-DockerDesktopIntegrationVerifyCommand {
    return "wsl -d $WslDistro -- docker info --format '{{.OperatingSystem}}'"
}

function Show-InstallPreflightChecklist {
    Write-InstallBanner "Before you start - quick checklist"
    Write-Host @"
  This installer sets up WSL + Docker Desktop + the Dune web console on Windows.
  You do not need to be a Linux expert; follow the numbered steps if anything stops.

  Recommended (first time):
    1. Install Docker Desktop: $($Script:WslDocLinks.DockerDesktopDownload)
    2. Start Docker Desktop and wait until it is fully running (not "Starting...")
    3. REQUIRED - enable WSL Integration for this installer:
         Docker Desktop -> Settings -> Resources -> WSL Integration -> turn ON '$WslDistro'
       (If '$WslDistro' is not in the list, run: wsl -d $WslDistro -- echo ok, restart Docker Desktop, try again.)
       Verify: $(Get-DockerDesktopIntegrationVerifyCommand)
    4. If hello-world works but other images fail to pull, use embedded Engine instead:
         $(Get-EmbeddedDockerInstallCommand)
       (installs Docker inside WSL via https://get.docker.com - containers stay in WSL, not Docker Desktop UI)
    5. Open PowerShell as Administrator (Start menu -> type PowerShell -> Ctrl+Shift+Enter -> Yes)
    6. In PowerShell, go to this folder:
         cd '$Script:RepoRoot'
    7. Run:
         powershell -ExecutionPolicy Bypass -File .\install.ps1

  No Ctrl+Shift+Enter? From any PowerShell window, paste this to open an admin window:
         $(Get-ElevatedInstallCommand)

  Windows says reboot required? Add -Force to try anyway (may fail until you restart):
         powershell -ExecutionPolicy Bypass -File .\install.ps1 -Force

  When install finishes, open http://localhost:8088 in your browser.

  Stuck? Open WSL_README.md in this folder or check .wsl\install.log
"@
}

function Show-NetworkRepairRestartSteps {
    Write-WslSelfHelp -Title 'IMPORTANT: Restart Docker and WSL (network settings were changed)' -Steps @(
        'Quit Docker Desktop completely: right-click the whale icon in the system tray -> Quit Docker Desktop.'
        'Start Docker Desktop again from the Start menu and wait until it is running.'
        'Close any open WSL/terminal windows that were using Linux.'
        'In PowerShell, run the command below (this restarts WSL).'
        'Run install.ps1 again, or restart your Dune game stack from the web UI / WSL.'
        'If players were stuck on "Connecting" in-game, see WSL_README.md -> Players stuck on Connecting.'
    ) -Commands @(
        'wsl --shutdown'
        "cd '$Script:RepoRoot'"
        'powershell -ExecutionPolicy Bypass -File .\install.ps1'
    ) -Links @(
        (Join-Path $Script:RepoRoot 'WSL_README.md')
    ) -Footer 'Do not skip the restart steps - hosting may not work until Docker and WSL have restarted.'
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-WindowsWslSupport {
    $os = Get-CimInstance Win32_OperatingSystem
    $build = [int]$os.BuildNumber
    $arch = $env:PROCESSOR_ARCHITECTURE
    $issues = @()

    if ($arch -notin @('AMD64', 'ARM64')) {
        $issues += "Unsupported CPU architecture '$arch'. WSL2 needs 64-bit x64 or ARM64 Windows."
    }
    if ($build -lt 19041) {
        $issues += "Windows build $build is below the WSL2 minimum (19041 / Windows 10 version 2004). Update Windows and try again."
    }

    return @{
        Supported    = ($issues.Count -eq 0)
        Issues       = $issues
        BuildNumber  = $build
        Architecture = $arch
        OsCaption    = [string]$os.Caption
    }
}

function Test-WslVirtualizationEnabled {
    try {
        if ((Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).HypervisorPresent) {
            return $true
        }
    }
    catch {
        # fall through
    }
    try {
        $cpu = Get-CimInstance Win32_Processor -ErrorAction Stop | Select-Object -First 1
        if ($null -ne $cpu.VirtualizationFirmwareEnabled) {
            return [bool]$cpu.VirtualizationFirmwareEnabled
        }
    }
    catch {
        return $null
    }
    return $null
}

function Test-WindowsRebootPending {
    if (Test-Path -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') {
        return $true
    }
    if (Test-Path -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') {
        return $true
    }
    return $false
}

function Get-WslOptionalFeatureState {
    param([Parameter(Mandatory = $true)][string]$FeatureName)
    if (-not (Test-IsAdministrator)) {
        return $null
    }
    try {
        $feature = Get-WindowsOptionalFeature -Online -FeatureName $FeatureName -ErrorAction Stop
        return [string]$feature.State
    }
    catch {
        return $null
    }
}

function Get-WslPlatformStatus {
    $status = @{
        WslExeAvailable    = $false
        WslVersionText     = ''
        DefaultVersion     = ''
        StatusText         = ''
        Features           = @{}
        RebootRequired     = (Test-WindowsRebootPending)
    }

    if (Get-Command wsl.exe -ErrorAction SilentlyContinue) {
        $status.WslExeAvailable = $true
        $status.WslVersionText = (wsl.exe --version 2>&1 | Out-String).Trim()
        $status.StatusText = (wsl.exe --status 2>&1 | Out-String).Trim()
        if ($status.StatusText -match 'Default Version:\s*(\d+)') {
            $status.DefaultVersion = $Matches[1]
        }
    }

    foreach ($featureName in @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')) {
        $state = Get-WslOptionalFeatureState -FeatureName $featureName
        if ($state) {
            $status.Features[$featureName] = $state
        }
    }

    return $status
}

function Test-WslPlatformReady {
    param([hashtable]$PlatformStatus)

    if (-not $PlatformStatus.WslExeAvailable) {
        return $false
    }
    if ($PlatformStatus.WslVersionText -notmatch 'WSL version') {
        return $false
    }
    if ($PlatformStatus.DefaultVersion -and $PlatformStatus.DefaultVersion -ne '2') {
        return $false
    }

    $wslFeature = $PlatformStatus.Features['Microsoft-Windows-Subsystem-Linux']
    $vmpFeature = $PlatformStatus.Features['VirtualMachinePlatform']
    if ($wslFeature -and $wslFeature -ne 'Enabled') {
        return $false
    }
    if ($vmpFeature -and $vmpFeature -ne 'Enabled') {
        return $false
    }

    return $true
}

function Enable-WslWindowsFeatures {
    Write-InstallStep "Enabling Windows optional features for WSL2"
    $needsReboot = $false
    foreach ($featureName in @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')) {
        $state = Get-WslOptionalFeatureState -FeatureName $featureName
        if ($state -eq 'Enabled') {
            Write-Host "  $featureName is already enabled."
            continue
        }
        Write-Host "  Enabling $featureName ..."
        $dismOutput = & dism.exe /online /enable-feature /featurename:$featureName /all /norestart 2>&1
        $dismOutput | ForEach-Object { Write-Host $_ }
        if ($LASTEXITCODE -ne 0) {
            Write-WslSelfHelp -Title "Could not enable Windows feature '$featureName'" -Steps @(
                "Run PowerShell as Administrator and try again.",
                "Or open 'Turn Windows features on or off' and enable 'Windows Subsystem for Linux' and 'Virtual Machine Platform' manually."
            ) -Links @(
                $Script:WslDocLinks.ManualInstall,
                $Script:WslDocLinks.Troubleshooting
            )
            throw "Failed to enable Windows feature '$featureName' (dism exit $LASTEXITCODE)."
        }
        $needsReboot = $true
    }
    return $needsReboot
}

function Install-WslPlatformComponents {
    Write-InstallStep "Installing WSL2 platform (kernel and components, no Linux distro yet)"
    if (Test-WslCliOption '--install') {
        wsl.exe --install --no-distribution 2>&1 | ForEach-Object { Write-Host $_ }
        if ($LASTEXITCODE -eq 0) {
            return $true
        }
        Write-InstallLog "wsl --install --no-distribution failed (exit $LASTEXITCODE); trying wsl --install."
    }
    wsl.exe --install 2>&1 | ForEach-Object { Write-Host $_ }
    return ($LASTEXITCODE -eq 0)
}

function Set-WslDefaultVersion2 {
    if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
        return
    }
    $statusText = (wsl.exe --status 2>&1 | Out-String)
    if ($statusText -match 'Default Version:\s*2\b') {
        return
    }
    Write-InstallStep "Setting WSL default version to 2"
    wsl.exe --set-default-version 2 2>&1 | ForEach-Object { Write-Host $_ }
}

function Get-ElevatedInstallCommand {
    $installPath = Join-Path $Script:RepoRoot 'install.ps1'
    return "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','$installPath'"
}

function Get-AdminPowerShellSteps {
    return @(
        'You need an Administrator PowerShell window. Use ONE of these (neither needs "Run as administrator" on a right-click menu):'
        '  A) Start menu -> type PowerShell -> press Ctrl+Shift+Enter -> click Yes on the UAC prompt.'
        '  B) From this window, paste the "open admin PowerShell" command below (opens a new elevated window).'
        'In the admin window, go to this project folder and run install.ps1 (commands below).'
    )
}

function Continue-DespitePendingReboot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Reason
    )
    if (-not $Force) {
        Request-WindowsRebootAndStop -Reason $Reason
    }
    Write-Host ""
    Write-Host "  Warning: $Reason" -ForegroundColor Yellow
    Write-Host "  Continuing anyway (-Force). Install may fail until you restart Windows." -ForegroundColor Yellow
    Write-Host ""
    Write-InstallLog "Skipped reboot stop (-Force): $Reason"
}

function Request-WindowsRebootAndStop {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Reason
    )
    Write-WslSelfHelp -Title $Reason -Steps @(
        'Save your work and close other programs.'
        'Restart Windows (Start menu -> Power -> Restart).'
        'After login, open PowerShell as Administrator (Start menu -> type PowerShell -> Ctrl+Shift+Enter).'
        'Go to this project folder and run install.ps1 again (commands below).'
        'Cannot reboot yet? Re-run with -Force to try anyway (may fail until you restart).'
    ) -Commands @(
        "cd '$Script:RepoRoot'"
        'powershell -ExecutionPolicy Bypass -File .\install.ps1'
        'powershell -ExecutionPolicy Bypass -File .\install.ps1 -Force'
    ) -Links @(
        $Script:WslDocLinks.InstallGuide,
        $Script:WslDocLinks.ManualInstall
    )
    throw "Reboot Windows, then re-run install.ps1 from: $Script:RepoRoot"
}

function Request-AdministratorAndStop {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Reason
    )
    Write-WslSelfHelp -Title $Reason -Steps (Get-AdminPowerShellSteps) -Commands @(
        (Get-ElevatedInstallCommand)
        "cd '$Script:RepoRoot'"
        'powershell -ExecutionPolicy Bypass -File .\install.ps1'
    ) -Links @(
        $Script:WslDocLinks.InstallGuide,
        $Script:WslDocLinks.ExecutionPolicy
    )
    throw 'Re-run install.ps1 from an elevated (Administrator) PowerShell window.'
}

function Write-WslCommandFailureHelp {
    param([string]$OutputText)

    if ($OutputText -match 'getpwnam\(|CreateProcessParseCommon') {
        Write-WslSelfHelp -Title 'WSL default user in /etc/wsl.conf does not exist' -Steps @(
            'This usually means /etc/wsl.conf sets default=local (or another name) but that Linux user was never created.'
            'The installer will try to reset default=root on the next run after Repair-WslConfMissingDefaultUser.'
            'If it keeps failing: wsl -d Debian_Dune -u root'
            'Then: sed -i "s/^default=.*/default=root/" /etc/wsl.conf'
            'Then: wsl --shutdown'
            'Re-run install.ps1 and enter WSL username + password when prompted.'
        ) -Commands @(
            "wsl -d $WslDistro -u root"
            'wsl --shutdown'
            "cd '$Script:RepoRoot'"
            'powershell -ExecutionPolicy Bypass -File .\install.ps1'
        ) -Links @(
            (Join-Path $Script:RepoRoot 'WSL_README.md')
        )
        return $true
    }
    if ($OutputText -match '0x80370102|virtual machine platform|Virtual Machine Platform') {
        Write-WslSelfHelp -Title 'Virtualization or Virtual Machine Platform is not enabled' -Steps @(
            "Enable Intel VT-x / AMD-V in BIOS/UEFI if it is disabled.",
            "Run install.ps1 as Administrator so it can enable the Virtual Machine Platform Windows feature.",
            "On managed PCs, IT may need to allow virtualization."
        ) -Links @(
            $Script:WslDocLinks.Virtualization,
            $Script:WslDocLinks.Troubleshooting
        )
        return $true
    }
    if ($OutputText -match 'Docker Desktop WSL integration is not active|Docker Compose is not available through Docker Desktop|could not be found in this WSL|activate the WSL integration') {
        Write-DockerDesktopSelfHelp -Title "Docker Desktop WSL integration is OFF for '$WslDistro'"
        return $true
    }
    if ($OutputText -match 'registry\.funcom\.com.*no such host|lookup registry\.funcom\.com|registry\.funcom\.com.*failed to resolve') {
        Write-WslSelfHelp -Title 'Funcom images are not pulled from the public internet' -Steps @(
            'registry.funcom.com is a private Funcom registry tag name, not a public Docker Hub-style registry.'
            'Server images are downloaded via Steam and loaded locally: docker load -i *.tar (the update wizard does this).'
            'Boot auto-start failed because igw-postgres is not loaded yet - complete setup or run runtime/scripts/update.sh install inside WSL.'
            'WSL DNS was configured by install.ps1; this error usually means images are missing, not that DNS is wrong.'
            'If general DNS is broken inside WSL, add nameservers to .wsl/dns-servers.txt and re-run install.ps1.'
            'Docker Desktop pulls use the Desktop VM DNS; for full WSL control use: install.ps1 -ContainerRuntime docker'
        ) -Commands @(
            "wsl -d $WslDistro -- bash -lc 'cd ''$(ConvertTo-WslPath -WindowsPath $Script:RepoRoot)'' && docker images | grep funcom || true'"
            "wsl -d $WslDistro -- bash -lc 'cd ''$(ConvertTo-WslPath -WindowsPath $Script:RepoRoot)'' && runtime/scripts/update.sh install'"
            (Get-EmbeddedDockerInstallCommand)
        ) -Links @(
            (Join-Path $Script:RepoRoot 'WSL_README.md')
        )
        return $true
    }
    if ($OutputText -match 'pull access denied|failed to resolve|TLS handshake timeout|Error response from daemon.*pull|unable to fetch|network is unreachable|403 Forbidden|manifest unknown|Get "https://registry|i/o timeout|connection reset|short read|no such host') {
        Write-EmbeddedDockerEngineSelfHelp
        return $true
    }
    if ($OutputText -match 'WSL 2 requires an update|kernel component|Please update WSL') {
        Write-WslSelfHelp -Title 'WSL needs an update' -Steps @(
            "From an elevated PowerShell run: wsl --update",
            "Then run: wsl --shutdown",
            "Re-run: .\install.ps1"
        ) -Links @(
            $Script:WslDocLinks.UpdateWsl,
            $Script:WslDocLinks.Troubleshooting
        )
        return $true
    }
    if ($OutputText -match 'cannot find|is not registered|No such file|does not exist') {
        Write-WslSelfHelp -Title 'WSL distribution is missing or not registered' -Steps @(
            "Run install.ps1 without -SkipWslInstall to create the Debian WSL distro.",
            "List distros with: wsl -l -v",
            "See WSL_README.md for manual recovery steps."
        ) -Links @(
            $Script:WslDocLinks.InstallGuide,
            $Script:WslDocLinks.Troubleshooting
        )
        return $true
    }
    if ($OutputText -match 'permission denied|access is denied|sudo: a password is required') {
        Write-WslSelfHelp -Title 'Permission or sudo issue inside WSL' -Steps @(
            "Re-run install.ps1 so it can configure passwordless sudo for the install user.",
            "If you changed the WSL user, pass -WslUser and -WslPassword again."
        ) -Links @(
            (Join-Path $Script:RepoRoot 'WSL_README.md')
        )
        return $true
    }
    return $false
}

function Ensure-WslPlatform {
    Write-InstallStep "Checking Windows and WSL2 support"

    $support = Test-WindowsWslSupport
    Write-Host "  OS: $($support.OsCaption) (build $($support.BuildNumber), $($support.Architecture))"
    if (-not $support.Supported) {
        Write-WslSelfHelp -Title 'This PC does not meet WSL2 requirements' -Steps $support.Issues -Links @(
            $Script:WslDocLinks.SystemRequirements,
            $Script:WslDocLinks.InstallGuide
        )
        throw 'WSL2 is not supported on this system.'
    }

    $virt = Test-WslVirtualizationEnabled
    if ($virt -eq $false) {
        Write-WslSelfHelp -Title 'Hardware virtualization appears disabled' -Steps @(
            'Enable Intel VT-x or AMD-V in BIOS/UEFI firmware settings.',
            'Reboot into firmware (often Del, F2, or F10 at startup) and look for Virtualization Technology.',
            'If BIOS options are missing, your PC or corporate policy may block virtualization.'
        ) -Links @(
            $Script:WslDocLinks.Virtualization,
            $Script:WslDocLinks.Troubleshooting
        )
    }

    $platform = Get-WslPlatformStatus
    if ($platform.RebootRequired) {
        Continue-DespitePendingReboot -Reason 'Windows reboot is pending from a previous update or feature install'
    }

    if (Test-WslPlatformReady -PlatformStatus $platform) {
        Write-Host "  WSL2 platform is installed (default version: $($platform.DefaultVersion))."
        Set-WslDefaultVersion2
        return
    }

    if (-not (Test-IsAdministrator)) {
        Request-AdministratorAndStop -Reason 'Administrator privileges are required to install or enable WSL2 on this PC'
    }

    $wslFeature = $platform.Features['Microsoft-Windows-Subsystem-Linux']
    $vmpFeature = $platform.Features['VirtualMachinePlatform']
    $featuresNeedEnable = ($wslFeature -and $wslFeature -ne 'Enabled') -or ($vmpFeature -and $vmpFeature -ne 'Enabled')

    if ($featuresNeedEnable -or -not $platform.WslExeAvailable) {
        $rebootAfterFeatures = Enable-WslWindowsFeatures
        if ($rebootAfterFeatures) {
            Continue-DespitePendingReboot -Reason 'Windows must restart after enabling WSL optional features'
        }
        $platform = Get-WslPlatformStatus
    }

    if (-not (Test-WslPlatformReady -PlatformStatus $platform)) {
        if (-not (Install-WslPlatformComponents)) {
            Write-WslSelfHelp -Title 'Automatic WSL installation failed' -Steps @(
                'Confirm you are running PowerShell as Administrator.',
                'Run manually: wsl --install',
                'If prompted, reboot Windows and run install.ps1 again.',
                'Check Windows Update is current.'
            ) -Links @(
                $Script:WslDocLinks.InstallGuide,
                $Script:WslDocLinks.ManualInstall,
                $Script:WslDocLinks.Troubleshooting
            )
            throw "Could not install the WSL2 platform. See the links above."
        }
        Continue-DespitePendingReboot -Reason 'WSL2 platform was installed; Windows usually needs a restart before the Debian distro can be created'
    }

    Set-WslDefaultVersion2
    Write-Host "  WSL2 platform is ready."
}

function Get-WslHelpText {
    if (-not $Script:WslHelpText) {
        $Script:WslHelpText = (wsl.exe --help 2>&1 | Out-String)
    }
    return $Script:WslHelpText
}

function Test-WslCliOption {
    param([Parameter(Mandatory = $true)][string]$Option)
    return (Get-WslHelpText -match [regex]::Escape($Option))
}

function Export-ImportWslDistro {
    param(
        [Parameter(Mandatory = $true)][string]$SourceDistro,
        [Parameter(Mandatory = $true)][string]$TargetDistro,
        [Parameter(Mandatory = $true)][string]$InstallDir
    )
    Write-InstallStep "Relocating WSL via export/import (fallback): '$SourceDistro' -> '$TargetDistro'"
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

    $exportTar = Join-Path $Script:WslFolder ("distro-export-{0}.tar" -f ($TargetDistro -replace '\s', '-'))
    if (Test-Path -LiteralPath $exportTar) {
        Remove-Item -LiteralPath $exportTar -Force
    }

    wsl.exe --shutdown | Out-Null
    Start-Sleep -Seconds 2

    wsl.exe --export $SourceDistro $exportTar 2>&1 | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to export WSL distro '$SourceDistro'."
    }

    wsl.exe --unregister $SourceDistro 2>&1 | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to unregister WSL distro '$SourceDistro'."
    }

    if ($SourceDistro -ne $TargetDistro -and (Test-WslDistro -Distro $TargetDistro)) {
        wsl.exe --unregister $TargetDistro 2>&1 | Out-Null
    }

    wsl.exe --import $TargetDistro $InstallDir $exportTar --version 2 2>&1 | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to import WSL distro '$TargetDistro' into $InstallDir."
    }

    Remove-Item -LiteralPath $exportTar -Force
    wsl.exe --set-default $TargetDistro | Out-Null
}

function Move-WslDistroToInstallDir {
    param(
        [string]$TargetDistro = $WslDistro,
        [string]$InstallDir
    )
    if (Test-WslDistroAtInstallDir -Distro $TargetDistro -InstallDir $InstallDir) {
        Write-InstallLog "WSL distro '$TargetDistro' already located at $InstallDir"
        wsl.exe --set-default $TargetDistro | Out-Null
        return
    }

    if (-not (Test-WslDistro -Distro $TargetDistro)) {
        Write-WslSelfHelp -Title "WSL distro '$TargetDistro' is not installed" -Steps @(
            "Run install.ps1 without -SkipWslInstall to create it.",
            "List registered distros: wsl -l -v"
        ) -Links @(
            $Script:WslDocLinks.InstallGuide,
            $Script:WslDocLinks.Troubleshooting
        )
        throw "WSL distro '$TargetDistro' is not installed."
    }

    Write-InstallStep "Moving WSL distro '$TargetDistro' to $InstallDir"
    wsl.exe --shutdown | Out-Null
    Start-Sleep -Seconds 2

    if (Test-WslCliOption '--manage') {
        wsl.exe --manage $TargetDistro --move $InstallDir 2>&1 | ForEach-Object { Write-Host $_ }
        if ($LASTEXITCODE -eq 0 -and (Test-WslDistroAtInstallDir -Distro $TargetDistro -InstallDir $InstallDir)) {
            wsl.exe --set-default $TargetDistro | Out-Null
            return
        }
        Write-InstallLog "wsl --manage --move failed or is unavailable; falling back to export/import."
    }

    Export-ImportWslDistro -SourceDistro $TargetDistro -TargetDistro $TargetDistro -InstallDir $InstallDir
}

function Install-WslDistro {
    param(
        [string]$Package = $Script:WslDistroPackage,
        [string]$Name = $WslDistro,
        [string]$InstallDir
    )
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Write-InstallStep "Installing WSL package '$Package' as '$Name'"

    $installArgs = New-Object 'System.Collections.Generic.List[string]'
    [void]$installArgs.Add('--install')
    [void]$installArgs.Add('-d')
    [void]$installArgs.Add($Package)
    [void]$installArgs.Add('--no-launch')
    if (Test-WslCliOption '--name') {
        [void]$installArgs.Add('--name')
        [void]$installArgs.Add($Name)
    }
    if (Test-WslCliOption '--location') {
        [void]$installArgs.Add('--location')
        [void]$installArgs.Add($InstallDir)
    }
    $installArgArray = $installArgs.ToArray()

    wsl.exe @installArgArray 2>&1 | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) {
        wsl.exe --install $Package --no-launch 2>&1 | ForEach-Object { Write-Host $_ }
    }
    if ($LASTEXITCODE -ne 0) {
        Write-WslSelfHelp -Title "Could not install WSL Linux package '$Package'" -Steps @(
            "Confirm WSL2 is installed: wsl --version",
            "Update WSL: wsl --update (run PowerShell as Administrator)",
            "If Windows asked for a reboot after WSL setup, restart first.",
            "Install Debian manually: wsl --install -d Debian",
            "Then re-run install.ps1"
        ) -Links @(
            $Script:WslDocLinks.InstallGuide,
            $Script:WslDocLinks.ManualInstall,
            $Script:WslDocLinks.Troubleshooting
        )
        throw "Could not install WSL package '$Package'. See the self-help steps above."
    }

    if (Test-WslDistro -Distro $Name) {
        if (-not (Test-WslDistroAtInstallDir -Distro $Name -InstallDir $InstallDir)) {
            Move-WslDistroToInstallDir -TargetDistro $Name -InstallDir $InstallDir
        }
        wsl.exe --set-default $Name | Out-Null
        return
    }

    if (Test-WslDistro -Distro $Package) {
        Export-ImportWslDistro -SourceDistro $Package -TargetDistro $Name -InstallDir $InstallDir
        return
    }

    throw "WSL install finished but distro '$Name' was not registered. Run: wsl -l -v"
}

function Initialize-WslDistro {
    param(
        [string]$TargetDistro = $WslDistro,
        [string]$InstallDir
    )
    if ($SkipWslInstall) {
        if (-not (Test-WslDistro -Distro $TargetDistro)) {
            Write-WslSelfHelp -Title "WSL distro '$TargetDistro' is not installed" -Steps @(
                "Remove -SkipWslInstall and run install.ps1 again to create it automatically.",
                "Or install Debian manually: wsl --install -d Debian",
                "List distros: wsl -l -v"
            ) -Links @(
                $Script:WslDocLinks.InstallGuide,
                $Script:WslDocLinks.Troubleshooting
            )
            throw "WSL distro '$TargetDistro' is not installed."
        }
        if (-not (Test-WslDistroAtInstallDir -Distro $TargetDistro -InstallDir $InstallDir)) {
            Write-WslSelfHelp -Title "WSL distro '$TargetDistro' is not at the expected install directory" -Steps @(
                "Run install.ps1 without -SkipWslInstall to relocate the distro to:",
                "  $InstallDir",
                "Or pass -WslDistroDir with the correct path."
            ) -Links @(
                (Join-Path $Script:RepoRoot 'WSL_README.md')
            )
            throw "WSL distro '$TargetDistro' is not at $InstallDir."
        }
        wsl.exe --set-default $TargetDistro | Out-Null
        return
    }

    if (Test-WslDistroAtInstallDir -Distro $TargetDistro -InstallDir $InstallDir) {
        wsl.exe --set-default $TargetDistro | Out-Null
        return
    }

    if (Test-WslDistro -Distro $TargetDistro) {
        Move-WslDistroToInstallDir -TargetDistro $TargetDistro -InstallDir $InstallDir
        return
    }

    if (Test-WslDistro -Distro $Script:WslDistroPackage) {
        Export-ImportWslDistro -SourceDistro $Script:WslDistroPackage -TargetDistro $TargetDistro -InstallDir $InstallDir
        return
    }

    Install-WslDistro -Package $Script:WslDistroPackage -Name $TargetDistro -InstallDir $InstallDir
}

function Test-WslDistro {
    param([string]$Distro = $WslDistro)
    wsl.exe -d $Distro -- echo ok 2>$null | Out-Null
    return $LASTEXITCODE -eq 0
}

function Set-WslSystemd {
    param([string]$Distro = $WslDistro)
    $check = Join-BashScriptLines `
        'if test -f /etc/wsl.conf && grep -q ''^systemd=true'' /etc/wsl.conf 2>/dev/null; then' `
        '  echo configured' `
        'else' `
        '  echo needs-config' `
        'fi'
    $status = (Invoke-WslAsInstallUser -Distro $Distro -Command $check).Trim()
    if ($status -eq 'configured') {
        return
    }
    Write-InstallStep "Enabling systemd inside WSL (required for Podman/Docker services)."
    $wslBootSection = [string][char]91 + 'boot' + [char]93
    $bootPrintfLine = '  printf ''%s\n'' ''{0}'' ''systemd=true'' | sudo tee -a /etc/wsl.conf >/dev/null' -f $wslBootSection
    $configure = Join-BashScriptLines `
        'set -euo pipefail' `
        ("if test -f /etc/wsl.conf && grep -q '^{0}' /etc/wsl.conf; then" -f $wslBootSection) `
        '  if grep -q ''^systemd=true'' /etc/wsl.conf; then' `
        '    exit 0' `
        '  fi' `
        ("  sudo sed -i '/^{0}/a systemd=true' /etc/wsl.conf" -f $wslBootSection) `
        'else' `
        $bootPrintfLine `
        'fi'
    Invoke-WslAsInstallUser -Distro $Distro -Command $configure | Out-Null
    Write-InstallStep "Restarting WSL to apply systemd setting."
    wsl.exe --shutdown | Out-Null
    Start-Sleep -Seconds 3
    Invoke-WslAsInstallUser -Distro $Distro -Command 'echo WSL restarted.' | Out-Null
}

function ConvertTo-WslPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$WindowsPath,
        [string]$Distro = $WslDistro
    )
    $fullPath = [System.IO.Path]::GetFullPath($WindowsPath)

    # Map D:\foo\bar -> /mnt/d/foo/bar locally. Avoids wslpath: bash eats \w, \d, etc. in args.
    if ($fullPath -match '^([A-Za-z]):[\\/](.*)$') {
        $drive = $Matches[1].ToLowerInvariant()
        $rest = ($Matches[2] -replace '\\', '/')
        return "/mnt/$drive/$rest"
    }

    if (Test-WslDistro -Distro $Distro) {
        $pathForWsl = $fullPath -replace '\\', '/'
        $prevErrorAction = $ErrorActionPreference
        $ErrorActionPreference = 'SilentlyContinue'
        try {
            $wslPathOutput = & wsl.exe -d $Distro -- wslpath -a $pathForWsl 2>$null
        }
        finally {
            $ErrorActionPreference = $prevErrorAction
        }
        if ($LASTEXITCODE -eq 0) {
            $wslPath = if ($wslPathOutput -is [array]) {
                ($wslPathOutput -join [Environment]::NewLine)
            }
            else {
                [string]$wslPathOutput
            }
            $wslPath = $wslPath.Trim()
            if (-not [string]::IsNullOrWhiteSpace($wslPath)) {
                return ($wslPath -replace '\\', '/')
            }
        }
    }

    throw "Could not convert Windows path to WSL path: $WindowsPath"
}

function Resolve-WorkspaceDirRelative {
    $config = Get-InstallConfig
    if ($WorkspaceDir) {
        return $WorkspaceDir
    }
    if ($config -and $config.workspaceDirRelative) {
        return [string]$config.workspaceDirRelative
    }
    return $Script:DefaultWorkspaceDir
}

function Resolve-WorkspacePaths {
    param([string]$RelativeDir)
    $relative = $RelativeDir.Trim()
    if (-not $relative -or $relative -eq '.') {
        $windowsPath = $Script:RepoRoot
    }
    else {
        $windowsPath = Join-Path $Script:RepoRoot ($relative -replace '/', [IO.Path]::DirectorySeparatorChar)
    }
    $wslPath = ConvertTo-WslPath -WindowsPath $windowsPath
    return @{
        Relative = if ($relative) { $relative } else { '.' }
        Windows  = $windowsPath
        Wsl      = ($wslPath -replace '\\', '/')
    }
}

function Initialize-Workspace {
    param(
        [hashtable]$Paths,
        [string]$Distro = $WslDistro
    )
    if ($Paths.Relative -eq '.wsl/workspace') {
        Write-InstallStep "Preparing optional nested workspace at .wsl/workspace"
        $workspaceWindows = Join-Path $Script:WslFolder 'workspace'
        if (-not (Test-Path -LiteralPath $workspaceWindows)) {
            New-Item -ItemType Directory -Path $workspaceWindows -Force | Out-Null
        }
        $cloneCmd = Join-BashScriptLines `
            'set -euo pipefail' `
            "mkdir -p '$($Paths.Wsl)'" `
            "if test ! -d '$($Paths.Wsl)/.git'; then" `
            "  git clone '$RepoUrl' '$($Paths.Wsl)'" `
            'else' `
            "  echo 'Workspace clone already exists.'" `
            'fi'
        Invoke-WslAsInstallUser -Distro $Distro -Command $cloneCmd | ForEach-Object { Write-Host $_ }
    }
    elseif (-not (Test-Path -LiteralPath $Paths.Windows)) {
        throw "Workspace path does not exist: $($Paths.Windows)"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Script:RepoRoot 'install.sh'))) {
        throw "install.sh was not found in $Script:RepoRoot. Run this script from the repository root."
    }
}

function Get-ContainerRuntime {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ConfiguredRuntime,
        [string]$Distro = $WslDistro,
        [string]$WorkspaceWsl
    )
    $detect = @"
set -euo pipefail
cd '$WorkspaceWsl'
configured='$ConfiguredRuntime'
if docker info --format '{{.OperatingSystem}}' 2>/dev/null | grep -qi 'docker desktop'; then
  echo docker-desktop
elif [ "`$configured" = podman ] && podman info >/dev/null 2>&1; then
  echo podman
elif [ "`$configured" = docker ] && docker info >/dev/null 2>&1; then
  echo docker
elif podman info >/dev/null 2>&1; then
  echo podman
elif docker info >/dev/null 2>&1; then
  echo docker
else
  echo unknown
fi
"@
    return (Invoke-WslAsInstallUser -Distro $Distro -Command $detect).Trim()
}

function Invoke-GitPull {
    param(
        [string]$WorkspaceWsl,
        [string]$Distro = $WslDistro
    )
    Write-InstallStep "Pulling latest changes"
    $pull = @"
set -euo pipefail
cd '$WorkspaceWsl'
git pull --ff-only
"@
    Invoke-WslAsInstallUser -Distro $Distro -Command $pull | ForEach-Object { Write-Host $_ }
    Write-InstallBanner "Updated. Shell script changes are live via the repo mount."
    Write-InstallBanner "Use update.ps1 -RebuildConsole or -RebuildOrchestrator if Dockerfiles or bundled web/admin code changed."
}

function Invoke-WslInstall {
    param(
        [hashtable]$Paths,
        [string]$Distro = $WslDistro,
        [string]$ContainerRuntime = 'docker'
    )
    $prepareScripts = @"
set -euo pipefail
cd '$($Paths.Wsl)'
chmod +x runtime/scripts/wsl-bootstrap.sh install.sh runtime/scripts/*.sh 2>/dev/null || true
echo 'Scripts are executable.'
"@
    Write-InstallStep "Preparing install scripts inside WSL"
    Invoke-WslAsInstallUser -Distro $Distro -Command $prepareScripts -StreamOutput | Out-Null

    Write-InstallStep "WSL bootstrap: container runtime prep ($ContainerRuntime)"
    Write-InstallBanner "Live output from wsl-bootstrap.sh appears below."
    if ($ContainerRuntime -eq 'podman') {
        Write-InstallBanner "apt-get may pause while downloading indexes; more lines will appear as packages install."
    }
    elseif ($ContainerRuntime -eq 'docker-desktop') {
        Write-InstallBanner "Using Docker Desktop via WSL integration; containers will appear in the Docker Desktop UI."
        if (-not (Test-DockerDesktopWslIntegration -Distro $Distro)) {
            Write-DockerDesktopSelfHelp -Title "Docker Desktop WSL integration is OFF for '$Distro' (checked before bootstrap)"
            throw "Enable Docker Desktop -> Settings -> Resources -> WSL Integration for '$Distro', then re-run install.ps1."
        }
    }
    elseif ($ContainerRuntime -eq 'docker') {
        Write-InstallBanner "Using embedded Docker Engine (https://get.docker.com). Containers will NOT appear in Docker Desktop UI."
    }
    else {
        Write-InstallBanner "Embedded Docker Engine will be installed inside WSL if it is not already present."
    }
    $bootstrap = @"
set -euo pipefail
cd '$($Paths.Wsl)'
export DUNE_HOST_REPO_ROOT="`$(pwd -P)"
export DUNE_CONTAINER_RUNTIME='$ContainerRuntime'
export CONTAINER_RUNTIME='$ContainerRuntime'
./runtime/scripts/wsl-bootstrap.sh
"@
    Invoke-WslAsInstallUser -Distro $Distro -Command $bootstrap -StreamOutput | Out-Null

    Write-InstallStep "Running install.sh: container runtime, images, and console"
    Write-InstallBanner "Live output from install.sh appears below."
    Write-InstallBanner "Docker downloads use plain progress lines (easier to read in PowerShell)."
    $installSh = @"
set -euo pipefail
cd '$($Paths.Wsl)'
export DUNE_HOST_REPO_ROOT="`$(pwd -P)"
export DUNE_CONTAINER_RUNTIME='$ContainerRuntime'
export CONTAINER_RUNTIME='$ContainerRuntime'
export DUNE_INSTALL_FROM_WINDOWS=1
export ADMIN_BIND_HOST=0.0.0.0
export BUILDKIT_PROGRESS=plain
export COMPOSE_PROGRESS=plain
./install.sh
"@
    Invoke-WslAsInstallUser -Distro $Distro -Command $installSh -StreamOutput | Out-Null
}

function Test-ConsoleContainerRunning {
    param(
        [string]$Distro = $WslDistro,
        [string]$ContainerRuntime = 'docker'
    )
    $runtime = $ContainerRuntime
    if ($runtime -eq 'unknown') {
        $runtime = 'docker'
    }
    $check = @'
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx redblink-dune-docker-console; then
  echo running
elif sudo docker ps --format '{{.Names}}' 2>/dev/null | grep -qx redblink-dune-docker-console; then
  echo running
else
  echo missing
fi
'@
    $result = (Invoke-WslAsInstallUser -Distro $Distro -Command $check | Out-String).Trim()
    return ($result -eq 'running')
}

function Test-ConsoleHttpFromWindows {
    param([int]$Port = 8088)
    try {
        $null = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 8 -ErrorAction Stop
        return $true
    }
    catch {
        return $false
    }
}

function Show-Finish {
    param(
        [hashtable]$Paths,
        [string]$ContainerRuntime,
        [string]$Distro = $WslDistro
    )
    $finish = Join-BashScriptLines `
        'set -euo pipefail' `
        "cd '$($Paths.Wsl)'" `
        'export DUNE_HOST_REPO_ROOT="$(pwd -P)"' `
        'ip=$(hostname -I 2>/dev/null | head -1 | sed "s/ .*//" || true)' `
        'if test -z "$ip"; then ip=127.0.0.1; fi' `
        'port=${ADMIN_BIND_PORT:-8088}' `
        'password_file=runtime/secrets/admin-web-password.txt' `
        'password=' `
        'if test -r "$password_file" && test -s "$password_file"; then' `
        '  password=$(tr -d ''\r\n'' < "$password_file")' `
        'fi' `
        'echo "DUNE_CONSOLE_IP=$ip"' `
        'echo "DUNE_CONSOLE_PORT=$port"' `
        'echo "DUNE_CONSOLE_PASSWORD=$password"'
    $lines = Invoke-WslAsInstallUser -Distro $Distro -Command $finish
    $info = @{}
    foreach ($line in $lines) {
        if ($line -match '^([^=]+)=(.*)$') {
            $info[$Matches[1]] = $Matches[2]
        }
    }
    $port = if ($info['DUNE_CONSOLE_PORT']) { [int]$info['DUNE_CONSOLE_PORT'] } else { 8088 }
    $containerRunning = Test-ConsoleContainerRunning -Distro $Distro -ContainerRuntime $ContainerRuntime
    $httpReady = Test-ConsoleHttpFromWindows -Port $port

    Write-InstallBanner "Dune Docker Console - install finished"
    Write-Host ""
    Write-Host "================================================================" -ForegroundColor Green
    Write-Host "  WHAT TO DO NOW (read in order)" -ForegroundColor Green
    Write-Host "================================================================" -ForegroundColor Green
    Write-Host ""

    $stepNum = 1
    if ($Script:DockerDesktopNetworkRepairNeedsRestart) {
        Write-Host "  $stepNum. RESTART DOCKER AND WSL FIRST (network was fixed during install):" -ForegroundColor Yellow
        Write-Host "       - Quit Docker Desktop (tray whale icon -> Quit Docker Desktop)"
        Write-Host "       - Start Docker Desktop again and wait until running"
        Write-Host "       - In PowerShell run: wsl --shutdown"
        Write-Host "       - Then continue with the steps below (or re-run install.ps1)"
        Write-Host ""
        $stepNum++
    }

    Write-Host "  $stepNum. Open this address in your web browser (Chrome/Edge/Firefox on Windows):"
    Write-Host "       http://localhost:$port" -ForegroundColor Cyan
    Write-Host "       Do NOT use a 172.x.x.x address - use localhost only."
    Write-Host ""
    $stepNum++

    if ($info['DUNE_CONSOLE_PASSWORD']) {
        Write-Host "  $stepNum. Sign in with this admin password (copy it exactly):"
        Write-Host "       $($info['DUNE_CONSOLE_PASSWORD'])" -ForegroundColor Cyan
        Write-Host ""
        $stepNum++
        Write-Host "  $stepNum. Follow the setup wizard in the browser to finish server setup."
    }
    else {
        Write-Host "  $stepNum. Wait 30 seconds, then run install.ps1 again to print your admin password."
        Write-Host ""
        $stepNum++
        Write-Host "  $stepNum. Sign in at http://localhost:$port and follow the setup wizard."
    }
    Write-Host ""
    $stepNum++

    if ($ContainerRuntime -eq 'docker-desktop') {
        Write-Host "  $stepNum. Docker containers: open the Docker Desktop app (whale icon) -> Containers / Images."
        Write-Host "       Keep WSL integration ON for '$Distro' (Settings -> Resources -> WSL Integration)."
        Write-Host ""
        $stepNum++
    }

    Write-Host "================================================================" -ForegroundColor Green
    Write-Host "  IF SOMETHING IS WRONG" -ForegroundColor Green
    Write-Host "================================================================" -ForegroundColor Green
    Write-Host ""

    if (-not $containerRunning) {
        Write-Host "  Problem: Console container is not running." -ForegroundColor Yellow
        Write-Host "  Fix: Re-run install.ps1 from an Administrator PowerShell in this folder:"
        Write-Host "       cd '$Script:RepoRoot'"
        Write-Host "       powershell -ExecutionPolicy Bypass -File .\install.ps1"
        Write-Host ""
    }
    elseif (-not $httpReady) {
        Write-Host "  Problem: http://localhost:$port is not loading yet." -ForegroundColor Yellow
        Write-Host "  Fix: Wait 2 - 3 minutes (first build is slow), refresh the browser."
        Write-Host "       Still broken? Run: wsl --shutdown"
        Write-Host "       Then re-run install.ps1."
        Write-Host ""
    }

    if ($ContainerRuntime -eq 'docker-desktop') {
        Write-Host "  Docker Desktop cannot pull some images (hello-world OK, others fail)?"
        Write-Host "  -> Re-run with embedded Engine: $(Get-EmbeddedDockerInstallCommand)"
        Write-Host "  -> Uses https://get.docker.com inside WSL; containers stay in WSL (not Desktop UI)."
        Write-Host ""
        Write-Host "  Players stuck on ""Connecting"" in-game (server shows in browser)?"
        Write-Host "  -> Open WSL_README.md -> section ""Players stuck on Connecting"""
        Write-Host "  -> Run install.ps1 as Administrator (fixes VMware Bridge on vEthernet adapters)"
        Write-Host ""
    }

    Write-Host "  Full help:  $(Join-Path $Script:RepoRoot 'WSL_README.md')"
    Write-Host "  Install log: $($Script:InstallLogPath)"
    Write-Host ""
    Write-Host "  Details: runtime=$ContainerRuntime | WSL=$Distro | user=$Script:WslUserName"
    if ($info['DUNE_CONSOLE_IP'] -and $info['DUNE_CONSOLE_IP'] -ne '127.0.0.1') {
        Write-Host "  (Ignore for browser: WSL-only IP http://$($info['DUNE_CONSOLE_IP']):$port )"
    }
}

function Write-InstallState {
    param(
        [hashtable]$Paths,
        [string]$ContainerRuntime,
        [string]$Distro = $WslDistro
    )
    Set-InstallConfig -Config @{
        wslDistro            = $Distro
        wslDistroInstallDir  = (Resolve-WslDistroInstallDir)
        wslUser              = $Script:WslUserName
        repoRootWindows      = $Script:RepoRoot
        repoRootWsl          = (ConvertTo-WslPath -WindowsPath $Script:RepoRoot)
        workspaceDirRelative = $Paths.Relative
        workspaceDirWsl      = $Paths.Wsl
        containerRuntime     = $ContainerRuntime
        repoUrl              = $RepoUrl
        installedAt          = (Get-Date).ToUniversalTime().ToString('o')
    }
}

# --- Main ---

Write-InstallBanner "Starting Dune Docker Console Windows Installer."
Show-InstallPreflightChecklist

if (-not (Test-Path -LiteralPath (Join-Path $Script:RepoRoot 'install.sh'))) {
    Write-WslSelfHelp -Title 'Wrong folder - run install.ps1 from the repository root' -Steps @(
        'The file install.sh must be in the same folder as install.ps1.'
        'Open File Explorer and go to the folder where you cloned or extracted this project.'
        'Shift + right-click in that folder -> Open PowerShell window here (or use cd in PowerShell).'
        'Run install.ps1 from that folder (command below).'
    ) -Commands @(
        "cd '$Script:RepoRoot'"
        'powershell -ExecutionPolicy Bypass -File .\install.ps1'
    ) -Footer 'If install.sh is missing, re-clone or re-download the full repository.'
    throw "Run install.ps1 from the repository root (install.sh must be present)."
}

Initialize-WslFolder
Ensure-WslPlatform

if ($Update) {
    $config = Get-InstallConfig
    if (-not $config) {
        Write-WslSelfHelp -Title 'No prior Windows install state found' -Steps @(
            'Run install.ps1 without -Update for the first-time setup.',
            'That creates .wsl/install.json and provisions WSL.'
        ) -Links @(
            (Join-Path $Script:RepoRoot 'WSL_README.md'),
            $Script:WslDocLinks.InstallGuide
        )
        throw 'No .wsl/install.json found. Run install.ps1 without -Update first.'
    }
    if ($config.wslUser) {
        $Script:WslUserName = [string]$config.wslUser
    }
    $paths = Resolve-WorkspacePaths -RelativeDir (Resolve-WorkspaceDirRelative)
    if ($WorkspaceDir) {
        $paths = Resolve-WorkspacePaths -RelativeDir $WorkspaceDir
    }
    Invoke-GitPull -WorkspaceWsl $paths.Wsl
    exit 0
}

$wslDistroInstallDir = Resolve-WslDistroInstallDir
Initialize-WslDistro -InstallDir $wslDistroInstallDir
Repair-WslConfMissingDefaultUser
$existingConfig = Get-InstallConfig
$candidateUser = if ($WslUser) { $WslUser.Trim() } elseif ($existingConfig -and $existingConfig.wslUser) { [string]$existingConfig.wslUser } else { '' }
$userMissingInWsl = [bool]($candidateUser -and -not (Test-WslLinuxUserExists -User $candidateUser))
$needsUserSetup = (-not $existingConfig) -or (-not $existingConfig.wslUser) -or $userMissingInWsl -or $PSBoundParameters.ContainsKey('WslPassword') -or (
    $WslUser -and ($existingConfig -and [string]$existingConfig.wslUser -ne $WslUser.Trim())
)
if ($userMissingInWsl) {
    Write-InstallStep "WSL user '$candidateUser' is saved but missing inside $WslDistro - will recreate it."
}
Resolve-WslCredentials -RequirePassword:$needsUserSetup
Initialize-WslLinuxUser
Set-WslInstallUserSudo
Set-WslSystemd
Initialize-WslDns

$paths = Resolve-WorkspacePaths -RelativeDir (Resolve-WorkspaceDirRelative)
Initialize-Workspace -Paths $paths

$resolvedRuntime = Resolve-ContainerRuntime
Write-InstallStep "Container runtime: $resolvedRuntime ($((Get-ContainerRuntimeDescription -Runtime $resolvedRuntime)))"
if ($resolvedRuntime -eq 'docker') {
    Write-InstallBanner "Embedded Docker Engine mode: installs via https://get.docker.com inside WSL."
    Write-InstallBanner "Use this when Docker Desktop hello-world works but other image pulls fail."
}
if ($resolvedRuntime -eq 'docker-desktop') {
    Initialize-DockerDesktopForWsl -Distro $WslDistro
    $networkRepair = Ensure-DockerDesktopNetworkAdapters
    if ($networkRepair.NeedsRestart) {
        $Script:DockerDesktopNetworkRepairNeedsRestart = $true
    }
}
Invoke-WslInstall -Paths $paths -ContainerRuntime $resolvedRuntime
$runtime = Get-ContainerRuntime -ConfiguredRuntime $resolvedRuntime -WorkspaceWsl $paths.Wsl
Write-InstallState -Paths $paths -ContainerRuntime $runtime
Show-Finish -Paths $paths -ContainerRuntime $runtime

Write-InstallLog "Install completed successfully."

$Script:WslPasswordPlain = ''

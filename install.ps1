#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$WslDistro = 'Debian_Dune',
    [string]$WslDistroDir = '',
    [string]$WslUser = '',
    [string]$WslPassword = '',
    [string]$WorkspaceDir = '',
    [string]$RepoUrl = 'https://github.com/Red-Blink/dune-awakening-selfhost-docker.git',
    [ValidateSet('docker', 'podman', '')]
    [string]$ContainerRuntime = '',
    [switch]$SkipWslInstall,
    [switch]$Update
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
$Script:WslDocLinks = @{
    InstallGuide         = 'https://learn.microsoft.com/en-us/windows/wsl/install'
    ManualInstall        = 'https://learn.microsoft.com/en-us/windows/wsl/install-manual'
    Troubleshooting      = 'https://learn.microsoft.com/en-us/windows/wsl/troubleshooting'
    UpdateWsl            = 'https://learn.microsoft.com/en-us/windows/wsl/basic-commands#update-wsl'
    Virtualization       = 'https://learn.microsoft.com/en-us/windows/wsl/troubleshooting#error-0x80370102-the-virtual-machine-platform-is-not-enabled'
    SystemRequirements   = 'https://learn.microsoft.com/en-us/windows/wsl/install-manual#step-2---check-requirements-for-running-wsl-2'
    SetDefaultVersion    = 'https://learn.microsoft.com/en-us/windows/wsl/basic-commands#set-default-version-to-wsl-1-or-wsl-2'
    ExecutionPolicy      = 'https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies'
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
    if ($ContainerRuntime) {
        return $ContainerRuntime
    }
    $config = Get-InstallConfig
    if ($config -and $config.containerRuntime) {
        return [string]$config.containerRuntime
    }
    return 'docker'
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

function Write-WslStreamLine {
    param([string]$Line)
    if ([string]::IsNullOrWhiteSpace($Line)) {
        return
    }
    Write-Host $Line
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
            $ErrorActionPreference = $prevErrorAction
        }
        if ($LASTEXITCODE -ne 0) {
            $joined = ($lines -join [Environment]::NewLine)
            Write-WslCommandFailureHelp -OutputText $joined
            throw ('WSL command failed (exit {0}): {1}{2}{3}' -f $LASTEXITCODE, $Command, [Environment]::NewLine, $joined)
        }
        return $lines
    }

    $output = & wsl.exe @wslArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
        $outputText = if ($output -is [array]) { ($output -join [Environment]::NewLine) } else { [string]$output }
        Write-WslCommandFailureHelp -OutputText $outputText
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

function Read-WslPasswordPlain {
    $secure = Read-Host 'WSL password' -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    }
    finally {
        if ($bstr -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
    }
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

    if ($WslPassword) {
        $Script:WslPasswordPlain = $WslPassword
        return
    }
    if ($RequirePassword) {
        $Script:WslPasswordPlain = Read-WslPasswordPlain
        return
    }
    if ($config -and $config.wslUser -eq $Script:WslUserName) {
        return
    }
    $Script:WslPasswordPlain = Read-WslPasswordPlain
}

function Initialize-WslLinuxUser {
    param(
        [string]$Distro = $WslDistro,
        [string]$User = $Script:WslUserName,
        [string]$Password = $Script:WslPasswordPlain
    )
    if (-not $Password) {
        return
    }

    Write-InstallStep "Configuring WSL user: $User"
    $userB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($User))
    $passB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Password))
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
    Write-InstallStep "Ensuring passwordless sudo for WSL install user: $User"
    $enableSudoPath = Join-Path $Script:RepoRoot 'runtime/scripts/enable-wsl-install-sudo.sh'
    $enableSudo = Get-Content -LiteralPath $enableSudoPath -Raw
    $enableSudo = $enableSudo -replace '__USER__', $User
    Invoke-WslBashScript -Distro $Distro -User root -ScriptContent $enableSudo -ScriptName 'enable-wsl-install-sudo.sh' | Out-Null
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
    return Join-Path $Script:WslFolder 'distro' $WslDistro
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
        [string[]]$Links = @()
    )
    Write-Host ""
    Write-Host "=== $Title ===" -ForegroundColor Yellow
    foreach ($step in $Steps) {
        Write-Host "  - $step"
    }
    if ($Links.Count -gt 0) {
        Write-Host ""
        Write-Host "Helpful links:"
        foreach ($link in $Links) {
            Write-Host "  $link"
        }
    }
    Write-Host ""
    Write-Host "Local guide: $(Join-Path $Script:RepoRoot 'WSL_README.md')"
    if (Test-Path -LiteralPath $Script:InstallLogPath) {
        Write-Host "Install log:   $($Script:InstallLogPath)"
    }
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

function Request-WindowsRebootAndStop {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Reason
    )
    Write-WslSelfHelp -Title $Reason -Steps @(
        "Save your work and restart Windows.",
        "After reboot, open PowerShell in this repository folder.",
        "Run: .\install.ps1"
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
    Write-WslSelfHelp -Title $Reason -Steps @(
        "Close this PowerShell window.",
        "Right-click PowerShell or Windows Terminal and choose 'Run as administrator'.",
        "cd '$Script:RepoRoot'",
        "Run: powershell -ExecutionPolicy Bypass -File .\install.ps1"
    ) -Links @(
        $Script:WslDocLinks.InstallGuide,
        $Script:WslDocLinks.ExecutionPolicy
    )
    throw "Re-run install.ps1 from an elevated PowerShell session."
}

function Write-WslCommandFailureHelp {
    param([string]$OutputText)

    if ($OutputText -match '0x80370102|virtual machine platform|Virtual Machine Platform') {
        Write-WslSelfHelp -Title 'Virtualization or Virtual Machine Platform is not enabled' -Steps @(
            "Enable Intel VT-x / AMD-V in BIOS/UEFI if it is disabled.",
            "Run install.ps1 as Administrator so it can enable the Virtual Machine Platform Windows feature.",
            "On managed PCs, IT may need to allow virtualization."
        ) -Links @(
            $Script:WslDocLinks.Virtualization,
            $Script:WslDocLinks.Troubleshooting
        )
        return
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
        return
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
        return
    }
    if ($OutputText -match 'permission denied|access is denied|sudo: a password is required') {
        Write-WslSelfHelp -Title 'Permission or sudo issue inside WSL' -Steps @(
            "Re-run install.ps1 so it can configure passwordless sudo for the install user.",
            "If you changed the WSL user, pass -WslUser and -WslPassword again."
        ) -Links @(
            (Join-Path $Script:RepoRoot 'WSL_README.md')
        )
    }
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
        Request-WindowsRebootAndStop -Reason 'Windows reboot is pending from a previous update or feature install'
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
            Request-WindowsRebootAndStop -Reason 'Windows must restart after enabling WSL optional features'
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
        Request-WindowsRebootAndStop -Reason 'WSL2 platform was installed; Windows usually needs a restart before the Debian distro can be created'
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

    if (Test-WslDistro -Distro $Distro) {
        $wslPath = (wsl.exe -d $Distro -- wslpath -a $fullPath 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($wslPath)) {
            return ($wslPath -replace '\\', '/')
        }
    }

    if ($fullPath -match '^([A-Za-z]):\\(.*)$') {
        $drive = $Matches[1].ToLowerInvariant()
        $rest = ($Matches[2] -replace '\\', '/')
        return "/mnt/$drive/$rest"
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
if [ "`$configured" = docker ] && docker info >/dev/null 2>&1; then
  echo docker
elif [ "`$configured" = podman ] && podman info >/dev/null 2>&1; then
  echo podman
elif docker info >/dev/null 2>&1; then
  echo docker
elif podman info >/dev/null 2>&1; then
  echo podman
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
    else {
        Write-InstallBanner "Docker Engine will be installed inside WSL if it is not already present."
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
    $installSh = @"
set -euo pipefail
cd '$($Paths.Wsl)'
export DUNE_HOST_REPO_ROOT="`$(pwd -P)"
export DUNE_CONTAINER_RUNTIME='$ContainerRuntime'
export CONTAINER_RUNTIME='$ContainerRuntime'
export DUNE_INSTALL_FROM_WINDOWS=1
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
    Write-InstallBanner "Dune Docker Console is ready."
    Write-Host ""
    $port = if ($info['DUNE_CONSOLE_PORT']) { [int]$info['DUNE_CONSOLE_PORT'] } else { 8088 }
    $containerRunning = Test-ConsoleContainerRunning -Distro $Distro -ContainerRuntime $ContainerRuntime
    $httpReady = Test-ConsoleHttpFromWindows -Port $port

    Write-Host "Open the Web UI from Windows in your browser:"
    Write-Host "  http://localhost:$port"
    Write-Host ""
    Write-Host "Use localhost from Windows (not the WSL-only IP). WSL forwards port $port to Windows automatically."
    if ($info['DUNE_CONSOLE_IP'] -and $info['DUNE_CONSOLE_IP'] -ne '127.0.0.1') {
        Write-Host "  WSL internal address (Linux-only, not for Windows browsers): http://$($info['DUNE_CONSOLE_IP']):$port"
    }
    Write-Host ""
    if (-not $containerRunning) {
        Write-Host "Warning: the console container is not running inside WSL."
        Write-Host "Re-run install.ps1 or start it manually inside WSL:"
        if ($ContainerRuntime -eq 'podman') {
            Write-Host "  export ADMIN_BIND_HOST=0.0.0.0 ADMIN_BIND_PORT=8088"
            Write-Host "  podman rm -f redblink-dune-docker-console 2>/dev/null"
            Write-Host "  podman-compose -f docker-compose.web.yml up -d --build --force-recreate redblink-dune-docker-console"
        }
        else {
            Write-Host "  export ADMIN_BIND_HOST=0.0.0.0 ADMIN_BIND_PORT=8088"
            Write-Host "  docker rm -f redblink-dune-docker-console 2>/dev/null"
            Write-Host "  docker compose -f docker-compose.web.yml up -d --build --force-recreate redblink-dune-docker-console"
        }
        Write-Host ""
        Write-Host "Troubleshooting: $(Join-Path $Script:RepoRoot 'WSL_README.md')"
        Write-Host ""
    }
    elseif (-not $httpReady) {
        Write-Host "Warning: localhost:$port is not responding from Windows yet."
        Write-Host "Wait a minute for the build to finish, then try again."
        Write-Host "If it still fails: wsl --shutdown (from PowerShell), reopen WSL, re-run install.ps1."
        Write-Host "Guide: $(Join-Path $Script:RepoRoot 'WSL_README.md')"
        Write-Host ""
    }
    Write-Host "Container runtime: $ContainerRuntime"
    Write-Host "WSL distro: $WslDistro"
    Write-Host "WSL user: $Script:WslUserName"
    Write-Host "Workspace (WSL): $($Paths.Wsl)"
    if ($info['DUNE_CONSOLE_PASSWORD']) {
        Write-Host ""
        Write-Host "Your first admin password:"
        Write-Host "  $($info['DUNE_CONSOLE_PASSWORD'])"
    }
    else {
        Write-Host ""
        Write-Host "Admin password was not ready yet. Wait a few seconds and run install.ps1 again to show it."
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
Write-Host "Self-help: WSL_README.md in this repo | Microsoft WSL docs: $($Script:WslDocLinks.InstallGuide)"

if (-not (Test-Path -LiteralPath (Join-Path $Script:RepoRoot 'install.sh'))) {
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
$existingConfig = Get-InstallConfig
$needsUserSetup = (-not $existingConfig) -or (-not $existingConfig.wslUser) -or [bool]$WslPassword -or (
    $WslUser -and ($existingConfig -and [string]$existingConfig.wslUser -ne $WslUser.Trim())
)
Resolve-WslCredentials -RequirePassword:$needsUserSetup
Initialize-WslLinuxUser
Set-WslInstallUserSudo
Set-WslSystemd

$paths = Resolve-WorkspacePaths -RelativeDir (Resolve-WorkspaceDirRelative)
Initialize-Workspace -Paths $paths

$resolvedRuntime = Resolve-ContainerRuntime
Write-InstallStep "Container runtime: $resolvedRuntime (inside WSL, not Docker Desktop on Windows)"
Invoke-WslInstall -Paths $paths -ContainerRuntime $resolvedRuntime
$runtime = Get-ContainerRuntime -ConfiguredRuntime $resolvedRuntime -WorkspaceWsl $paths.Wsl
Write-InstallState -Paths $paths -ContainerRuntime $runtime
Show-Finish -Paths $paths -ContainerRuntime $runtime

Write-InstallLog "Install completed successfully."

$Script:WslPasswordPlain = ''

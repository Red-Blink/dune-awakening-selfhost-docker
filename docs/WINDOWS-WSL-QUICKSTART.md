# Windows / WSL Quick Install

This path is for **Windows 11 Home** users who want to run the Linux server through **WSL2** and **Ubuntu 26.04**.

## 1. Confirm virtualization is enabled

Before installing WSL, confirm virtualization is enabled:

1. Press `Ctrl` + `Shift` + `Esc` to open **Task Manager**.
2. Select **Performance**.
3. Select **CPU**.
4. Confirm **Virtualization: Enabled**.

If virtualization is disabled, enable it in BIOS/UEFI first, then return to this guide.

## 2. Open PowerShell as Administrator

The Windows / WSL installer must be run from an **Administrative PowerShell** window.

To open PowerShell as Administrator:

1. Press the **Windows** key.
2. Type `PowerShell`.
3. Right-click **Windows PowerShell**.
4. Select **Run as administrator**.
5. Click **Yes** on the Windows security prompt.
6. Confirm the window title starts with **Administrator:**.

## 3. Install WSL2

In the Administrator PowerShell window, run:

```powershell
wsl --install --no-distribution
```

If Windows asks you to restart, restart the PC. After the restart, open **PowerShell as Administrator** again and run:

```powershell
wsl --update
wsl --set-default-version 2
wsl --status
```

## 4. Install Ubuntu 26.04

List the available WSL distributions:

```powershell
wsl --list --online
```

Install Ubuntu 26.04:

```powershell
wsl --install --distribution Ubuntu-26.04
```

If `Ubuntu-26.04` is not listed, install the closest available official Ubuntu 26.04 entry shown by `wsl --list --online`, then use that exact distribution name when running `install.ps1`.

## 5. Launch Ubuntu once and create the Linux user

Before running the Dune installer, start Ubuntu once:

```powershell
wsl -d Ubuntu-26.04
```

Ubuntu may ask you to create a Linux username and password. Complete that setup. The password will not show characters while you type; that is normal.

Inside Ubuntu, verify the user exists:

```bash
whoami
exit
```

If `whoami` prints your Linux username, continue.

## 6. Run the Dune Windows / WSL installer

Paste this command into the same Administrator PowerShell window:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force; $ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $root=Join-Path $env:USERPROFILE 'dune-awakening-selfhost-docker'; New-Item -ItemType Directory -Force -Path $root | Out-Null; Set-Location $root; $installer=Join-Path $root 'install.ps1'; Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/install.ps1' -OutFile $installer; powershell -NoProfile -ExecutionPolicy Bypass -File $installer -RepoUrl 'https://github.com/Red-Blink/dune-awakening-selfhost-docker.git' -RepoRef 'main'
```

Do not wrap this command in another `powershell -Command "..."` call. It is meant to be pasted directly into an already-open Administrator PowerShell window.

This command:

1. Creates `%USERPROFILE%\dune-awakening-selfhost-docker`.
2. Downloads `install.ps1` directly.
3. Runs the downloaded `install.ps1`.
4. The installer prepares WSL2, Ubuntu 26.04, Docker Engine inside Ubuntu, and delegates final server startup to the existing Linux `install.sh`.

For the full guide, see [WINDOWS-WSL-INSTALL.md](WINDOWS-WSL-INSTALL.md).

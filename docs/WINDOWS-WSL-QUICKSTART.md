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

## 4. Apply recommended WSL settings

These settings are recommended for the first install and same-PC Web UI access. They keep WSL in the default localhost-forwarding path so `http://localhost:8088` works from Windows after the Web console starts.

Recommended memory values:

| Physical RAM | Suggested WSL memory |
|---:|---:|
| 32 GB | 24 GB |
| 48 GB | 36 GB |
| 64 GB | 48 GB |
| 96 GB+ | 64 GB |

Open the WSL config file:

```powershell
notepad "$env:USERPROFILE\.wslconfig"
```

Paste this example, then adjust `memory` and `processors` for your machine:

```ini
[wsl2]
localhostForwarding=true
memory=32GB
processors=8
```

Save the file, close Notepad, then fully restart WSL:

```powershell
wsl --shutdown
```

If your PC has less than 48 GB RAM, lower `memory` before continuing. Do not allocate all system memory to WSL; leave enough RAM for Windows.

Do not add `networkingMode=mirrored` for the first end-to-end install test. Mirrored networking is useful for some LAN setups, but it changes how Windows reaches WSL services and can make `localhost:8088` troubleshooting harder.

## 5. Install Ubuntu 26.04

List the available WSL distributions:

```powershell
wsl --list --online
```

Install Ubuntu 26.04:

```powershell
wsl --install --distribution Ubuntu-26.04
```

If `Ubuntu-26.04` is not listed, install the closest available official Ubuntu 26.04 entry shown by `wsl --list --online`, then use that exact distribution name when running `install.ps1`.

## 6. Launch Ubuntu once and create the Linux user

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

## 7. Run the Dune Windows / WSL installer

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

## 8. Get the Web UI admin password

The Web UI admin password is stored in persistent Ubuntu host storage:

```text
~/dune-awakening-selfhost-docker/runtime/secrets/admin-web-password.txt
```

Docker image rebuilds, container recreates, and `docker compose down` do not delete this file. That is intentional so normal restarts do not rotate the admin password.

To print the current password from PowerShell:

```powershell
Write-Host "Admin Web UI password:"
wsl -d Ubuntu-26.04 -- bash -lc "cat ~/dune-awakening-selfhost-docker/runtime/secrets/admin-web-password.txt"
```

If you intentionally need to rotate the Web UI admin password, move aside only `admin-web-password.txt`, then recreate the Web UI container so a new file is generated. Do not remove the whole `runtime/secrets` directory, because it may contain other secrets, including the Funcom token.

## 9. If `localhost:8088` does not open

First verify the Web console is running inside Ubuntu:

```powershell
wsl -d Ubuntu-26.04 -- bash -lc 'ss -ltnp | grep 8088 || true'
wsl -d Ubuntu-26.04 -- bash -lc 'curl -i http://127.0.0.1:8088/api/health || true'
```

If Ubuntu returns `HTTP/1.1 200 OK` but Windows cannot connect to `localhost:8088`, the Web UI is healthy and Windows localhost forwarding is the broken layer. Confirm from Windows:

```powershell
Test-NetConnection localhost -Port 8088
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8088/api/health
```

If those Windows tests fail while the WSL health check passes, refresh Windows' explicit forwarding rule to the current WSL IP. Run this from **PowerShell as Administrator**:

```powershell
$wslIp = (wsl -d Ubuntu-26.04 -- bash -lc "hostname -I").Trim().Split(" ", [System.StringSplitOptions]::RemoveEmptyEntries)[0]

netsh interface portproxy delete v4tov4 listenaddress=127.0.0.1 listenport=8088 2>$null
netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=8088 connectaddress=$wslIp connectport=8088

netsh interface portproxy show all
Test-NetConnection 127.0.0.1 -Port 8088
```

Then open:

```text
http://127.0.0.1:8088
```

WSL IP addresses can change after `wsl --shutdown` or a Windows restart. If the Web UI works inside Ubuntu but stops loading from Windows again, re-run the portproxy block above.

If the WSL health check fails too, restart only the Web UI container before recreating anything:

```powershell
wsl -d Ubuntu-26.04 -- bash -lc 'docker restart redblink-dune-docker-console && sleep 5 && curl -i http://127.0.0.1:8088/api/health'
```

Only recreate the Web UI container if the restart still fails:

```powershell
wsl -d Ubuntu-26.04 -- bash -lc 'cd ~/dune-awakening-selfhost-docker && ADMIN_BIND_PORT=8088 docker compose -f docker-compose.web.yml up -d --force-recreate --build redblink-dune-docker-console && sleep 5 && curl -i http://127.0.0.1:8088/api/health'
```

For the full guide and advanced LAN notes, see [WINDOWS-WSL-INSTALL.md](WINDOWS-WSL-INSTALL.md).

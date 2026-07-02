# Windows 11 Home + WSL2 + Ubuntu 26.04 Install Guide

This guide explains how to install Dune Docker Console on a fresh **Windows 11 Home** machine using **WSL2**, **Ubuntu 26.04**, and **Docker Engine inside Ubuntu**.

Windows 11 Home can run WSL2. Windows Pro is not required.

The Windows path is:

1. Confirm virtualization is enabled.
2. Install WSL2 on Windows.
3. Apply recommended WSL resource and localhost-forwarding settings.
4. Install Ubuntu 26.04 as the WSL distribution.
5. Launch Ubuntu once and create the Linux username/password.
6. Enable `systemd` in Ubuntu.
7. Install Docker Engine and Docker Compose inside Ubuntu.
8. Clone this repository inside Ubuntu.
9. Run the existing Linux `install.sh` from inside Ubuntu.
10. Open the Web UI from Windows at `http://localhost:8088`.

The repository's Linux installer remains the source of truth for starting Dune Docker Console. The PowerShell script prepares Windows/WSL and then delegates to `install.sh`.

For exact steps to launch PowerShell with admin rights, see [ADMIN-POWERSHELL.md](ADMIN-POWERSHELL.md).

---

## What this installs

| Component | Location | Purpose |
|---|---|---|
| WSL2 | Windows | Runs Linux on Windows 11 Home |
| Ubuntu 26.04 | WSL distribution | Linux environment for the server tooling |
| Docker Engine | Inside Ubuntu | Runs the Dune Docker Console containers |
| Docker Compose plugin | Inside Ubuntu | Starts the compose stacks |
| Dune Docker Console | Inside Ubuntu home directory | Web console and server management tools |

This guide intentionally avoids Docker Desktop as the default path. Docker is installed **inside Ubuntu** so the Linux `install.sh` can run the same way it does on a normal Ubuntu host.

---

## Requirements

| Requirement | Plain explanation |
|---|---|
| Windows 11 Home | Supported for WSL2 |
| Virtualization enabled | Required for WSL2; check Task Manager > Performance > CPU |
| 200 GB+ free disk space | Recommended for game server files, images, generated data, and backups |
| 20 GB+ RAM | Minimum starting point; more maps require more memory |
| AVX/AVX2 CPU support | Required by the game server |
| Funcom self-host token | Entered during the Web UI setup wizard |
| Router access | Required only for public/internet hosting |

Recommended WSL memory allocation:

| Physical RAM | Suggested WSL memory |
|---:|---:|
| 32 GB | 24 GB |
| 48 GB | 36 GB |
| 64 GB | 48 GB |
| 96 GB+ | 64 GB |

Do not allocate all system memory to WSL. Leave enough RAM for Windows, browser sessions, antivirus, Discord, and remote administration tools.

---

## Recommended `.wslconfig`

For the first end-to-end install test, use the default WSL localhost-forwarding path. This is the simplest path for opening the Web UI from Windows at `http://localhost:8088`.

Open the WSL config file from PowerShell:

```powershell
notepad "$env:USERPROFILE\.wslconfig"
```

Paste this example, then adjust `memory` and `processors` for your machine:

```ini
[wsl2]
networkingMode=mirrored
localhostForwarding=true
firewall=true
memory=32GB
processors=8

```

Save the file, close Notepad, then fully restart WSL:

```powershell
wsl --shutdown
```

If you later need LAN-focused networking, see [Advanced WSL networking](#advanced-wsl-networking). Do not use mirrored networking for the first validation pass unless you are specifically testing LAN routing.

---

## Installation option A: Windows quick path

Use this option if you want the script to prepare Docker and the repository after you install WSL2 and Ubuntu.

### 1. Confirm virtualization is enabled

1. Press `Ctrl` + `Shift` + `Esc` to open **Task Manager**.
2. Select **Performance**.
3. Select **CPU**.
4. Confirm **Virtualization: Enabled**.

If virtualization is disabled, enable it in BIOS/UEFI first, then return to this guide.

### 2. Open PowerShell as Administrator

The Windows / WSL installer must be run from an **Administrative PowerShell** window.

To open PowerShell as Administrator:

1. Press the **Windows** key.
2. Type `PowerShell`.
3. Right-click **Windows PowerShell**.
4. Select **Run as administrator**.
5. Click **Yes** on the Windows security prompt.
6. Confirm the window title starts with **Administrator:**.

### 3. Install WSL2

In Administrator PowerShell:

```powershell
wsl --install --no-distribution
```

If Windows asks you to restart, restart the PC. After the restart, open **PowerShell as Administrator** again and run:

```powershell
wsl --update
wsl --set-default-version 2
wsl --status
```

### 4. Apply recommended WSL settings

Open:

```powershell
notepad "$env:USERPROFILE\.wslconfig"
```

Paste this default same-PC config:

```ini
[wsl2]
localhostForwarding=true
memory=32GB
processors=8
```

Adjust `memory` and `processors`, save the file, then run:

```powershell
wsl --shutdown
```

### 5. Install Ubuntu 26.04

List available WSL distributions:

```powershell
wsl --list --online
```

Install Ubuntu 26.04:

```powershell
wsl --install --distribution Ubuntu-26.04
```

If `Ubuntu-26.04` is not listed, install the closest available official Ubuntu 26.04 entry shown by `wsl --list --online`, then pass that exact distribution name to `install.ps1` with `-WslDistro`.

### 6. Launch Ubuntu once and create the Linux user

Start Ubuntu:

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

### 7. Run the Windows installer

If you cloned the repository on Windows, go to that folder:

```powershell
cd C:\path\to\dune-awakening-selfhost-docker
```

Run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\install.ps1
```

The script will:

- validate WSL and the Ubuntu distribution;
- enable `systemd`;
- install Docker Engine inside Ubuntu using Docker's official apt repository;
- install the Docker Compose plugin;
- clone or update this repository inside Ubuntu;
- run `install.sh` inside Ubuntu;
- print the Web UI address.

### 8. Open the Web UI

From Windows, open:

```text
http://localhost:8088
```

If that does not work, see [FAQ / troubleshooting](#faq--troubleshooting).

---

## Installation option B: manual Windows + Ubuntu setup

Use this path if you prefer to see each step or if the PowerShell helper stops and asks you to finish something manually.

### 1. Install WSL

Open **PowerShell as Administrator** using the steps above, then run:

```powershell
wsl --install --no-distribution
```

Restart Windows if asked.

After restart, open **PowerShell as Administrator** again and run:

```powershell
wsl --update
wsl --set-default-version 2
wsl --status
```

### 2. Apply recommended WSL settings

Open:

```powershell
notepad "$env:USERPROFILE\.wslconfig"
```

Paste:

```ini
[wsl2]
localhostForwarding=true
memory=32GB
processors=8
```

Adjust `memory` and `processors`, save the file, then run:

```powershell
wsl --shutdown
```

### 3. Install Ubuntu 26.04

Check the exact distro name available on your machine:

```powershell
wsl --list --online
```

If `Ubuntu-26.04` is listed:

```powershell
wsl --install --distribution Ubuntu-26.04
```

If it is not listed, install the closest available official Ubuntu 26.04 entry shown by `wsl --list --online`, then use that exact distribution name when running the installer.

### 4. Open Ubuntu and create your Linux user

Start Ubuntu from the Start Menu or run:

```powershell
wsl -d Ubuntu-26.04
```

Create the Ubuntu username and password when asked.

When typing the password, the screen may not show dots or characters. That is normal.

### 5. Keep the server inside the Linux filesystem

Inside Ubuntu:

```bash
cd ~
pwd
```

The path should look like:

```text
/home/your-user-name
```

Do not install the server under `/mnt/c/Users/...`. Keep it under `/home/...` for Linux filesystem performance and to avoid Windows file-locking behavior.

### 6. Enable systemd

Inside Ubuntu:

```bash
ps -p 1 -o comm=
```

If the output is not `systemd`, run:

```bash
sudo nano /etc/wsl.conf
```

Paste:

```ini
[boot]
systemd=true
```

Save with `CTRL+O`, press `Enter`, then exit with `CTRL+X`.

Back in PowerShell:

```powershell
wsl --shutdown
wsl -d Ubuntu-26.04
```

### 7. Install Docker Engine inside Ubuntu

Inside Ubuntu:

```bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y ca-certificates curl gnupg lsb-release git nano iproute2 apt-transport-https
```

Remove conflicting old packages if present:

```bash
sudo apt remove -y docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc || true
```

Add Docker's official apt repository:

```bash
sudo install -m 0755 -d /etc/apt/keyrings

sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc

sudo chmod a+r /etc/apt/keyrings/docker.asc

sudo tee /etc/apt/sources.list.d/docker.sources > /dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt update
```

Install Docker:

```bash
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Start Docker:

```bash
sudo systemctl enable --now docker
sudo systemctl status docker --no-pager
```

Allow your Ubuntu user to run Docker:

```bash
sudo usermod -aG docker $USER
newgrp docker
```

Test Docker:

```bash
docker run hello-world
```

### 8. Clone the repository inside Ubuntu

Inside Ubuntu:

```bash
cd ~
git clone https://github.com/Red-Blink/dune-awakening-selfhost-docker.git
cd dune-awakening-selfhost-docker
```

If you are testing a fork, use the fork URL instead:

```bash
git clone https://github.com/yacketrj/dune-awakening-selfhost-docker-WSL.git
cd dune-awakening-selfhost-docker-WSL
```

### 9. Run the Linux installer

```bash
chmod +x install.sh
./install.sh
```

Press `Enter` when asked for the Web UI port to use the default `8088`.

At the end, copy the generated admin password and open the Web UI.

---

## Public hosting ports

Forward these ports only if players outside your PC or home network need to connect:

| Port | Protocol | Purpose |
|---|---:|---|
| `8088` | TCP | Web admin setup panel |
| `31982` | TCP | Game messaging |
| `7777-7810` | UDP | Game traffic |

Security recommendation:

- Do not expose `8088` to the public internet unless you fully understand the risk.
- Forward the game ports publicly only when needed.
- Keep database and internal admin ports private.

---

## Windows Firewall rules

If hosting for LAN or internet players, open PowerShell as Administrator and run:

```powershell
New-NetFirewallRule -DisplayName "Dune Admin Web 8088 TCP" `
  -Direction Inbound `
  -Protocol TCP `
  -LocalPort 8088 `
  -Action Allow

New-NetFirewallRule -DisplayName "Dune Game Messaging 31982 TCP" `
  -Direction Inbound `
  -Protocol TCP `
  -LocalPort 31982 `
  -Action Allow

New-NetFirewallRule -DisplayName "Dune Game UDP 7777-7810" `
  -Direction Inbound `
  -Protocol UDP `
  -LocalPort 7777-7810 `
  -Action Allow
```

---

## Advanced WSL networking

For the first same-PC install test, use the recommended localhost-forwarding config:

```ini
[wsl2]
localhostForwarding=true
memory=32GB
processors=8
```

For LAN or internet hosting, WSL mirrored networking may be useful on Windows 11. Mirrored networking changes how WSL services are exposed and can require Windows Firewall rules. Use it only when you are specifically testing LAN reachability.

Advanced mirrored example:

```ini
[wsl2]
networkingMode=mirrored
dnsTunneling=true
autoProxy=true
firewall=true
memory=32GB
processors=8
```

Do not combine `networkingMode=mirrored` with an expectation that `localhostForwarding` controls access. In mirrored mode, WSL may warn that `localhostForwarding` has no effect.

After changing `.wslconfig`, always restart WSL:

```powershell
wsl --shutdown
```

---

## Daily commands

Inside Ubuntu:

```bash
cd ~/dune-awakening-selfhost-docker
```

If you cloned the fork:

```bash
cd ~/dune-awakening-selfhost-docker-WSL
```

Useful commands:

```bash
dune --help
dune status
dune start
dune stop
dune web
dune logs redblink-dune-docker-console
```

---

## FAQ / troubleshooting

### `Ubuntu-26.04` is not listed

Run:

```powershell
wsl --list --online
```

Use the exact Ubuntu 26.04 name that Microsoft lists. If Ubuntu 26.04 is not listed, install the closest available official Ubuntu 26.04 entry, then pass that exact name to `install.ps1` with `-WslDistro`.

### Could not determine the default Linux user

Open Ubuntu once and finish first-run setup:

```powershell
wsl --shutdown
wsl -d Ubuntu-26.04
```

Create the Linux username/password if prompted, then run:

```bash
whoami
exit
```

After `whoami` prints your Linux username, re-run the installer.

### `docker: permission denied`

Inside Ubuntu:

```bash
sudo usermod -aG docker $USER
newgrp docker
docker run hello-world
```

If it still fails:

```powershell
wsl --shutdown
wsl -d Ubuntu-26.04
```

### Docker service is not running

Inside Ubuntu:

```bash
sudo systemctl status docker --no-pager
sudo systemctl enable --now docker
```

If `systemctl` fails, verify `systemd`:

```bash
ps -p 1 -o comm=
```

### Web UI does not open from Windows

First verify that the console container exists:

```powershell
wsl -d Ubuntu-26.04 -- bash -lc 'docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"'
```

Look for:

```text
redblink-dune-docker-console
```

If the container is missing, start it from Ubuntu:

```powershell
wsl -d Ubuntu-26.04 -- bash -lc 'cd ~/dune-awakening-selfhost-docker && docker compose -f docker-compose.web.yml up -d redblink-dune-docker-console'
```

Then verify the Web UI is listening inside Ubuntu:

```powershell
wsl -d Ubuntu-26.04 -- bash -lc 'ss -ltnp | grep 8088 || true'
wsl -d Ubuntu-26.04 -- bash -lc 'curl -I http://127.0.0.1:8088 || true'
```

If Ubuntu returns `HTTP/1.1 200 OK` but Windows still cannot connect to `localhost:8088`, check the Windows-side WSL config:

```powershell
Get-Content "$env:USERPROFILE\.wslconfig" -ErrorAction SilentlyContinue
```

For the default same-PC setup, use:

```ini
[wsl2]
localhostForwarding=true
memory=32GB
processors=8
```

Then fully restart WSL and start the console again:

```powershell
wsl --shutdown
wsl -d Ubuntu-26.04 -- bash -lc 'cd ~/dune-awakening-selfhost-docker && docker compose -f docker-compose.web.yml up -d redblink-dune-docker-console'
```

Test from Windows:

```powershell
Test-NetConnection localhost -Port 8088
```

If you intentionally use mirrored networking, test the LAN address instead of assuming localhost forwarding:

```powershell
$wslIps = (wsl -d Ubuntu-26.04 -- bash -lc "hostname -I").Trim().Split(" ", [System.StringSplitOptions]::RemoveEmptyEntries)
$wslIp = $wslIps | Where-Object { $_ -notlike "172.*" } | Select-Object -First 1
$wslIp
Test-NetConnection $wslIp -Port 8088
```

If the container keeps restarting, inspect the logs:

```powershell
wsl -d Ubuntu-26.04 -- bash -lc 'docker logs --tail=200 redblink-dune-docker-console'
```

Redact passwords, tokens, and secrets before sharing logs.

### Players cannot connect from outside the house

Check:

1. Router forwards `31982/TCP` and `7777-7810/UDP` to the Windows PC.
2. Windows Firewall allows those ports.
3. The server advertises the correct public IP.
4. Your ISP is not using CGNAT.
5. WSL networking mode allows LAN/internet traffic to reach Ubuntu.

---

## Security checklist

Before opening the server to the internet:

- Change or store the generated admin password securely.
- Do not commit `.env`, `runtime/secrets`, generated files, or backups.
- Do not expose the Web UI to untrusted users.
- Do not expose `8088` to the public internet unless you intentionally need remote administration.
- Forward only the ports you need.
- Keep Windows, WSL, Ubuntu packages, and Docker patched.
- Treat `/var/run/docker.sock` as privileged host access.
- Back up the database before updates or major configuration changes.

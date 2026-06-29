# Windows / WSL networking and Docker socket access

This guide covers two Windows / WSL issues that can make a healthy Dune stack look broken:

1. the game client hangs on **Connecting** because WSL is not using mirrored networking; and
2. the Web UI shows Docker permission errors because the console container cannot access `/var/run/docker.sock`.

Use this guide after the first install is complete, especially for LAN or public hosting from Windows 11 + WSL2.

---

## Required WSL networking for LAN or public game hosting

For same-PC Web UI validation, `localhostForwarding=true` may be enough. For actual LAN or public Dune game traffic, use WSL mirrored networking so the Linux/Docker server path can behave like the Windows host network endpoint.

Open `.wslconfig` from **PowerShell**:

```powershell
notepad "$env:USERPROFILE\.wslconfig"
```

Use this baseline:

```ini
[wsl2]
networkingMode=mirrored
localhostForwarding=true
firewall=true
memory=32GB
processors=8

[experimental]
hostAddressLoopback=true
```

Adjust `memory` and `processors` for the host. Do not allocate all system RAM to WSL; leave enough for Windows, the game client, browser, Discord, antivirus, and remote administration tools.

After saving `.wslconfig`, fully restart WSL from **PowerShell**:

```powershell
wsl --shutdown
```

Then reopen Ubuntu and verify the network view:

```bash
ip -4 addr show
ip route
hostname -I
```

For LAN testing, players should reach the Windows host LAN IP, for example:

```text
192.168.x.x
```

If the server advertises a WAN address while the client is on the same LAN, the router must support NAT hairpin/loopback. If it does not, the client may hang on **Connecting** even though `dune ready` is healthy.

---

## Quick symptom check: Connecting hang

If `dune ready` is healthy but the game client hangs on **Connecting**, confirm whether client UDP traffic reaches the game ports:

```bash
sudo timeout 75 tcpdump -ni any 'udp port 7777 or udp port 7778'
```

During a real client attempt, you should see packets to the client game ports. If you only see internal `172.x.x.x` traffic on `7888/7889`, that is server-to-server traffic, not client entry traffic.

Useful state checks:

```bash
dune ready

docker exec dune-postgres psql -U postgres -d dune -P pager=off -c "
select server_id, map, game_addr, game_port, igw_addr, igw_port, ready, alive, connected_players
from dune.farm_state
where map in ('Overmap','Survival_1','DeepDesert_1')
order by map, server_id;
"
```

If `connected_players` stays `0` during a connection attempt, the client did not complete entry into the game server.

---

## Docker socket access for the Web UI

The Web UI console container uses the host Docker socket to inspect and control the Dune containers. The compose file passes the host UID/GID and Docker socket GID into the container. If those values are stale after a WSL or Docker restart, the Web UI may show errors like:

```text
permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock
```

This is not a Dune server failure. It means the Web UI process cannot access `/var/run/docker.sock`.

### Verify host Docker access

Inside Ubuntu:

```bash
docker ps >/dev/null && echo "host docker OK" || echo "host docker FAIL"
```

If host Docker fails, add the Ubuntu user to the `docker` group and restart the login/session:

```bash
sudo usermod -aG docker "$USER"
newgrp docker
docker ps
```

If it still fails after `newgrp docker`, restart WSL from **PowerShell**:

```powershell
wsl --shutdown
```

Then reopen Ubuntu and test `docker ps` again.

### Refresh Web UI UID/GID and Docker socket GID

Run this from the repository root inside Ubuntu:

```bash
cd ~/dune-awakening-selfhost-docker

HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
SOCKET_GID="$(stat -c '%g' /var/run/docker.sock)"

cp .env ".env.bak.$(date +%Y%m%d-%H%M%S)"

grep -v -E '^(DUNE_HOST_UID|DUNE_HOST_GID|DOCKER_SOCKET_GID)=' .env > /tmp/dune-env.$$
{
  cat /tmp/dune-env.$$
  echo "DUNE_HOST_UID=$HOST_UID"
  echo "DUNE_HOST_GID=$HOST_GID"
  echo "DOCKER_SOCKET_GID=$SOCKET_GID"
} > .env
rm -f /tmp/dune-env.$$

grep -E '^(DUNE_HOST_UID|DUNE_HOST_GID|DOCKER_SOCKET_GID)=' .env
```

If you cloned the WSL fork instead, use that repository path:

```bash
cd ~/dune-awakening-selfhost-docker-WSL
```

Recreate the Web UI container so the new group settings apply:

```bash
docker compose -f docker-compose.web.yml up -d --force-recreate redblink-dune-docker-console
```

Then verify inside the container:

```bash
docker exec redblink-dune-docker-console sh -lc '
echo "===== container id ====="
id

echo "===== docker socket ====="
ls -l /var/run/docker.sock
stat -c "socket uid=%u gid=%g mode=%A path=%n" /var/run/docker.sock
'
```

Expected pattern:

```text
uid=<your Linux uid>
groups=<socket gid included>
srw-rw---- 1 root <socket gid> ... /var/run/docker.sock
```

The container must either run as a user/group that can access the socket or have the socket GID in its supplemental groups.

### Test Docker socket access from inside the Web UI container

```bash
docker exec redblink-dune-docker-console sh -lc '
node - <<'"'"'NODE'"'"'
const http = require("http");

const req = http.request({
  socketPath: "/var/run/docker.sock",
  path: "/v1.47/_ping",
  method: "GET"
}, res => {
  let body = "";
  res.on("data", chunk => body += chunk);
  res.on("end", () => {
    console.log("status=" + res.statusCode);
    console.log("body=" + body.trim());
  });
});

req.on("error", err => {
  console.error("ERROR:", err.message);
  process.exit(1);
});

req.end();
NODE
'
```

Expected result:

```text
status=200
body=OK
```

If the socket test succeeds but the browser still shows an old Docker permission error, restart the Web UI container and hard-refresh the browser:

```bash
docker restart redblink-dune-docker-console
```

Then press `Ctrl+F5` in the browser.

---

## Do not use world-writable Docker socket permissions

Do not fix this with:

```bash
sudo chmod 666 /var/run/docker.sock
```

The Docker socket is privileged host access. Making it world-writable gives broad Docker control to any local process and can be reverted by Docker after restart anyway.

---

## After WSL or Docker restarts

A WSL shutdown, Windows restart, Docker service restart, or `.wslconfig` change can recreate `/var/run/docker.sock`. If the Web UI loses Docker access afterward, repeat the UID/GID refresh and Web UI container recreation steps above.

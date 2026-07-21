# Cloudflare Tunnel Deployment for console.darkdante.org

This document describes how the Dune Docker Console is exposed publicly via Cloudflare Tunnel at `console.darkdante.org`.

## Architecture Overview

```
Internet → Cloudflare Edge → Cloudflare Tunnel (cloudflared) → localhost:8088 → Dune Docker Console Container
```

The deployment uses a **Cloudflare Tunnel** (not a traditional reverse proxy or port forwarding) to securely expose the local Dune Docker Console web UI without opening any inbound ports on the host firewall.

## Components

### 1. Cloudflare Tunnel (cloudflared)

- **Service**: `cloudflared` (systemd-managed)
- **Status**: `systemctl is-active cloudflared` → `active`
- **Tunnel ID**: `67d90501-3c71-413d-949f-89a060f56567`
- **Credentials**: `/home/darkdante/.cloudflared/67d90501-3c71-413d-949f-89a060f56567.json`
- **Config**: `/home/darkdante/.cloudflared/config.yml`

**Config contents:**
```yaml
tunnel: 67d90501-3c71-413d-949f-89a060f56567
credentials-file: /home/darkdante/.cloudflared/67d90501-3c71-413d-949f-89a060f56567.json

ingress:
  - hostname: console.darkdante.org
    service: http://localhost:8088
  - hostname: acp-setup.darkdante.org
    service: http://129.146.238.118:3100
  - service: http_status:404
```

**How it works:**
- `cloudflared` establishes an **outbound-only** connection to Cloudflare's edge network
- No inbound firewall rules or port forwarding are needed
- Traffic to `console.darkdante.org` is routed through the tunnel to `http://localhost:8088`
- The catch-all `http_status:404` rejects any unmatched hostnames

### 2. Dune Docker Console Container

- **Container name**: `redblink-dune-docker-console`
- **Image**: `redblink-dune-docker-console:dev`
- **Network mode**: `host` (binds directly to host network interfaces)
- **Port**: `8088` (configured via `ADMIN_BIND_PORT`)
- **Bind host**: `0.0.0.0` (listens on all interfaces)

**Key bind mounts:**
| Host Path | Container Path | Purpose |
|---|---|---|
| `/home/darkdante/dune-awakening-selfhost-docker` | `/repo` | Repo root (addons, secrets, generated state) |
| `/var/run/docker.sock` | `/var/run/docker.sock` | Docker API access |
| `/etc/localtime` | `/etc/localtime` | Timezone sync |

**Key environment variables:**
| Variable | Value | Purpose |
|---|---|---|
| `DUNE_DOCKER_DIR` | `/repo` | Container repo root |
| `ADMIN_BIND_HOST` | `0.0.0.0` | Listen on all interfaces |
| `ADMIN_BIND_PORT` | `8088` | Web console port |
| `DUNE_HOST_REPO_ROOT` | (from `.env`) | Host-side repo path |

### 3. Addon Serving

Addons are served by the console's internal HTTP server through the `/api/addons/installed/{id}/content/{path}` route.

**Flow:**
1. Console reads `addon.json` from `/repo/runtime/addons/installed/{id}/addon.json`
2. Validates addon is enabled and has approved permissions
3. Resolves the content path relative to the addon's install directory
4. Serves the file with `content-type` and `x-frame-options: SAMEORIGIN` headers
5. The addon's `index.html` is loaded in an `<iframe>` within the Console UI

**Addon install path:**
```
/repo/runtime/addons/installed/dune-ops-observability/
├── addon.json
└── web/
    ├── index.html
    ├── addon.js
    ├── addon.css
    ├── data-providers.js
    ├── dune-addon-bridge.js
    └── faction-tagger.js
```

### 4. Addon Bridge Communication

Addons communicate with the console backend via `postMessage` through the iframe:

```
Addon iframe → window.parent.postMessage() → Console server → Database/API → Response → postMessage back
```

**Bridge protocol:**
- Addon loads `dune-addon-bridge.js` which sets up `window.DuneAddon.request(action, payload)`
- Requests are sent as `dune-addon-request` messages with `addonId`, `requestId`, `action`, `payload`
- Console validates addon permissions before executing the action
- Response is sent back as `dune-addon-response` with `requestId`, `ok`, `result`/`error`
- 30-second timeout per request

**Available bridge actions for this addon:**
| Action | Permission | Description |
|---|---|---|
| `ops.health.summary.v2` | `ops:read` | System health summary |
| `ops.health.players` | `ops:read` | Player health data |
| `ops.health.farms` | `ops:read` | Farm health data |
| `ops.activity.summary` | `ops:read` | Player activity stats |
| `ops.resources.summary` | `ops:read` | Resource/spice field data |
| `ops.combat.deaths` | `ops:read` | Combat death tracking |
| `ops.economy.summary` | `ops:read` | Economy/market data |
| `ops.inventory.summary` | `ops:read` | Inventory stats |
| `ops.location.activity` | `ops:read` | Map/location activity |
| `ops.soc.summary` | `ops:read` | System-on-chip / service health |
| `ops.health.prometheus` | `ops:read` | Prometheus metrics health |

## Deploying Addon Updates

### Step 1: Edit addon files in the addon repo

```bash
cd /home/darkdante/dune-docker-addon/addon-main/web/
# Edit index.html, addon.js, data-providers.js, etc.
```

### Step 2: Copy to installed addon directory

```bash
cp /home/darkdante/dune-docker-addon/addon-main/web/* \
   /home/darkdante/dune-awakening-selfhost-docker/runtime/addons/installed/dune-ops-observability/web/
```

### Step 3: Restart the console container

```bash
docker restart redblink-dune-docker-console
sleep 3
```

### Step 4: Verify in browser

1. Open `https://console.darkdante.org`
2. Hard refresh (`Ctrl+Shift+R`) or disable cache in DevTools
3. Navigate to **Addons** → **Dune Ops Observability** → **Open**
4. Check the version displayed in the addon header

### Automated deployment (optional)

The `scripts/validate-and-install-local-console.sh` script automates this:
```bash
cd /home/darkdante/dune-docker-addon/addon-main
bash scripts/validate-and-install-local-console.sh
```

This script:
1. Syncs addon repo with `origin/main`
2. Runs validation (`pre-commit`, `validate.js`, `package.sh`)
3. Copies addon files to the console runtime
4. Enables the addon in `state.json`

## Troubleshooting

### Console not reachable

```bash
# Check cloudflared status
systemctl status cloudflared

# Check tunnel connectivity
cloudflared tunnel info 67d90501-3c71-413d-949f-89a060f56567

# Check console container
docker ps --filter "name=console"

# Test local connectivity
curl -s http://localhost:8088/api/health
```

### Addon not loading

```bash
# Verify addon files exist
ls /home/darkdante/dune-awakening-selfhost-docker/runtime/addons/installed/dune-ops-observability/web/

# Check addon state
cat /home/darkdante/dune-awakening-selfhost-docker/runtime/addons/state.json

# Verify addon is enabled in container
docker exec redblink-dune-docker-console cat /repo/runtime/addons/installed/dune-ops-observability/addon.json

# Check console logs
docker logs redblink-dune-docker-console --since 5m
```

### Bridge requests failing (400 Bad Request)

- Ensure the addon has `ops:read` permission in `addon.json`
- Check `state.json` has `"approvedPermissions": ["ops:read"]`
- Verify the action is registered in the console's `server.js` bridge handler
- Check browser DevTools Console for error messages

### Stale addon content

The console serves addon files directly from disk with no caching layer. If you see stale content:
1. Hard refresh the browser (`Ctrl+Shift+R`)
2. Disable browser cache in DevTools Network tab
3. Verify the file on disk matches expectations:
   ```bash
   docker exec redblink-dune-docker-console cat /repo/runtime/addons/installed/dune-ops-observability/web/addon.js | grep "version"
   ```

## DNS Configuration

The domain `console.darkdante.org` is managed through Cloudflare DNS with a **CNAME** record pointing to the Cloudflare Tunnel:

```
Type: CNAME
Name: console
Target: 67d90501-3c71-413d-949f-89a060f56567.cfargotunnel.com
Proxy status: Proxied (orange cloud)
```

No A records or port forwarding rules are needed — the tunnel handles all routing.

## Security Notes

- **No open inbound ports**: The host firewall does not need port 80 or 443 open
- **TLS termination**: Cloudflare handles TLS at the edge; traffic between Cloudflare and the host is encrypted via the tunnel
- **Authentication**: The console requires admin login (password stored in `runtime/secrets/admin-web-password.txt`)
- **Addon sandboxing**: Addons run in iframes with `x-frame-options: SAMEORIGIN` and can only access approved bridge actions
- **Permission model**: Each bridge action validates the addon's declared and approved permissions before execution

# Encrypted API access

**Status:** Optional | **Last Updated:** October 2026

The Console listens on plain HTTP (`http://<host>:8088`). That is fine on a trusted network, but over the internet the
admin password, API keys and every answer cross the network in clear text. **Encrypted API access** is a small container
in front of the unchanged Console that serves the Console **API** over HTTPS, for everything that uses API keys. Nothing
else changes: your normal address keeps working, and nobody has to adapt anything.

```
tool ──HTTPS :8797, API key──► dune-tls-front ──HTTP 127.0.0.1:8088──► Console (unchanged)
```

## Fingerprint

On its first start the front door creates **its own key** (ECDSA P-256) in `runtime/generated/tls-front` with a
self-signed certificate valid for 20 years. Clients do not trust a certificate authority; they **pin the key**:

```
sha256/<base64url of the SHA-256 of the certificate's public key>
```

The fingerprint stays the same until `runtime/generated/tls-front` is deleted – not after a restart, not when the
certificate is re-issued. It is not secret.

**Compare it** with the one a client shows when it asks you to confirm the connection: if both are identical, nobody can
sit in between. (A client that learned the fingerprint over the very connection it wants to protect could be handed an
attacker's key; the comparison closes that gap.)

You can see it again at any time:

- the **end of the installer** prints the address and the fingerprint next to the first admin password;
- **Settings → Encrypted API Access** shows status, switch, address and fingerprint with a Copy button;
- `dune encrypted-api fingerprint` prints it on the host.

## What it passes

The default is an **API door**:

| | |
|---|---|
| Methods | `GET` and `HEAD` only |
| Paths | `/api/*` and the public marker images `/images/maps/*`; the Console web UI is **not** offered on this port |
| Login | `Authorization: Bearer dak_…` is required (marker images and `/api/health` excepted); browser sessions and cookies never pass |
| Blocked even with a key | `/api/auth/`, `/api/settings/`, `/api/setup/`, `/api/discord/` |
| Forwarded headers | `Authorization`, `Accept`, `Accept-Encoding`, `Range`, conditional headers – no cookies, no `X-Forwarded-For` |
| Brute force | rejected API keys are counted per client address by the front door (the Console only sees `127.0.0.1` behind a proxy and would lump all clients together); 10 per minute block the address for 10 minutes |
| Streams | server-sent events and other long-lived responses are flushed immediately |

So it adds no new way into the admin console. API keys keep exactly the scopes, expiry, rate limit and audit you gave them.

## Turning it on and off

On a **new install** the installer starts it (set `DUNE_ENCRYPTED_API=0` to skip). Later:

- **Settings → Encrypted API Access** has a switch; the first start builds the image and can take a minute.
- `dune encrypted-api enable | disable | status | fingerprint`.

The choice is kept in `runtime/generated/tls-front.env` and survives re-running the installer.

| Variable (`runtime/generated/tls-front.env`) | Default | Meaning |
|---|---|---|
| `DUNE_TLS_FRONT_ENABLED` | `true` after a new install | start it |
| `DUNE_TLS_FRONT_PORT` | `8797` | TCP port on the host |
| `DUNE_TLS_FRONT_BIND` | `0.0.0.0` | interface |
| `DUNE_TLS_FRONT_NAMES` | empty | host names / IPs for the certificate (only browsers look at them; tools pin the key) |
| `DUNE_TLS_FRONT_ALLOW` | empty = all | only these IPs/CIDRs may connect |

Allow **TCP 8797** in the host firewall (and any upstream firewall) to use it from other computers; ideally only from the
addresses that need it (`DUNE_TLS_FRONT_ALLOW`).

## API

| Route | Action | |
|---|---|---|
| `GET /api/settings/encrypted-api` | `settings:read` | `{ available, enabled, running, state, health, port, fingerprint }`; no secret |
| `POST /api/settings/encrypted-api` | `settings:write` | `{ "enabled": true\|false }`, builds/starts or stops it; audited |

Both are `settings:*`, so no API key can reach them. The Console only ever reads the **certificate** to compute the
fingerprint; the private key is never read.

## Security notes

- Keep `runtime/generated/tls-front` private and back it up: if the key is lost, the fingerprint changes and tools have to
  confirm the new one. (Deleting the folder is also how you rotate the key.)
- The container runs as the host user, read-only, `cap_drop: ALL`, `no-new-privileges`, 64 MB, with host networking so it can
  reach the Console on `127.0.0.1`.
- Prefer a real certificate? A reverse proxy with Let's Encrypt in front of the Console works too and needs none of this.

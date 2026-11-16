# Secrets Management Deep Dive — PKI, CMK, Storage, Retrieval & Rotation

**Date:** 2026-08-07
**Status:** Analysis — candidate evaluation before implementation

---

## 1. Current State

### 1.1 What Secrets Exist

| Secret | Location | Format | Permissions | Auto-Created | Rotatable |
|---|---|---|---|---|---|
| Admin web password | `runtime/secrets/admin-web-password.txt` | Plaintext | 600 | Yes (`getOrCreateSecret`) | Manual |
| Session signing key | `runtime/secrets/admin-web-session-secret.txt` | Plaintext base64url | 600 | Yes | Manual |
| Funcom service token | `runtime/secrets/funcom-token.txt` | Plaintext JWT | 600 | No (operator) | Via Funcom portal |
| Discord OAuth client secret | `runtime/secrets/discord-oauth-client-secret.txt` | Plaintext | 600 | No (operator) | Via Discord portal |
| Discord adapter token | `runtime/secrets/discord-adapter-token.txt` | Plaintext | 600 | No (operator) | Automated (Settings → Discord Bot → Regenerate Token) |
| Discord hosted-bot OAuth client secret (`dune-awakening-selfhost-docker#901`) | `runtime/secrets/discord-hosted-bot-oauth-client-secret.txt` | Plaintext (age-encryptable, opt-in -- see `age-secrets.md`) | 600 | No (operator, hosted-bot wizard's Advanced fallback) | Via Discord portal |
| Discord bot handoff secret | `runtime/secrets/discord-bot-handoff-secret.txt` | Plaintext | 600 | No (operator) | Manual |
| FLS API key | `runtime/secrets/fls-apikey.txt` | Plaintext | 600 | No (operator) | Via Funcom |
| RMQ HTTP token secret | `runtime/secrets/rmq-http-token-auth-secret.txt` | Plaintext | 600 | Manual | Manual |
| Server login password secret | `runtime/secrets/server-login-password-secret.txt` | Plaintext (age-encryptable, opt-in -- see `age-secrets.md`) | 600 | Manual | Manual |
| Username server login secret | `runtime/secrets/username-server-login-secret.txt` | Plaintext (age-encryptable, opt-in -- see `age-secrets.md`) | 600 | Manual | Manual |
| Public directory JSON | `runtime/secrets/public-directory.json` | Plaintext JSON | 600 | Auto-managed | N/A |
| Mentat bot adapter token | `arrakis-control-panel/data/acp.db` (bot repo path/filename unchanged as of this writing -- credential vars/paths are a separate, not-yet-done pass, see the bot repo's own `docs/env-var-compatibility.md`) | AES-256-GCM encrypted | 600 | Per-guild setup | Manual |
| Mentat Discord bot token | `arrakis-control-panel/.env` (same caveat) | Plaintext env var | 600 | No (operator) | Via Discord portal |

**Total: 11+ secrets in 2 repos, all plaintext files except the bot's SQLite encryption layer.** Three of these (server login password, username server login, and the hosted-bot OAuth client secret) can additionally be migrated to optional per-secret age-based envelope encryption -- see `age-secrets.md` -- while remaining plain flat files on disk otherwise; this is a real, shipped, opt-in mechanism, distinct from the single-vault-blob architecture this document evaluates as a candidate below.

### 1.2 How Secrets Are Loaded Today

```
config.js: readInlineOrFile(env_var, file_path)
  → If env var set: use it
  → Else if file exists: read file, trim, return
  → Else: return ""

getOrCreateSecret(path, bytes):
  → If file exists: read it
  → Else: generate random, write file, return value
```

Each secret is loaded independently. There's no unified secret store, no key hierarchy, no master key. Most secrets require manual rotation; however, the Discord adapter token now has an automated rotation mechanism via the console's Settings → Discord Bot section. The only existing encryption is the Mentat bot's `ACP_SECRETS_KEY` (env var name unchanged as of this writing -- deliberately deferred, see above) → AES-256-GCM for SQLite at-rest encryption of adapter tokens and OAuth access tokens.

### 1.3 The Current Threat Model

| Threat | Mitigation Today | Gap |
|---|---|---|
| Local file access by other processes | 600 permissions | Any process running as the `dune` user can read all secrets |
| Accidental git commit | `.gitignore` excludes `runtime/secrets/` | One misconfigured `.gitignore` and all secrets leak |
| Docker container mount exposure | Secrets directory bind-mounted into containers | Every container can read every secret — no per-container scoping |
| Backup exposure | `dune db backup` tars secrets directory | Backups contain plaintext secrets; no encryption-at-rest in backups |
| Operator error (terminal history) | None | Typing `cat admin-web-password.txt` exposes the secret in terminal |
| Log exposure | Manual discipline | A misconfigured log statement could dump a secret value |
| Secret rotation | None | No rotation schedule, no rotation tooling, no version tracking |

---

## 2. Candidate Solutions

### 2.1 Evaluation Criteria

| Criteria | Weight | Notes |
|---|---|---|
| Open source / free | **Mandatory** | No license costs for self-hosters |
| Single binary or minimal deps | **High** | Must run on Ubuntu 24.04 with no external DB required |
| Node.js integration | **High** | `config.js` needs to load secrets at startup |
| Shell script integration | **High** | `spawn-server.sh`, `dune` CLI scripts need secrets at container launch |
| Secret rotation built-in | **High** | Must support rotating secrets without downtime |
| Audit trail | **Medium** | Who accessed which secret, when |
| Encryption at rest | **Mandatory** | All secrets encrypted on disk |
| Encryption in transit | **Low** | All secrets used within the same VM (localhost) |
| PKI / CMK support | **Medium** | Asymmetric key pairs for signing (HMAC handoff #135 already uses symmetric) |
| Multi-machine support | **Low** | Single R740 deployment today |

### 2.2 Candidate Solutions

#### A. HashiCorp Vault (Community Edition)

**Overview:** Industry-standard secret management. KV v2 secrets engine, PKI engine, transit engine (encryption-as-a-service). Runs as a daemon with a storage backend.

**Pros:**
- The gold standard for secret management
- Full PKI: issue/revoke X.509 certs, manage CA hierarchies
- Transit engine: encryption-as-a-service — apps never see the key material
- KV v2: versioned secrets with rollback
- Dynamic secrets: generate temporary credentials (Postgres, etc.) that auto-expire
- Audit logging built-in
- Node.js client: `node-vault` library
- API-driven: everything is HTTP, easy to script from bash
- Secret rotation: lease-based with renewable credentials

**Cons:**
- **Heavy** — requires its own process, storage backend (raft/file/consul), unseal procedure
- Unseal keys are themselves a secret management problem
- Overkill for a single-node self-hosted game server
- Adds a new SPOF — if Vault is down, no secrets load, console won't start

**Fit:** 3/10 — correct tool for the wrong scale

#### B. OpenBao

**Overview:** Fork of HashiCorp Vault after BSL license change. Same API, same architecture. Community-maintained.

**Pros:** Same as Vault, but with a truly open-source license guarantee

**Cons:** Same as Vault — too heavy. Smaller community, less documentation.

**Fit:** 3/10 — same problems as Vault at smaller scale

#### C. Infisical

**Overview:** Modern open-source secret management platform. Web UI, CLI, SDK, secret rotation, dynamic secrets, audit logs. Self-hostable with SQLite or Postgres.

**Pros:**
- Web UI for managing secrets (visual editor)
- CLI for CI/CD and scripts
- Node.js SDK: `@infisical/sdk`
- Secret rotation: built-in, with configurable rotation policies
- Audit logs: who accessed what, when
- Lighter than Vault — single binary, SQLite backend option
- Dynamic secrets for Postgres
- Designed for teams, works for solo operators

**Cons:**
- Newer project — less battle-tested than Vault
- Still a separate daemon process
- Web UI requires browser access (not headless-friendly)
- Self-hosted version has fewer features than cloud

**Fit:** 6/10 — promising but still a separate service to manage

#### D. SOPS (Mozilla) + age

**Overview:** SOPS encrypts structured files (YAML, JSON, .env) using age keys. Files are encrypted at rest in git or on disk. No daemon — just a CLI tool.

**Pros:**
- **Zero infrastructure** — no server, no daemon, no unseal
- Git-friendly: encrypted files can be committed (age keys stay out of git)
- age keys are simple: one keypair per operator/machine
- `.env` files can be encrypted wholesale: `sops -e .env > .env.enc`
- Shell-friendly: `sops exec --decrypt .env.enc -- your-command`
- Node.js: can shell out or use `sops` npm wrapper
- Industry adoption: used by Mozilla, GitLab, FluxCD

**Cons:**
- **No secret rotation built-in** — rotation means re-encrypting the file with the same or different key
- No audit trail — file access is at the OS level only
- No per-secret access control — one key decrypts the whole file
- No dynamic secrets or lease management
- age key management is manual (key file on disk, same problem as current secrets)

**Fit:** 5/10 — solves encryption-at-rest elegantly but doesn't address rotation or access control

#### E. Custom Solution: age + Node.js Secret Manager

**Overview:** Build a minimal secret management layer using `age` for file encryption and a thin Node.js/CLI wrapper for key generation, secret retrieval, and rotation.

**Architecture:**
```
runtime/secrets/              (encrypted at rest with age)
├── .master-key.age           (age identity — encrypted with operator passphrase)
├── vault.json.age            (all secrets in one encrypted JSON blob)
│   ├── admin-web-password
│   ├── session-secret
│   ├── funcom-token
│   ├── discord-oauth-client-secret
│   ├── discord-adapter-token
│   ├── discord-bot-handoff-secret
│   └── ...
└── vault.json.age.1          (previous version after rotation)

config.js:
  import { loadSecrets } from "./secrets.js"
  const secrets = loadSecrets(repoRoot)  // decrypts vault.json.age with age key

spawn-server.sh:
  age --decrypt -i ~/.age/dune-server.key $SECRETS_FILE | jq -r '.funcom_token'
```

**Pros:**
- **Incremental** — replaces the current file-per-secret approach with one encrypted file
- **Zero new dependencies** beyond `age` (single Go binary, in apt: `age`)
- **Versioned rotation** — rotation = re-encrypt vault with new key, keep .1 backup
- **Familiar pattern** — same `readInlineOrFile` concept, just reading from a decrypted JSON blob
- **No daemon** — no SPOF, no unseal ritual
- **Costs <1 hour to implement** the basic version
- **CMK/Key rotation** — age supports multiple recipients; rotate the age identity

**Cons:**
- **No audit trail** — still OS-level
- **No per-secret access control** — one key decrypts all
- **Manual rotation** — needs a CLI script (which we'd build)
- **age key IS the master key** — if lost, all secrets lost; needs secure backup
- Not standardized — custom code we maintain

**Fit:** 8/10 — pragmatic, minimal, fits the current architecture, solves the core problems

#### F. Bitwarden Secrets Manager CLI

**Overview:** Bitwarden's enterprise secret management. Self-hosted server (Bitwarden Unified) + CLI for retrieval. SDKs for Node.js.

**Pros:**
- Self-hosted option (Bitwarden Unified, free for personal use)
- Web UI for management
- CLI: `bw get item <id>`
- Machine accounts for automation
- Secret rotation via the UI
- Already has a Node.js SDK

**Cons:**
- Requires Docker to run the self-hosted server
- Heavy for what we need — full password manager stack
- Bitwarden Unified needs 2 GB+ RAM
- Adds a new service dependency on the prod VM

**Fit:** 4/10 — correct tool, wrong scale

---

## 3. Trade-Off Matrix

| Criterion | Vault | OpenBao | Infisical | SOPS+age | Custom age | Bitwarden SM |
|---|---|---|---|---|---|---|
| Open source / free | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Single binary / minimal deps | ❌ | ❌ | ⚠️ | ✅ | ✅ | ❌ |
| Node.js integration | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ |
| Shell script integration | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| Secret rotation built-in | ✅ | ✅ | ✅ | ❌ | ⚠️ (scripts) | ✅ |
| Audit trail | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ |
| Encryption at rest | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| PKI / CMK | ✅ | ✅ | ⚠️ | ❌ | ❌ | ❌ |
| Implementation effort | 20-30h | 20-30h | 15-25h | 5-8h | 3-5h | 15-20h |
| Operational overhead | High | High | Medium | Low | Low | Medium |

---

## 4. Recommendation

### Phase 1 (Now): Custom age-based Secret Vault

**Cost: 3-5 hours. Fits current architecture. No new daemons.**

1. Consolidate all 10+ secret files into a single `runtime/secrets/vault.json.age` encrypted with age
2. Build `console/api/src/secrets.js` — a thin wrapper that decrypts the vault at startup, caches secrets in memory
3. Build `scripts/secrets.sh` — CLI wrapper for `age` with subcommands: `init`, `get <key>`, `set <key> <value>`, `rotate`, `list`
4. Update `config.js` to use `loadSecrets()` instead of individual `readInlineOrFile` calls
5. Update shell scripts (`spawn-server.sh`, etc.) to source secrets from the vault
6. Generate an age identity for the `dune` user, stored at `~/.age/dune-server.key` (chmod 600)
7. Document key backup procedure (age identity must be backed up securely — losing it means losing all secrets)

**The age identity IS the CMK.** It can be encrypted with an operator passphrase (age supports passphrase-protected identities). For automated startup, the unencrypted identity file is used (600 permissions on a single-user VM is a reasonable trust boundary).

### Phase 2: Secrets Manager UI (in Access Control)

**Cost: 8-12 hours. Layers on Phase 1. Builds on IAM UI patterns from Phase A.**

The IAM Policy Editor and the Secrets Manager belong together under the
Access Control section of the Server Control tab. IAM controls **who can
do what**; Secrets controls **what credentials they use to do it.**

#### UI Architecture

```
Server Control → Access Control
├── [IAM Policies]          ← IamPolicyEditor.tsx (built — Phase A)
│   ├── JSON Editor tab
│   ├── Visual Builder tab
│   └── Test Policy tab
│
└── [Secrets Vault]         ← SecretsManager.tsx (Phase 2 — designed, not built)
    ├── List secrets (key names only, values masked)
    ├── View secret (confirmation-gated reveal)
    ├── Edit secret (set/update with audit log)
    ├── Rotate specific secret (new value, archive old version)
    ├── Rotate master key (new age identity, re-encrypt vault)
    └── Audit log (timestamped access/change history)
```

#### New API Endpoints

| Route | Purpose |
|---|---|
| `GET /api/settings/secrets/keys` | Returns array of key names (values never returned) |
| `GET /api/settings/secrets/key/:name` | Returns one secret value. Audit-logged. Requires confirmation parameter. |
| `PUT /api/settings/secrets/key/:name` | Set or update a secret. Re-encrypts vault. Audit-logged. |
| `DELETE /api/settings/secrets/key/:name` | Remove a secret from the vault. Audit-logged. |
| `POST /api/settings/secrets/rotate/:name` | Generate new value for one secret, archive old vault version |
| `POST /api/settings/secrets/rotate-key` | Generate new age identity, re-encrypt vault, archive old vault + old key |
| `GET /api/settings/secrets/audit` | Read audit log: `{time, user, action, secret}` |

#### React Component: SecretsManager.tsx

```tsx
// console/web/src/features/settings/SecretsManager.tsx
// Pattern matches IamPolicyEditor.tsx (same tabbed layout, same Action constants)

function SecretsManager() {
  // State: secretKeys[], selectedKey, revealMode, auditLog[]

  return (
    <section className="secrets-manager">
      <div className="secret-list-panel">
        {secretKeys.map(key => (
          <div key={key} className="secret-row">
            <span className="secret-name">{key}</span>
            <span className="secret-value-masked">********</span>
            <button onClick={() => revealSecret(key)}>Reveal</button>
            <button onClick={() => editSecret(key)}>Edit</button>
            <button onClick={() => rotateSecret(key)}>Rotate</button>
          </div>
        ))}
      </div>

      {revealMode && (
        <div className="secret-reveal-dialog">
          <p>Revealing secret: <strong>{selectedKey}</strong></p>
          <p>This action will be audit-logged.</p>
          <ConfirmDialog onConfirm={() => showValue()} />
        </div>
      )}

      <div className="secret-audit-panel">
        <h4>Access History</h4>
        {auditLog.map(entry => (
          <div key={entry.time} className="audit-row">
            <span>{entry.time}</span>
            <span>{entry.action}</span>
            <span>{entry.secret}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
```

#### Security Boundaries (Phase 2 additions)

- Age identity never exposed through the API — server reads it at startup, never returns it
- In-memory secrets are the runtime cache — API reads/writes from this cache
- Audit log: `runtime/generated/secrets-audit.jsonl` — append-only JSONL, rotated monthly
- UI: masked values by default, confirmation dialog required to reveal
- Rotation: keeps `.1` backup of previous vault + identity for rollback
- Capability gate: `settings:write` (same as IAM — owner by default)

#### Server-side Implementation Note

The existing `policy.js` `_policies` store is an in-memory cache pattern that
the secrets manager can follow exactly: `_secrets` object loaded from
`vault.json.age` at startup, modified in-memory by the API, flushed to disk
on write. Same `setPolicies()` / `getAllPolicies()` pattern, adapted for
key-value secrets.

### Phase 3: Audit Trail + Scheduled Rotation

**Cost: 5-8 hours. Layers on Phase 2.**

1. Add `secrets.sh audit` — logs every access to `vault.json.age` with timestamp, user, and operation
2. Add `secrets.sh rotate` — generates new age identity, re-encrypts vault, archives old vault as `.1`, updates identity path
3. Add systemd timer for scheduled rotation (monthly per GRC requirements)
4. Add `secrets.sh backup` — encrypts vault with operator's personal age key for off-machine backup

### When to Upgrade to Vault/Infisical

**Trigger:** You have 3+ machines needing coordinated secret access, or you need PKI/certificate management. Until then, age-based vault is sufficient.

---

## 5. Implementation Plan (Phase 1)

### 5.1 New Files

| File | Purpose |
|---|---|
| `console/api/src/secrets.js` | `loadSecrets(repoRoot) → { adminPassword, sessionSecret, ... }`. Decrypts vault with age, caches in memory. |
| `scripts/secrets.sh` | CLI: `init`, `get`, `set`, `list`, `rotate`. Thin wrapper around age + jq. |
| `runtime/secrets/vault.json.age` | Encrypted JSON blob containing all secrets. Gitignored. |
| `~/.age/dune-server.key` | Age identity file (chmod 600). Generated by `secrets.sh init`. |
| `docs/security/secrets-management.md` | This document, trimmed to deployment guide. |

### 5.2 Migration Path

```
1. age-keygen -o ~/.age/dune-server.key           # generate identity
2. scripts/secrets.sh init ~/.age/dune-server.key  # create empty vault
3. scripts/secrets.sh migrate                       # read existing files → populate vault
4. Update config.js to use secrets.js               # one-line change per secret
5. Verify console starts with vault secrets
6. Remove old plaintext secret files                # after verification
```

### 5.3 Key Backup

The age identity (`~/.age/dune-server.key`) IS the master key. It must be:
1. Backed up to a secure, offline location (encrypted USB, password manager)
2. Never committed to git
3. Never included in database backups (`dune db backup` excludes `runtime/secrets/` today — same for `.age/`)

If the key is lost, all secrets are unrecoverable — the console cannot decrypt the vault and cannot start. This is the same failure mode as today (if you lose `runtime/secrets/`, you lose all secrets), but with one additional decryption step.

**Recovery procedure:** if the age key is lost, regenerate secrets manually (new admin password via `dune`, new Funcom token from Funcom portal, new Discord tokens from Discord portal, etc.) and run `secrets.sh init` to create a new vault. There is no "password reset" for age identities.

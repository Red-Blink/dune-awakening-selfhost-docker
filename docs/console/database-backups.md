# Database backups and Battlegroup identity

**Status:** Current | **Last Updated:** August 2026

Database backups contain character and world data associated with a Battlegroup
ID. Restoring a backup into a deployment with a different ID therefore requires
an explicit identity choice before any restore changes are made.

- **Adopt Backup ID** is for moving the same server to new hardware or a fresh
  installation. The restore verifies that the saved Funcom token belongs to the
  backup Battlegroup before proceeding.
- **Keep Current ID** is for intentionally importing data into a different
  server. Characters associated with the backup ID may not appear in game.

The Backups page shows this choice whenever both IDs are known and differ. The
command line has the same safety behavior:

```bash
dune db restore BACKUP --adopt-backup-battlegroup
dune db restore BACKUP --keep-current-battlegroup
```

An unattended restore with mismatched IDs fails before changing the database
unless one of these options is supplied. Adoption is also refused if the backup
metadata has no usable ID or the configured Funcom token does not match it.

Manual, automatic, imported, and pre-operation backups follow the same rules;
the decision is based on the recorded Battlegroup IDs, not the backup's origin.

## Moving to a new host: system backups

A plain backup download contains only the database dump and its `.yaml` metadata.
It carries none of the configuration the console generates, so rebuilding on new
hardware from one alone means re-entering every setting by hand.

**System backups** solve that. `dune db backup-system` bundles a fresh database
dump together with `.env`, `runtime/generated/` and `runtime/secrets/` into a
single encrypted archive under `runtime/backups/system/`, and the Backups page
now exposes it directly: enter a passphrase twice, and **Create System Backup**.

Unlike a plain download, the archive is a genuine point-in-time capture — the
config inside it is the config as it was when the backup ran, not as it is now.

### The passphrase

The archive is encrypted with AES-256 in AEAD (OCB) mode via gpg — an
authenticated cipher, so a corrupted or tampered archive is rejected outright at
decrypt time rather than silently producing wrong plaintext.

**There is no way to recover a system backup without its passphrase.** Store it
somewhere durable and separate from the archive itself — a password manager, not
the same disk. The console asks for it twice because a typo produces an archive
nobody can ever open.

The passphrase is never written to the audit log, never appears in the task log,
and is never passed on a command line where other processes on the host could
read it from `ps`.

Every credential is retained verbatim: the Funcom Self-Host Service Token, the
admin console password, RMQ credentials and the sietch join password. Treat a
copy of the archive as equivalent to a copy of your Funcom token the moment it
leaves the host.

### Retention

System backups are never pruned automatically. Set `DUNE_SYSTEM_BACKUP_KEEP` to
a positive integer to keep only that many newest archives; `0` (the default)
keeps every one. Pruning is opt-in because each archive is the only copy of the
credentials inside it — the console's Delete controls are the deliberate path.

A restore also leaves a plaintext safety copy of what it replaced -- `.env` and every secret -- under `runtime/backups/restore-<timestamp>/`. That copy is not the only one of anything, since the archive it came from is still there, so it is pruned automatically: `DUNE_RESTORE_SAFETY_KEEP` (default `5`) keeps that many newest, removing older ones each time a restore succeeds. Set it to `0` to keep every one.

### Getting the archive onto the new host

Download the backup from the old host's Backups page. On the new host, open
**Backups -> System Backups (Encrypted)**, press **Import Backup**, and upload
the file you downloaded.

The download is a single `.tar` holding both files a backup is made of: the
encrypted archive and its `.yaml` sidecar. The sidecar holds no secrets, and it
is where Created, Server Title and Battlegroup ID come from. Import accepts that
`.tar`, or a bare `.tar.gz.enc` for an archive you already had -- in which case a
sidecar is written for it stating only what can be read from the archive itself,
and those three columns show `Unknown`.

Importing **stores the archive; it does not apply it.** Nothing on the host
changes until you restore it, and the passphrase is not checked at upload time --
that happens in the restore preview.

Two things import will tell you about rather than decide silently:

- **A name that already exists.** You are asked whether to keep both or replace
  the stored one. Overwriting destroys the only copy of the credentials inside
  the archive already there, so it is never the default.
- **A name that has been changed.** If your browser saved the file as
  `… (1).tar`, or it was renamed by hand, it is stored under a fresh valid name
  and the result tells you which -- restore, download and delete all validate the
  filename, so an archive under a changed name would otherwise be unusable.

The `.tar` is not compressed. Its contents are already encrypted and so
incompressible, and a known size is what lets the console stream a multi-gigabyte
archive in either direction instead of building it in memory first.

#### On a host with no console yet

Copy the files into place directly; they appear on the Backups page once the
console is running.

```bash
scp dune-system-20260830-120000-4711-9931.tar.gz.enc.tar user@newhost:/tmp/
```

```bash
tar -xf dune-system-20260830-120000-4711-9931.tar.gz.enc.tar \
    -C /path/to/dune/runtime/backups/system/
```

Both files keep their original names inside the `.tar`. Do not rename them.

### Restoring on the new host

Open **Backups -> System Backups (Encrypted)**, press Restore on the archive,
enter its passphrase and press **Preview Restore**. The preview decrypts the
archive and reports what it would replace without touching anything; **Apply
Restore** is refused until a preview has succeeded, so a wrong passphrase can
never reach the destructive step. Editing the passphrase after a preview locks
Apply again.

The same operation from a shell:

```bash
dune db restore-system <archive> --dry-run   # report only
dune db restore-system <archive>             # apply
```

Applying restores the database first, then `.env`, `runtime/generated/` and
`runtime/secrets/`. That order matters: the database restore has to run while
`.env` still describes the database it connects to. Whatever is about to be
overwritten is copied to `runtime/backups/restore-<timestamp>/` first. If the
database restore fails, configuration and secrets are left untouched.

Nothing is restarted. Restoring `.env` can change the admin console password and
the database credentials, so the console may be describing a restore that has
already invalidated its own session. The restore stops the game services and
leaves them stopped; start them yourself once the report looks right:

```bash
dune start
```

If the archive's Battlegroup ID differs from the current one, you are asked
whether to adopt the backup's identity or keep the current one — the same
choice, and the same handling, as a database restore.

A system backup also carries this console's own admin audit log --
deliberately: it is part of what should move with a server. If the archive
and this host **both** already have one, you are asked whether to adopt the
backup's history or keep this host's own:

- **Adopt the backup's history** when moving the same server to new
  hardware -- the migration case this whole feature exists for.
- **Keep this host's own history** when rolling back a mistake on the same
  host (an old audit log would erase every admin action recorded since the
  backup), or when intentionally restoring into a different server.

Whichever you don't keep still ends up in the pre-restore safety copy, not
deleted -- it just stops being the live record. If only the archive has an
audit log (a fresh host, say), it is adopted automatically; if neither does,
nothing is asked. From a shell, the same choice is
`--adopt-backup-audit-log` / `--keep-current-audit-log`, and a dry run
reports the conflict even though it changes nothing.

### The Console restarts itself afterwards

The Console reads `.env` once, at startup, so immediately after a restore it
is still running the configuration the restore replaced. It now says so and
recreates its own container after a five-second countdown, which you can
cancel.

The recreate runs in a detached helper, because the Console cannot destroy
and replace the container it is running inside and still report the result.
It recreates only -- the image is not rebuilt, since a restore changes
configuration rather than Console code.

If the archive carried a different admin password, the session ends with it
and the login screen wants the **restored** server's password. That is the
correct outcome, not a failure. From a shell the same operation is
`dune console reload`.

### Restoring onto a brand-new host

A restore needs the Funcom database image, and that image is not pullable:
it exists only after SteamCMD has downloaded the game files and their image
tarballs have been loaded. A host that has never run the game has neither, so
the restore stops before it changes anything and says so.

Install the game files first. From a shell:

```bash
dune update install-assets
```

or press **Install Game Files** on the console's Updates page -- the same
operation either way. It downloads the depot, loads the images, and stops
there: no database is created, migrated or reseeded, which matters because the
restore is about to supply one. (`dune update install`, by contrast, does all
of that and would wipe world partitions the restore then replaces.)

It refuses while a world server is running, since it deliberately cannot stop
one; `--force` overrides that.

The download is several GB. From the console it runs as a task with its own
timeout, `ADMIN_ASSET_DOWNLOAD_TIMEOUT_MS` (4 hours by default); if a very
slow link exceeds it the task is killed mid-download and needs
`dune update fix-steamcmd` before retrying.

### A stopped battlegroup starts Postgres by itself

Stopping the battlegroup does not stop the database, it removes the
`dune-postgres` container outright, leaving only its data volume. Backups
and restores need that database, so they start it themselves and leave it
running -- the next step after a restore is `dune start`, which needs it
anyway.

Two things this deliberately does not do. It never touches a database that
is already up (`start-postgres.sh` recreates the container, which would
destroy a live one mid-dump), and it never stops Postgres again afterward,
which would race an operator starting the stack while a backup ran.

A preview (`--dry-run`) never needs a database at all: it decrypts, reports
and stops, so asking what an archive would replace has no side effects.

To turn the behaviour off and have these operations fail on a stopped stack
instead, set `DUNE_DB_AUTOSTART_POSTGRES=0` in `.env`.

### Inspecting an archive by hand

The automated path above is the supported one. To look inside an archive
without restoring it — or on a host that has no `dune` yet — decrypt it
manually. Extract the downloaded `.tar` first -- the sidecar's own
`decrypt_command` names the `.tar.gz.enc` file, not the bundle around it. That
command is also printed when the backup is created, and the sidecar it lives in
contains no secrets and is safe to read on its own:

```bash
read -r -s -p "Passphrase: " p; echo
printf '%s' "$p" | gpg --batch --yes --pinentry-mode loopback \
  --passphrase-fd 0 -d <archive> > restore.tar.gz \
  && tar -xzf restore.tar.gz
unset p; rm -f restore.tar.gz
```

Decrypt to a file and let gpg's exit status gate the extract, as above. The
authentication tag is verified at the **end** of the stream, so piping
`gpg -d` straight into `tar` writes out nearly the whole archive before the
tamper is detected — and `tar` exiting 0 hides gpg's failure. If gpg reports a
checksum error, `restore.tar.gz` is untrustworthy however complete it looks;
delete it rather than extracting it.

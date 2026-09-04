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

### Getting the archive onto the new host

The console cannot yet upload a system backup, so the archive has to be placed on
the new host by hand. Download it from the old host's Backups page and copy it
across:

```bash
scp dune-system-20260830-120000-4711-9931.tar.gz.enc.tar user@newhost:/tmp/
```

Then extract it into the new host's system backup directory:

```bash
tar -xf dune-system-20260830-120000-4711-9931.tar.gz.enc.tar \
    -C /path/to/dune/runtime/backups/system/
```

The download is a single `.tar` holding both files a backup is made of: the
encrypted archive and its `.yaml` sidecar. The sidecar holds no secrets, and it is
where Created, Server Title and Battlegroup ID come from -- an archive without one
still lists, but those columns read `Unknown`. Bundling them means there is no
second file to forget, and no way to pair an archive with the wrong sidecar.

The `.tar` is not compressed. Its contents are already encrypted and so
incompressible, and a known size is what lets the console stream a multi-gigabyte
archive instead of building it in memory first.

Both files keep their original names inside the `.tar`. Restore, download and
delete all validate those names, so do not rename them after extracting.

Once the files are in place they appear on the Backups page and can be restored
normally.

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
already invalidated its own session. Restart the stack yourself once the report
looks right:

```bash
dune restart
```

If the archive's Battlegroup ID differs from the current one, you are asked
whether to adopt the backup's identity or keep the current one — the same
choice, and the same handling, as a database restore.

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

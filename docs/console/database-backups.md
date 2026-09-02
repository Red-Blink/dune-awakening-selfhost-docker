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

### Restoring on the new host

There is **no automated restore yet**. Decrypt and extract by hand — the exact
command is printed when the backup is created and stored in the archive's own
`.yaml` sidecar, which contains no secrets and is safe to read on its own:

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

Restore `.env`, `runtime/generated/` and `runtime/secrets/` from the extracted
tree, then use `dune db restore` for the database dump inside it, then restart
the stack so the services pick up the restored configuration.

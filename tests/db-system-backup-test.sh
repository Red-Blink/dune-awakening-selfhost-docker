#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

bin_dir="$test_root/bin"
mkdir -p "$bin_dir"

cat > "$bin_dir/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >> "${MOCK_DOCKER_LOG:-/dev/null}"

case "${1:-} ${2:-}" in
  "ps --format")
    # A state FILE, not just the env var, so a stub start-postgres.sh can flip
    # this mid-run the way the real one does -- a child process cannot change
    # its parent's environment, and "Postgres came up because we started it"
    # is the whole point of the autostart cases.
    running="${MOCK_POSTGRES_RUNNING:-1}"
    if [ -n "${MOCK_POSTGRES_STATE_FILE:-}" ] && [ -r "${MOCK_POSTGRES_STATE_FILE}" ]; then
      running="$(cat "${MOCK_POSTGRES_STATE_FILE}")"
    fi
    if [ "$running" = "1" ]; then
      printf '%s\n' dune-postgres
    fi
    ;;
  "ps -a")
    # `docker ps -a` -- the exists-but-stopped probe. Nothing in this repo
    # produces that state (every teardown is rm -f), so it defaults to absent.
    if [ "${MOCK_POSTGRES_EXISTS:-0}" = "1" ]; then
      printf '%s\n' dune-postgres
    fi
    ;;
  "images --format")
    # Defaults to present so every case written before the image pre-check
    # existed keeps exercising what it was written for.
    if [ "${MOCK_POSTGRES_IMAGE_PRESENT:-1}" = "1" ]; then
      printf '%s\n' registry.funcom.com/funcom/self-hosting/igw-postgres
    fi
    ;;
  "start dune-postgres")
    [ -z "${MOCK_POSTGRES_STATE_FILE:-}" ] || printf 1 > "${MOCK_POSTGRES_STATE_FILE}"
    ;;
  "exec dune-postgres")
    shift 2
    case "${1:-}" in
      psql)
        printf '%s\n' "${MOCK_PARTITION_COUNT:-30}"
        ;;
      pg_dump)
        ;;
      pg_restore)
        cat <<'TOC'
5; 2615 16385 SCHEMA - dune dune
212; 1259 16432 TABLE dune world_partition dune
3872; 0 16432 TABLE DATA dune world_partition dune
TOC
        ;;
      rm)
        ;;
    esac
    ;;
  "cp dune-postgres:"*)
    destination="${3:-}"
    mkdir -p "$(dirname "$destination")"
    printf '%s\n' mock-custom-archive > "$destination"
    ;;
  "cp "*)
    ;;
esac
EOF
chmod +x "$bin_dir/docker"

# Real secret values planted in every location the archive should retain
# verbatim (this feature deliberately does NOT redact/exclude anything --
# encryption is the only access control), so a real round-trip decrypt can
# assert every one of them survives correctly.
SECRET_ADMIN_PASSWORD="admin-pw-8f2a-real"
SECRET_SIETCH_PASSWORD="sietch-pw-9f2a-real"
SECRET_FUNCOM_TOKEN="funcom-token-77bb-real"
TEST_PASSPHRASE="correct-horse-battery-staple-9f2a"
# Stage 2 of the age-based secrets library: a placeholder enc:v2:
# payload and its migration marker, seeded to prove db backup-system's
# existing verbatim tar of
# runtime/secrets/ (and, separately, runtime/generated/) already covers
# both artifact types this stage introduces -- not just plain .txt
# secrets. Not real ciphertext (no age/KEK setup in this test file, which
# predates Stage 2) -- this test only proves byte-for-byte survival
# through the backup/restore round-trip, not that it decrypts.
STAGE2_ENC_PAYLOAD="enc:v2:1:cGxhY2Vob2xkZXItd3JhcHBlZC1kZWs=:cGxhY2Vob2xkZXItY2lwaGVydGV4dA=="

seed_repo_tree() {
  local root="$1"

  mkdir -p "$root/runtime/scripts" "$root/runtime/generated" "$root/runtime/secrets" \
    "$root/runtime/backups/system"
  cp runtime/scripts/db.sh "$root/runtime/scripts/db.sh"
  cp runtime/scripts/host-file-ownership.sh "$root/runtime/scripts/host-file-ownership.sh"
  [ ! -f runtime/scripts/env-file.sh ] || cp runtime/scripts/env-file.sh "$root/runtime/scripts/env-file.sh"
  [ ! -f runtime/scripts/battlegroup-identity.sh ] || cp runtime/scripts/battlegroup-identity.sh "$root/runtime/scripts/battlegroup-identity.sh"

  cat > "$root/.env" <<EOF
SERVER_TITLE="Test Server"
SERVER_REGION="Test Region"
ADMIN_PASSWORD=$SECRET_ADMIN_PASSWORD
EOF

  cat > "$root/runtime/generated/battlegroup.env" <<'EOF'
BATTLEGROUP_ID=sh-test-1234
SERVER_IP=203.0.113.5
SERVER_IP_MODE=public
EOF

  printf '{"sietches":[{"password": "%s"}]}\n' "$SECRET_SIETCH_PASSWORD" \
    > "$root/runtime/generated/sietch-config.json"

  mkdir -p "$root/runtime/generated/dune-fake-k8s-serviceaccount-director-12345"
  printf 'fake-token\n' > "$root/runtime/generated/dune-fake-k8s-serviceaccount-director-12345/token"

  printf '%s\n' "$SECRET_FUNCOM_TOKEN" > "$root/runtime/secrets/funcom-token.txt"
  printf 'admin-web-secret-value\n' > "$root/runtime/secrets/admin-web-password.txt"

  # Stage 2 deliverable #4: seed a .enc file and its migration marker
  # alongside the plain .txt secrets above, so the happy-path assertions
  # below can confirm both new artifact types survive the same tar
  # staging this test already exercises for runtime/secrets/ and
  # runtime/generated/, with zero changes needed to db.sh itself.
  printf '%s' "$STAGE2_ENC_PAYLOAD" > "$root/runtime/secrets/server-login-password-secret.enc"
  mkdir -p "$root/runtime/generated/.secrets-migrated"
  printf '2026-08-17T00:00:00Z' > "$root/runtime/generated/.secrets-migrated/server-login-password-secret.done"
}

decrypt_and_extract() {
  local archive="$1"
  local dest="$2"
  local passphrase="$3"
  mkdir -p "$dest"
  local gnupg_home
  gnupg_home="$(mktemp -d)"
  printf '%s' "$passphrase" \
    | GNUPGHOME="$gnupg_home" gpg --batch --yes --pinentry-mode loopback \
        --passphrase-fd 0 -d "$archive" 2>/dev/null \
    | gunzip 2>/dev/null | tar -xf - -C "$dest" 2>/dev/null
  rm -rf -- "$gnupg_home"
}

# --- Case 1: happy path, non-interactive passphrase, full round-trip ------

case1_root="$test_root/case1"
mkdir -p "$case1_root/work"
seed_repo_tree "$case1_root/work"

set +e
(
  cd "$case1_root/work"
  PATH="$bin_dir:$PATH" MOCK_DOCKER_LOG="$case1_root/docker.log" \
    DUNE_SYSTEM_BACKUP_PASSPHRASE="$TEST_PASSPHRASE" \
    bash runtime/scripts/db.sh backup-system
) > "$case1_root/output.log" 2>&1
case1_exit=$?
set -e

if [ "$case1_exit" -ne 0 ]; then
  echo "FAIL happy-path: expected exit 0, got $case1_exit"
  cat "$case1_root/output.log"
  exit 1
fi

case1_archive="$(find "$case1_root/work/runtime/backups/system" -maxdepth 1 -name '*.tar.gz.enc' | head -n1)"
if [ -z "$case1_archive" ] || [ ! -f "$case1_archive" ]; then
  echo "FAIL happy-path: no *.tar.gz.enc archive was written"
  cat "$case1_root/output.log"
  exit 1
fi
if [ ! -f "$case1_archive.yaml" ]; then
  echo "FAIL happy-path: archive sidecar .yaml is missing"
  exit 1
fi

case1_perms="$(stat -c '%a' "$case1_archive")"
if [ "$case1_perms" != "600" ]; then
  echo "FAIL happy-path: expected archive mode 600, got $case1_perms"
  exit 1
fi

# Decisive check: the archive must not be readable with the wrong passphrase...
case1_wrong_extract="$test_root/case1-wrong-extract"
decrypt_and_extract "$case1_archive" "$case1_wrong_extract" "wrong-passphrase-entirely" || true
if find "$case1_wrong_extract" -type f 2>/dev/null | grep -q .; then
  echo "FAIL happy-path: archive decrypted successfully with the WRONG passphrase"
  exit 1
fi

# ...but must decrypt cleanly and completely with the right one, retaining
# every credential verbatim (no redaction -- that is the point of this design).
case1_extract="$test_root/case1-extract"
decrypt_and_extract "$case1_archive" "$case1_extract" "$TEST_PASSPHRASE"
if ! grep -q "$SECRET_ADMIN_PASSWORD" "$case1_extract/env" 2>/dev/null; then
  echo "FAIL happy-path: ADMIN_PASSWORD did not survive decryption in .env"
  exit 1
fi
if ! grep -q "$SECRET_SIETCH_PASSWORD" "$case1_extract/generated/sietch-config.json" 2>/dev/null; then
  echo "FAIL happy-path: sietch join password did not survive decryption"
  exit 1
fi
if ! grep -q "$SECRET_FUNCOM_TOKEN" "$case1_extract/secrets/funcom-token.txt" 2>/dev/null; then
  echo "FAIL happy-path: Funcom token did not survive decryption"
  exit 1
fi
# Stage 2 deliverable #4: confirm the .enc file and its migration
# marker survive the backup/restore round-trip byte-for-byte, closing
# the design doc's own NEEDS-MORE-EVIDENCE grade for "backup and
# restore" -- this was previously an unverified-but-plausible code-read
# claim (db.sh:924-932 tars runtime/secrets/ verbatim), not an actual
# tested assertion.
if [ "$(cat "$case1_extract/secrets/server-login-password-secret.enc" 2>/dev/null)" != "$STAGE2_ENC_PAYLOAD" ]; then
  echo "FAIL happy-path: Stage 2 .enc secret did not survive the backup/restore round-trip byte-for-byte"
  exit 1
fi
if [ ! -f "$case1_extract/generated/.secrets-migrated/server-login-password-secret.done" ]; then
  echo "FAIL happy-path: Stage 2 migration marker did not survive the backup/restore round-trip"
  exit 1
fi
if [ -d "$case1_extract/generated/dune-fake-k8s-serviceaccount-director-12345" ]; then
  echo "FAIL happy-path: ephemeral fake-k8s-serviceaccount dir should be excluded"
  exit 1
fi
if ! find "$case1_extract/db" -name '*.backup' | grep -q .; then
  echo "FAIL happy-path: no database dump found inside the decrypted archive"
  exit 1
fi

# The sidecar YAML must be readable without the passphrase and must contain
# no secret material -- it's meant to be safe to read/share on its own.
if ! grep -q 'includes_secrets: true' "$case1_archive.yaml"; then
  echo "FAIL happy-path: sidecar does not declare includes_secrets: true"
  exit 1
fi
if grep -q "$SECRET_ADMIN_PASSWORD\|$SECRET_SIETCH_PASSWORD\|$SECRET_FUNCOM_TOKEN" "$case1_archive.yaml"; then
  echo "FAIL happy-path: sidecar itself leaked a secret value in plaintext"
  exit 1
fi

# The intermediate plaintext DB dump backup_db() writes must NOT survive --
# only the encrypted archive + its sidecar should remain in out_dir.
case1_plaintext_leftovers="$(find "$case1_root/work/runtime/backups/system" -maxdepth 1 -type f ! -name '*.tar.gz.enc' ! -name '*.tar.gz.enc.yaml')"
if [ -n "$case1_plaintext_leftovers" ]; then
  echo "FAIL happy-path: plaintext files were left behind alongside the encrypted archive"
  printf '%s\n' "$case1_plaintext_leftovers"
  exit 1
fi
echo "PASS happy-path"

# --- Case 2: [output-dir] argument is honored for BOTH the archive AND ----
# --- the underlying database dump (regression test for a real bug found --
# --- in review: backup_db() was previously always hardcoded to the       --
# --- default db backup dir regardless of the caller's requested dir).    -

case2_root="$test_root/case2"
mkdir -p "$case2_root/work" "$case2_root/customdir"
seed_repo_tree "$case2_root/work"

set +e
(
  cd "$case2_root/work"
  PATH="$bin_dir:$PATH" DUNE_SYSTEM_BACKUP_PASSPHRASE="$TEST_PASSPHRASE" \
    bash runtime/scripts/db.sh backup-system "$case2_root/customdir"
) > "$case2_root/output.log" 2>&1
case2_exit=$?
set -e

if [ "$case2_exit" -ne 0 ]; then
  echo "FAIL output-dir-honored: expected exit 0, got $case2_exit"
  cat "$case2_root/output.log"
  exit 1
fi
if ! find "$case2_root/customdir" -maxdepth 1 -name '*.tar.gz.enc' | grep -q .; then
  echo "FAIL output-dir-honored: encrypted archive was not written to the requested output-dir"
  exit 1
fi
if find "$case2_root/work/runtime/backups/db" -maxdepth 1 -type f 2>/dev/null | grep -q .; then
  echo "FAIL output-dir-honored: the underlying database dump ignored [output-dir] and used the default dir instead"
  find "$case2_root/work/runtime/backups/db" -maxdepth 1 -type f -print
  exit 1
fi
echo "PASS output-dir-honored"

# --- Case 3: fails cleanly with postgres down, zero artifacts left -------

case3_root="$test_root/case3"
mkdir -p "$case3_root/work"
seed_repo_tree "$case3_root/work"

set +e
(
  cd "$case3_root/work"
  PATH="$bin_dir:$PATH" MOCK_POSTGRES_RUNNING=0 DUNE_SYSTEM_BACKUP_PASSPHRASE="$TEST_PASSPHRASE" \
    bash runtime/scripts/db.sh backup-system
) > "$case3_root/output.log" 2>&1
case3_exit=$?
set -e

if [ "$case3_exit" -eq 0 ]; then
  echo "FAIL fails-without-postgres: expected non-zero exit when dune-postgres is not running"
  cat "$case3_root/output.log"
  exit 1
fi
if find "$case3_root/work/runtime/backups/system" -maxdepth 1 -type f | grep -q .; then
  echo "FAIL fails-without-postgres: a partial/published artifact was left behind"
  find "$case3_root/work/runtime/backups/system" -maxdepth 1 -type f -print
  exit 1
fi
echo "PASS fails-without-postgres"

# --- Case 4: passphrase confirmation mismatch aborts with zero artifacts -

case4_root="$test_root/case4"
mkdir -p "$case4_root/work"
seed_repo_tree "$case4_root/work"

set +e
(
  cd "$case4_root/work"
  printf 'firstpass\nDIFFERENTpass\n' | PATH="$bin_dir:$PATH" \
    script -qec "bash runtime/scripts/db.sh backup-system" /dev/null
) > "$case4_root/output.log" 2>&1
case4_exit=$?
set -e

if [ "$case4_exit" -eq 0 ]; then
  echo "FAIL passphrase-mismatch-aborts: expected non-zero exit on passphrase confirmation mismatch"
  cat "$case4_root/output.log"
  exit 1
fi
if ! grep -qi 'did not match' "$case4_root/output.log"; then
  echo "FAIL passphrase-mismatch-aborts: expected a clear 'did not match' message"
  cat "$case4_root/output.log"
  exit 1
fi
if find "$case4_root/work/runtime/backups/system" -maxdepth 1 -type f | grep -q .; then
  echo "FAIL passphrase-mismatch-aborts: an artifact was created despite the passphrase mismatch"
  exit 1
fi
echo "PASS passphrase-mismatch-aborts"

# --- Case 5: mid-run failure after the plaintext DB dump has already -----
# --- been written must clean up BOTH the staging state AND that dump --  --
# --- regression test for the exact CRITICAL finding from the Layer 3 --  --
# --- eight-hats review: a `trap ... RETURN` does not reliably fire when --
# --- `set -e` aborts out of a function, so an unguarded tar/cp          --
# --- failure used to leave a plaintext database dump (and, in a         --
# --- separately-verified worse case, plaintext secrets) sitting on disk.-

case5_root="$test_root/case5"
mkdir -p "$case5_root/work" "$case5_root/altbin"
seed_repo_tree "$case5_root/work"
cp "$bin_dir/docker" "$case5_root/altbin/docker"
# Wraps the real tar, failing only the specific invocation that packs
# runtime/secrets/ (identified by its -C argument) -- every other tar
# call (packing runtime/generated/, the plaintext DB dump, the final
# plaintext archive, or unpacking on the receiving end of either pipe)
# must still succeed, so this failure injection is realistic and narrow,
# not a blanket "tar always fails" stub.
cat > "$case5_root/altbin/tar" <<'EOF'
#!/usr/bin/env bash
prev=""
for arg in "$@"; do
  if [ "$prev" = "-C" ] && [ "$arg" = "runtime/secrets" ]; then
    echo "tar: simulated I/O error packing runtime/secrets/" >&2
    exit 23
  fi
  prev="$arg"
done
exec /usr/bin/tar "$@"
EOF
chmod +x "$case5_root/altbin/tar"

set +e
(
  cd "$case5_root/work"
  PATH="$case5_root/altbin:$PATH" DUNE_SYSTEM_BACKUP_PASSPHRASE="$TEST_PASSPHRASE" \
    bash runtime/scripts/db.sh backup-system
) > "$case5_root/output.log" 2>&1
case5_exit=$?
set -e

if [ "$case5_exit" -eq 0 ]; then
  echo "FAIL cleanup-on-mid-run-failure: expected non-zero exit on simulated rsync failure"
  cat "$case5_root/output.log"
  exit 1
fi
if find "$case5_root/work/runtime/backups/system" -maxdepth 1 -type f | grep -q .; then
  echo "FAIL cleanup-on-mid-run-failure: a plaintext database dump (or other artifact) was left behind after a mid-run failure"
  find "$case5_root/work/runtime/backups/system" -maxdepth 1 -type f -print
  exit 1
fi
# Also confirm no stray temp directory/file anywhere under this run's own
# staging root still contains the planted Funcom token in plaintext, other
# than its own original, legitimate seeded location. Deliberately scoped
# to $case5_root (not all of /tmp) so this check cannot false-positive on
# the same fixture value legitimately seeded by the other cases in this
# same test file, running in sibling directories under the shared $test_root.
case5_leaks="$(grep -rl "$SECRET_FUNCOM_TOKEN" "$case5_root" 2>/dev/null | grep -v "^$case5_root/work/runtime/secrets/funcom-token.txt$" || true)"
if [ -n "$case5_leaks" ]; then
  echo "FAIL cleanup-on-mid-run-failure: the Funcom token leaked into a temp file/directory outside its original location"
  printf '%s\n' "$case5_leaks"
  exit 1
fi
echo "PASS cleanup-on-mid-run-failure"

# --- Case 6: list-system reports written archives -------------------------

case6_root="$test_root/case6"
mkdir -p "$case6_root/work"
seed_repo_tree "$case6_root/work"

(
  cd "$case6_root/work"
  PATH="$bin_dir:$PATH" DUNE_SYSTEM_BACKUP_PASSPHRASE="$TEST_PASSPHRASE" \
    bash runtime/scripts/db.sh backup-system >/dev/null 2>&1
)

case6_output="$(cd "$case6_root/work" && PATH="$bin_dir:$PATH" bash runtime/scripts/db.sh list-system 2>&1)"
if ! printf '%s' "$case6_output" | grep -q 'dune-system-.*\.tar\.gz\.enc'; then
  echo "FAIL list-system-reports-archive: list-system did not report the written encrypted archive"
  printf '%s\n' "$case6_output"
  exit 1
fi
echo "PASS list-system-reports-archive"

# --- Case 7: no passphrase available non-interactively fails safely, -----
# --- before touching Postgres or the filesystem at all --------------------

case7_root="$test_root/case7"
mkdir -p "$case7_root/work"
seed_repo_tree "$case7_root/work"

set +e
(
  cd "$case7_root/work"
  PATH="$bin_dir:$PATH" MOCK_DOCKER_LOG="$case7_root/docker.log" \
    bash runtime/scripts/db.sh backup-system < /dev/null
) > "$case7_root/output.log" 2>&1
case7_exit=$?
set -e

if [ "$case7_exit" -eq 0 ]; then
  echo "FAIL no-passphrase-available-fails-safely: expected non-zero exit with no TTY and no DUNE_SYSTEM_BACKUP_PASSPHRASE"
  cat "$case7_root/output.log"
  exit 1
fi
if [ -f "$case7_root/docker.log" ] && grep -q . "$case7_root/docker.log"; then
  echo "FAIL no-passphrase-available-fails-safely: docker was invoked before a passphrase was resolved"
  cat "$case7_root/docker.log"
  exit 1
fi
echo "PASS no-passphrase-available-fails-safely"

# --- Case 8: two concurrent, same-second invocations must never cross- ---
# --- contaminate each other's database dump content -- regression test  -
# --- for a real CRITICAL finding from the Layer 2/3 eight-hats review:  -
# --- backup_db() names its output using only second-resolution          -
# --- timestamps (shared, pre-existing, load-bearing for `dune db list`'s-
# --- naming/validation regex elsewhere in this file -- not something    -
# --- this feature should change). Two backup_db() calls landing in the -
# --- same wall-clock second previously computed the IDENTICAL           -
# --- destination path and silently overwrote each other before          -
# --- backup_system() read the result back -- independently reproduced: -
# --- two concurrent invocations produced two distinct, correctly unique-
# --- encrypted archives that BOTH silently contained the SAME database -
# --- dump content, with no error or indication anywhere. Fixed by      -
# --- giving backup_db() a private, per-invocation directory.            -

case8_root="$test_root/case8"
mkdir -p "$case8_root/work-a" "$case8_root/work-b" "$case8_root/altbin"
seed_repo_tree "$case8_root/work-a"
seed_repo_tree "$case8_root/work-b"

# A docker mock whose pg_dump output is tagged with a per-invocation
# marker (via env var), so a decrypted archive's content can be traced
# back to exactly which invocation actually produced it.
cat > "$case8_root/altbin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-} ${2:-}" in
  "ps --format")
    printf '%s\n' dune-postgres
    ;;
  "exec dune-postgres")
    shift 2
    case "${1:-}" in
      psql)
        printf '%s\n' "${MOCK_PARTITION_COUNT:-30}"
        ;;
      pg_dump) ;;
      pg_restore)
        cat <<'TOC'
5; 2615 16385 SCHEMA - dune dune
212; 1259 16432 TABLE dune world_partition dune
3872; 0 16432 TABLE DATA dune world_partition dune
TOC
        ;;
      rm) ;;
    esac
    ;;
  "cp dune-postgres:"*)
    destination="${3:-}"
    mkdir -p "$(dirname "$destination")"
    printf 'MARKER=%s\n' "${MOCK_INVOCATION_MARKER:-none}" > "$destination"
    ;;
  "cp "*)
    ;;
esac
EOF
chmod +x "$case8_root/altbin/docker"

PASSPHRASE_A="case8-passphrase-a"
PASSPHRASE_B="case8-passphrase-b"

(
  cd "$case8_root/work-a"
  PATH="$case8_root/altbin:$PATH" MOCK_INVOCATION_MARKER="RUN-A" \
    DUNE_SYSTEM_BACKUP_PASSPHRASE="$PASSPHRASE_A" \
    bash runtime/scripts/db.sh backup-system > "$case8_root/output-a.log" 2>&1
) &
case8_pid_a=$!
(
  cd "$case8_root/work-b"
  PATH="$case8_root/altbin:$PATH" MOCK_INVOCATION_MARKER="RUN-B" \
    DUNE_SYSTEM_BACKUP_PASSPHRASE="$PASSPHRASE_B" \
    bash runtime/scripts/db.sh backup-system > "$case8_root/output-b.log" 2>&1
) &
case8_pid_b=$!

set +e
wait "$case8_pid_a"; case8_exit_a=$?
wait "$case8_pid_b"; case8_exit_b=$?
set -e

if [ "$case8_exit_a" -ne 0 ] || [ "$case8_exit_b" -ne 0 ]; then
  echo "FAIL concurrent-invocations-no-cross-contamination: one or both concurrent runs failed"
  echo "--- run A output ---"; cat "$case8_root/output-a.log"
  echo "--- run B output ---"; cat "$case8_root/output-b.log"
  exit 1
fi

case8_archive_a="$(find "$case8_root/work-a/runtime/backups/system" -maxdepth 1 -name '*.tar.gz.enc' | head -n1)"
case8_archive_b="$(find "$case8_root/work-b/runtime/backups/system" -maxdepth 1 -name '*.tar.gz.enc' | head -n1)"
if [ -z "$case8_archive_a" ] || [ -z "$case8_archive_b" ]; then
  echo "FAIL concurrent-invocations-no-cross-contamination: one or both archives were not written"
  exit 1
fi

case8_extract_a="$test_root/case8-extract-a"
case8_extract_b="$test_root/case8-extract-b"
decrypt_and_extract "$case8_archive_a" "$case8_extract_a" "$PASSPHRASE_A"
decrypt_and_extract "$case8_archive_b" "$case8_extract_b" "$PASSPHRASE_B"

case8_dump_a="$(find "$case8_extract_a/db" -name '*.backup' | head -n1)"
case8_dump_b="$(find "$case8_extract_b/db" -name '*.backup' | head -n1)"
if [ -z "$case8_dump_a" ] || [ -z "$case8_dump_b" ]; then
  echo "FAIL concurrent-invocations-no-cross-contamination: could not find a database dump inside one or both decrypted archives"
  exit 1
fi

if ! grep -q "MARKER=RUN-A" "$case8_dump_a" 2>/dev/null; then
  echo "FAIL concurrent-invocations-no-cross-contamination: run A's archive does not contain run A's own database dump content (cross-contamination)"
  cat "$case8_dump_a"
  exit 1
fi
if ! grep -q "MARKER=RUN-B" "$case8_dump_b" 2>/dev/null; then
  echo "FAIL concurrent-invocations-no-cross-contamination: run B's archive does not contain run B's own database dump content (cross-contamination)"
  cat "$case8_dump_b"
  exit 1
fi

# Also confirm no stray per-invocation dump directory (the private
# staging directory backup_db() writes into) survives in either work
# tree after a successful run -- only the encrypted archive + sidecar.
if find "$case8_root/work-a/runtime/backups/system" -maxdepth 1 -type d -name '.dune-db-dump-*' | grep -q .; then
  echo "FAIL concurrent-invocations-no-cross-contamination: run A left a private dump staging directory behind"
  exit 1
fi
if find "$case8_root/work-b/runtime/backups/system" -maxdepth 1 -type d -name '.dune-db-dump-*' | grep -q .; then
  echo "FAIL concurrent-invocations-no-cross-contamination: run B left a private dump staging directory behind"
  exit 1
fi
echo "PASS concurrent-invocations-no-cross-contamination"

# --- Case 9: a tampered/corrupted encrypted archive must be REJECTED
# outright at decrypt time (nonzero exit, no output written), not
# silently accepted or partially extracted -- direct regression coverage
# for the exact upstream review finding that switched this feature from
# AES-256-CBC (confidentiality only, no integrity check) to gpg's
# AES-256-OCB (AEAD): a corrupted ciphertext must be detected and
# rejected, not silently decrypted to garbage or manipulated plaintext.

case9_root="$test_root/case9"
mkdir -p "$case9_root/work"
seed_repo_tree "$case9_root/work"

set +e
(
  cd "$case9_root/work"
  PATH="$bin_dir:$PATH" DUNE_SYSTEM_BACKUP_PASSPHRASE="$TEST_PASSPHRASE" \
    bash runtime/scripts/db.sh backup-system
) > "$case9_root/output.log" 2>&1
case9_exit=$?
set -e

if [ "$case9_exit" -ne 0 ]; then
  echo "FAIL tampered-archive-rejected: setup (creating the archive to tamper with) failed"
  cat "$case9_root/output.log"
  exit 1
fi

case9_archive="$(find "$case9_root/work/runtime/backups/system" -maxdepth 1 -name '*.tar.gz.enc' | head -n1)"
if [ -z "$case9_archive" ]; then
  echo "FAIL tampered-archive-rejected: no archive was created to tamper with"
  exit 1
fi

# Flip a single byte roughly in the middle of the ciphertext -- anywhere
# in an AEAD payload's ciphertext or auth tag must be detected, not just
# the boundary bytes.
case9_tampered="$test_root/case9-tampered.tar.gz.enc"
cp "$case9_archive" "$case9_tampered"
python3 -c "
import sys
path = sys.argv[1]
with open(path, 'r+b') as f:
    data = bytearray(f.read())
    mid = len(data) // 2
    data[mid] ^= 0xFF
    f.seek(0)
    f.write(bytes(data))
" "$case9_tampered"

case9_extract="$test_root/case9-extract"
mkdir -p "$case9_extract"
case9_gnupg_home="$(mktemp -d)"
set +e
printf '%s' "$TEST_PASSPHRASE" \
  | GNUPGHOME="$case9_gnupg_home" gpg --batch --yes --pinentry-mode loopback \
      --passphrase-fd 0 -o "$test_root/case9-decrypted.tar.gz" -d "$case9_tampered" \
  > "$case9_root/decrypt.log" 2>&1
case9_decrypt_exit=$?
set -e
rm -rf -- "$case9_gnupg_home"

if [ "$case9_decrypt_exit" -eq 0 ]; then
  echo "FAIL tampered-archive-rejected: gpg accepted a tampered archive (exit 0) instead of rejecting it"
  cat "$case9_root/decrypt.log"
  exit 1
fi
if [ -f "$test_root/case9-decrypted.tar.gz" ]; then
  echo "FAIL tampered-archive-rejected: gpg wrote output for a tampered archive instead of refusing to write anything"
  exit 1
fi
if ! grep -qi 'manipulated\|checksum\|bad session key\|decryption failed' "$case9_root/decrypt.log"; then
  echo "FAIL tampered-archive-rejected: expected a clear tamper/corruption rejection message from gpg"
  cat "$case9_root/decrypt.log"
  exit 1
fi
echo "PASS tampered-archive-rejected"

# --- Case 10: a simulated disk-full/interrupted failure DURING gpg
# encryption itself (not before it, which cases 3/4/5 already cover) must
# leave zero artifacts behind -- direct coverage for the upstream review
# suggestion to test low-disk/interrupted backups given this feature
# duplicates the database and generated state through /tmp before
# encrypting. Wraps gpg to fail partway through, simulating ENOSPC.

case10_root="$test_root/case10"
mkdir -p "$case10_root/work" "$case10_root/altbin"
seed_repo_tree "$case10_root/work"
cp "$bin_dir/docker" "$case10_root/altbin/docker"
cat > "$case10_root/altbin/gpg" <<'EOF'
#!/usr/bin/env bash
# backup_system probes for AEAD support before it does any work. This stub
# simulates a failure DURING encryption, not an unusable gpg, so the probe
# must succeed -- otherwise the run aborts at the preflight and this case
# silently stops covering what it claims to.
if [ "${1:-}" = "--dump-options" ]; then
  printf '%s\n' --aead-algo
  exit 0
fi
echo "gpg: simulated disk-full failure (ENOSPC) during encryption" >&2
exit 1
EOF
chmod +x "$case10_root/altbin/gpg"

set +e
(
  cd "$case10_root/work"
  PATH="$case10_root/altbin:$bin_dir:$PATH" DUNE_SYSTEM_BACKUP_PASSPHRASE="$TEST_PASSPHRASE" \
    bash runtime/scripts/db.sh backup-system
) > "$case10_root/output.log" 2>&1
case10_exit=$?
set -e

if [ "$case10_exit" -eq 0 ]; then
  echo "FAIL disk-full-during-encryption-cleans-up: expected non-zero exit when gpg fails mid-encryption"
  cat "$case10_root/output.log"
  exit 1
fi
if find "$case10_root/work/runtime/backups/system" -maxdepth 1 -type f | grep -q .; then
  echo "FAIL disk-full-during-encryption-cleans-up: an artifact was left behind after a simulated gpg failure"
  find "$case10_root/work/runtime/backups/system" -maxdepth 1 -type f -print
  exit 1
fi
# Also confirm the private, per-invocation GNUPGHOME directory created for
# this run does not survive -- it would otherwise accumulate one leaked
# temp directory per failed backup attempt.
case10_leaked_gnupg_home=""
while IFS= read -r -d '' case10_tmp_dir; do
  if [ -f "$case10_tmp_dir/pubring.kbx" ]; then
    case10_leaked_gnupg_home="$case10_tmp_dir"
    break
  fi
done < <(find "$test_root" -maxdepth 1 -type d -name 'tmp.*' -print0 2>/dev/null)
if [ -n "$case10_leaked_gnupg_home" ]; then
  echo "FAIL disk-full-during-encryption-cleans-up: a GNUPGHOME staging directory was left behind at $case10_leaked_gnupg_home"
  exit 1
fi
echo "PASS disk-full-during-encryption-cleans-up"

# =========================================================================
# restore-system cases.
#
# Every case below builds a real archive with backup-system first, so what
# is restored is what this script actually produced -- not a fixture that
# can drift away from the writer.
#
# Each case gets its own TMPDIR. restore_system stages plaintext through
# mktemp, and a leftover from one case must never be able to satisfy or
# contaminate another case's leak check.
# =========================================================================

# Builds a work tree with one archive in it. Echoes the archive path.
make_restorable_archive() {
  local root="$1"
  mkdir -p "$root/work"
  seed_repo_tree "$root/work"
  (
    cd "$root/work"
    PATH="$bin_dir:$PATH" DUNE_SYSTEM_BACKUP_PASSPHRASE="$TEST_PASSPHRASE" \
      bash runtime/scripts/db.sh backup-system
  ) > "$root/backup.log" 2>&1
  find "$root/work/runtime/backups/system" -maxdepth 1 -name '*.tar.gz.enc' | head -n1
}

# Replaces the seeded state so a restore has something to visibly undo.
diverge_host_state() {
  local work="$1"
  printf 'SERVER_TITLE="Diverged Server"\nADMIN_PASSWORD=diverged-pw\n' > "$work/.env"
  printf 'diverged-token\n' > "$work/runtime/secrets/funcom-token.txt"
  printf '{"sietches":[{"password": "diverged-sietch"}]}\n' > "$work/runtime/generated/sietch-config.json"
}

# usage: run_restore <root> <tmpdir> <passphrase> [args...]
run_restore() {
  local root="$1" tmp="$2" passphrase="$3"
  shift 3
  mkdir -p "$tmp"
  local status=0
  (
    cd "$root/work"
    PATH="$bin_dir:$PATH" TMPDIR="$tmp" \
      DUNE_SYSTEM_BACKUP_PASSPHRASE="$passphrase" DUNE_DB_ASSUME_YES=1 \
      bash runtime/scripts/db.sh restore-system "$@"
  ) > "$root/restore.log" 2>&1 || status=$?
  return "$status"
}

# Any file under a case's TMPDIR holding a real secret is a leak.
assert_no_plaintext_leak() {
  local label="$1" tmp="$2"
  if grep -rqs -e "$SECRET_FUNCOM_TOKEN" -e "$SECRET_ADMIN_PASSWORD" "$tmp" 2>/dev/null; then
    echo "FAIL $label: decrypted plaintext was left behind under $tmp"
    grep -rls -e "$SECRET_FUNCOM_TOKEN" -e "$SECRET_ADMIN_PASSWORD" "$tmp" 2>/dev/null
    exit 1
  fi
}

# --- Case 11: full restore round-trip ------------------------------------

case11_root="$test_root/case11"
mkdir -p "$case11_root"
case11_archive="$(make_restorable_archive "$case11_root")"
if [ -z "$case11_archive" ]; then
  echo "FAIL restore-round-trip: could not build an archive to restore"
  cat "$case11_root/backup.log"
  exit 1
fi
diverge_host_state "$case11_root/work"

set +e
run_restore "$case11_root" "$case11_root/tmp" "$TEST_PASSPHRASE" "$case11_archive"
case11_exit=$?
set -e

if [ "$case11_exit" -ne 0 ]; then
  echo "FAIL restore-round-trip: expected exit 0, got $case11_exit"
  cat "$case11_root/restore.log"
  exit 1
fi
if ! grep -q "$SECRET_ADMIN_PASSWORD" "$case11_root/work/.env"; then
  echo "FAIL restore-round-trip: .env was not restored"
  exit 1
fi
if ! grep -q "$SECRET_FUNCOM_TOKEN" "$case11_root/work/runtime/secrets/funcom-token.txt"; then
  echo "FAIL restore-round-trip: the Funcom token was not restored"
  exit 1
fi
if ! grep -q "$SECRET_SIETCH_PASSWORD" "$case11_root/work/runtime/generated/sietch-config.json"; then
  echo "FAIL restore-round-trip: runtime/generated was not restored"
  exit 1
fi
case11_secret_mode="$(stat -c '%a' "$case11_root/work/runtime/secrets/funcom-token.txt")"
if [ "$case11_secret_mode" != "600" ]; then
  echo "FAIL restore-round-trip: expected restored secret mode 600, got $case11_secret_mode"
  exit 1
fi
# The safety copy must hold what was replaced, not what replaced it --
# otherwise it is worthless as an undo.
case11_safety="$(find "$case11_root/work/runtime/backups" -maxdepth 1 -type d -name 'restore-*' | head -n1)"
if [ -z "$case11_safety" ]; then
  echo "FAIL restore-round-trip: no safety copy directory was created"
  exit 1
fi
if ! grep -q "diverged-pw" "$case11_safety/env" 2>/dev/null; then
  echo "FAIL restore-round-trip: the safety copy does not contain the replaced .env"
  exit 1
fi
if grep -q "Restarting Dune stack" "$case11_root/restore.log"; then
  echo "FAIL restore-round-trip: import_db started the stack on the configuration about to be replaced"
  exit 1
fi
if ! grep -q "dune start" "$case11_root/restore.log"; then
  echo "FAIL restore-round-trip: the operator was not told the services are stopped and how to start them"
  exit 1
fi
assert_no_plaintext_leak restore-round-trip "$case11_root/tmp"
echo "PASS restore-round-trip"

# --- Case 12: --dry-run must change nothing ------------------------------

case12_root="$test_root/case12"
mkdir -p "$case12_root"
case12_archive="$(make_restorable_archive "$case12_root")"
diverge_host_state "$case12_root/work"

set +e
run_restore "$case12_root" "$case12_root/tmp" "$TEST_PASSPHRASE" "$case12_archive" --dry-run
case12_exit=$?
set -e

if [ "$case12_exit" -ne 0 ]; then
  echo "FAIL restore-dry-run-changes-nothing: expected exit 0, got $case12_exit"
  cat "$case12_root/restore.log"
  exit 1
fi
if ! grep -qi "dry run" "$case12_root/restore.log"; then
  echo "FAIL restore-dry-run-changes-nothing: the run never reported itself as a dry run"
  exit 1
fi
if ! grep -q "diverged-pw" "$case12_root/work/.env"; then
  echo "FAIL restore-dry-run-changes-nothing: .env was modified by a dry run"
  exit 1
fi
if ! grep -q "diverged-token" "$case12_root/work/runtime/secrets/funcom-token.txt"; then
  echo "FAIL restore-dry-run-changes-nothing: secrets were modified by a dry run"
  exit 1
fi
if find "$case12_root/work/runtime/backups" -maxdepth 1 -type d -name 'restore-*' | grep -q .; then
  echo "FAIL restore-dry-run-changes-nothing: a dry run created a safety copy"
  exit 1
fi
assert_no_plaintext_leak restore-dry-run-changes-nothing "$case12_root/tmp"
echo "PASS restore-dry-run-changes-nothing"

# --- Case 13: the wrong passphrase must refuse and change nothing --------

case13_root="$test_root/case13"
mkdir -p "$case13_root"
case13_archive="$(make_restorable_archive "$case13_root")"
diverge_host_state "$case13_root/work"

set +e
run_restore "$case13_root" "$case13_root/tmp" "wrong-passphrase-entirely" "$case13_archive"
case13_exit=$?
set -e

if [ "$case13_exit" -eq 0 ]; then
  echo "FAIL restore-wrong-passphrase-refuses: expected a non-zero exit"
  cat "$case13_root/restore.log"
  exit 1
fi
if ! grep -qi "could not be decrypted" "$case13_root/restore.log"; then
  echo "FAIL restore-wrong-passphrase-refuses: no clear rejection message was printed"
  cat "$case13_root/restore.log"
  exit 1
fi
if ! grep -q "diverged-pw" "$case13_root/work/.env"; then
  echo "FAIL restore-wrong-passphrase-refuses: .env was modified despite the failure"
  exit 1
fi
assert_no_plaintext_leak restore-wrong-passphrase-refuses "$case13_root/tmp"
echo "PASS restore-wrong-passphrase-refuses"

# --- Case 14: a tampered archive must refuse and change nothing ----------

case14_root="$test_root/case14"
mkdir -p "$case14_root"
case14_archive="$(make_restorable_archive "$case14_root")"
diverge_host_state "$case14_root/work"
# AEAD verifies at the END of the stream, so this also proves the restore
# never acts on a body that decrypted before the tag was checked.
printf '\377' | dd of="$case14_archive" bs=1 seek=900 conv=notrunc status=none

set +e
run_restore "$case14_root" "$case14_root/tmp" "$TEST_PASSPHRASE" "$case14_archive"
case14_exit=$?
set -e

if [ "$case14_exit" -eq 0 ]; then
  echo "FAIL restore-tampered-archive-refuses: a tampered archive was accepted"
  cat "$case14_root/restore.log"
  exit 1
fi
if ! grep -q "diverged-pw" "$case14_root/work/.env"; then
  echo "FAIL restore-tampered-archive-refuses: .env was modified from a tampered archive"
  exit 1
fi
assert_no_plaintext_leak restore-tampered-archive-refuses "$case14_root/tmp"
echo "PASS restore-tampered-archive-refuses"

# --- Case 15: the member allow-list --------------------------------------
# A correctly-encrypted archive is still only allowed to carry the members
# backup_system writes. Encryption proves who wrote it, not what is inside.

case15_root="$test_root/case15"
mkdir -p "$case15_root/work"
seed_repo_tree "$case15_root/work"
case15_gnupg="$case15_root/gnupg"
mkdir -p "$case15_gnupg"
chmod 700 "$case15_gnupg"

# Encrypts a staged tree exactly the way backup_system does.
seal_tree() {
  local tree="$1" out="$2"
  tar -C "$tree" -czf "$tree.tgz" ./
  printf '%s' "$TEST_PASSPHRASE" \
    | GNUPGHOME="$case15_gnupg" gpg --batch --yes --pinentry-mode loopback \
        --passphrase-fd 0 --s2k-digest-algo SHA256 --symmetric \
        --cipher-algo AES256 --aead-algo OCB --force-aead \
        -o "$out" "$tree.tgz" 2>/dev/null
}

case15_check() {
  local label="$1" tree="$2" expect="$3"
  local archive="$case15_root/$label.tar.gz.enc"
  seal_tree "$tree" "$archive"
  local status=0
  run_restore "$case15_root" "$case15_root/tmp-$label" "$TEST_PASSPHRASE" "$archive" || status=$?
  if [ "$status" -eq 0 ]; then
    echo "FAIL restore-refuses-unexpected-members: $label was accepted"
    cat "$case15_root/restore.log"
    exit 1
  fi
  if ! grep -qi "$expect" "$case15_root/restore.log"; then
    echo "FAIL restore-refuses-unexpected-members: $label was refused without saying why (wanted: $expect)"
    cat "$case15_root/restore.log"
    exit 1
  fi
  assert_no_plaintext_leak restore-refuses-unexpected-members "$case15_root/tmp-$label"
}

# An audit log member is NOT refused -- see [[system-backup-audit-log-choice]].
# It is a normal ./generated/* member now; restore_system() decides what to do
# with it rather than refusing the archive outright. Covered properly by the
# adopt/keep cases further down; this only proves the allow-list itself accepts
# it rather than treating it as an unsafe/unexpected member.
case15_audit_ok="$case15_root/tree-audit-ok"
mkdir -p "$case15_audit_ok/db" "$case15_audit_ok/generated" "$case15_audit_ok/secrets"
printf 'x
' > "$case15_audit_ok/env"
printf 'dump
' > "$case15_audit_ok/db/test.backup"
printf '{}
' > "$case15_audit_ok/generated/web-admin-audit.jsonl"
case15_audit_archive="$case15_root/audit-ok.tar.gz.enc"
seal_tree "$case15_audit_ok" "$case15_audit_archive"
case15_audit_status=0
run_restore "$case15_root" "$case15_root/tmp-audit-ok" "$TEST_PASSPHRASE" "$case15_audit_archive" --dry-run || case15_audit_status=$?
if [ "$case15_audit_status" -ne 0 ]; then
  echo "FAIL restore-refuses-unexpected-members: an archive carrying only an audit log (no conflict on this fresh host) was refused"
  cat "$case15_root/restore.log"
  exit 1
fi

# Anything outside the members backup_system writes.
case15_extra="$case15_root/tree-extra"
mkdir -p "$case15_extra/db" "$case15_extra/oops"
printf 'x\n' > "$case15_extra/env"
printf 'dump\n' > "$case15_extra/db/test.backup"
printf 'payload\n' > "$case15_extra/oops/file"
case15_check unexpected-member "$case15_extra" "unexpected member"

# A name carrying .. never reaches the extract, however it got there.
case15_dots="$case15_root/tree-dots"
mkdir -p "$case15_dots/db" "$case15_dots/generated"
printf 'x\n' > "$case15_dots/env"
printf 'dump\n' > "$case15_dots/db/test.backup"
printf 'payload\n' > "$case15_dots/generated/..evil"
case15_check traversal "$case15_dots" "unsafe member"

echo "PASS restore-refuses-unexpected-members"

# --- Case 16: a SIGTERM mid-restore leaves no plaintext behind -----------
# The staging tree holds the decrypted .env and every secret, so an external
# kill must not be able to strand it on disk.
#
# The signal is delivered during the database restore, not during decryption.
# What gpg writes is still a gzipped tar -- nothing readable is on disk yet,
# so a kill there would prove nothing. By the time import_db runs, the tree is
# fully extracted and every secret is sitting in the clear.

case16_root="$test_root/case16"
mkdir -p "$case16_root"
case16_archive="$(make_restorable_archive "$case16_root")"
mkdir -p "$case16_root/altbin" "$case16_root/tmp"

# Behaves like the shared mock up to the point the restore reaches the
# database, then stalls so the signal lands with the tree extracted.
cat > "$case16_root/altbin/docker" <<'STUB'
#!/usr/bin/env bash
case "${1:-} ${2:-}" in
  "ps --format") printf '%s\n' dune-postgres ;;
  *) sleep 30 ;;
esac
STUB
chmod +x "$case16_root/altbin/docker"

(
  cd "$case16_root/work"
  PATH="$case16_root/altbin:$bin_dir:$PATH" TMPDIR="$case16_root/tmp" \
    DUNE_SYSTEM_BACKUP_PASSPHRASE="$TEST_PASSPHRASE" DUNE_DB_ASSUME_YES=1 \
    bash runtime/scripts/db.sh restore-system "$case16_archive"
) > "$case16_root/restore.log" 2>&1 &
case16_pid=$!

# Wait for the extracted secret to actually appear before signalling, rather
# than racing a fixed sleep against it.
case16_ready=0
for _ in $(seq 1 200); do
  if grep -rqs "$SECRET_FUNCOM_TOKEN" "$case16_root/tmp" 2>/dev/null; then
    case16_ready=1
    break
  fi
  sleep 0.1
done
if [ "$case16_ready" -ne 1 ]; then
  kill -TERM "$case16_pid" 2>/dev/null || true
  pkill -TERM -P "$case16_pid" 2>/dev/null || true
  wait "$case16_pid" 2>/dev/null || true
  echo "FAIL restore-sigterm-leaves-no-plaintext: the staged plaintext never appeared, so a signal here would prove nothing"
  cat "$case16_root/restore.log"
  exit 1
fi

kill -TERM "$case16_pid" 2>/dev/null || true
pkill -TERM -P "$case16_pid" 2>/dev/null || true
wait "$case16_pid" 2>/dev/null || true
# The trap runs once bash regains control from the stalled child.
for _ in $(seq 1 100); do
  grep -rqs "$SECRET_FUNCOM_TOKEN" "$case16_root/tmp" 2>/dev/null || break
  sleep 0.1
done

assert_no_plaintext_leak restore-sigterm-leaves-no-plaintext "$case16_root/tmp"
echo "PASS restore-sigterm-leaves-no-plaintext"

# --- Case 17: a failing pg_restore must refuse, and must NOT swap the config --
# import_db used to be called as an `if` condition, which turns errexit off for
# its whole body: pg_restore could fail, import_db returned 0, and this function
# then replaced .env and every secret on top of a broken database.

case17_root="$test_root/case17"
mkdir -p "$case17_root/altbin"
case17_archive="$(make_restorable_archive "$case17_root")"
diverge_host_state "$case17_root/work"

# Fails only the actual restore (pg_restore ... -d dune); the earlier
# `pg_restore -l` TOC check still succeeds, so the failure lands where errexit
# is the only thing that would catch it.
cat > "$case17_root/altbin/docker" <<STUB
#!/usr/bin/env bash
if [ "\${1:-}" = "exec" ] && printf '%s\\n' "\$@" | grep -qx pg_restore && printf '%s\\n' "\$@" | grep -qx -- -d; then
  echo "pg_restore: error: simulated restore failure" >&2
  exit 1
fi
exec "$bin_dir/docker" "\$@"
STUB
chmod +x "$case17_root/altbin/docker"

mkdir -p "$case17_root/tmp"
case17_status=0
(
  cd "$case17_root/work"
  PATH="$case17_root/altbin:$bin_dir:$PATH" TMPDIR="$case17_root/tmp" \
    DUNE_SYSTEM_BACKUP_PASSPHRASE="$TEST_PASSPHRASE" DUNE_DB_ASSUME_YES=1 \
    bash runtime/scripts/db.sh restore-system "$case17_archive"
) > "$case17_root/restore.log" 2>&1 || case17_status=$?

if [ "$case17_status" -eq 0 ]; then
  echo "FAIL restore-refuses-when-pg-restore-fails: a failed pg_restore was reported as success"
  cat "$case17_root/restore.log"
  exit 1
fi
if ! grep -q "NOT changed" "$case17_root/restore.log"; then
  echo "FAIL restore-refuses-when-pg-restore-fails: the failure was not reported"
  cat "$case17_root/restore.log"
  exit 1
fi
if ! grep -q "diverged-pw" "$case17_root/work/.env"; then
  echo "FAIL restore-refuses-when-pg-restore-fails: .env was replaced despite the database restore failing"
  exit 1
fi
if ! grep -q "diverged-token" "$case17_root/work/runtime/secrets/funcom-token.txt"; then
  echo "FAIL restore-refuses-when-pg-restore-fails: secrets were replaced despite the database restore failing"
  exit 1
fi
assert_no_plaintext_leak restore-refuses-when-pg-restore-fails "$case17_root/tmp"
echo "PASS restore-refuses-when-pg-restore-fails"

# --- Case 18: import_db's own `exit` must not skip cleanup -------------------
# import_db reports its own failures with exit, not return. Called from an `if`
# that ended the whole script before restore_system_cleanup ran, leaving the
# decrypted .env and every secret behind in the staging tree.

case18_root="$test_root/case18"
mkdir -p "$case18_root"
case18_archive="$(make_restorable_archive "$case18_root")"
diverge_host_state "$case18_root/work"
# An identity this host does not share with the archive, and no
# --adopt/--keep flag to resolve it: import_db stops rather than guess.
printf 'BATTLEGROUP_ID=sh-current-9999\nSERVER_IP=203.0.113.5\nSERVER_IP_MODE=public\n' \
  > "$case18_root/work/runtime/generated/battlegroup.env"

mkdir -p "$case18_root/tmp"
case18_status=0
(
  cd "$case18_root/work"
  # Postgres is up and healthy here. import_db exits over the unresolved
  # identity instead, which is the exit path this case exists to hold.
  PATH="$bin_dir:$PATH" TMPDIR="$case18_root/tmp" \
    DUNE_SYSTEM_BACKUP_PASSPHRASE="$TEST_PASSPHRASE" DUNE_DB_ASSUME_YES=1 \
    bash runtime/scripts/db.sh restore-system "$case18_archive"
) > "$case18_root/restore.log" 2>&1 || case18_status=$?

if [ "$case18_status" -eq 0 ]; then
  echo "FAIL restore-cleans-up-when-import-exits: expected a non-zero exit"
  cat "$case18_root/restore.log"
  exit 1
fi
if ! grep -q "NOT changed" "$case18_root/restore.log"; then
  echo "FAIL restore-cleans-up-when-import-exits: cleanup path never ran (no NOT changed message)"
  cat "$case18_root/restore.log"
  exit 1
fi
if ! grep -q "diverged-pw" "$case18_root/work/.env"; then
  echo "FAIL restore-cleans-up-when-import-exits: .env was replaced"
  exit 1
fi
# The whole point: the staging tree with plaintext secrets must be gone.
assert_no_plaintext_leak restore-cleans-up-when-import-exits "$case18_root/tmp"
echo "PASS restore-cleans-up-when-import-exits"

# --- Case 19: --keep-current-battlegroup keeps the identity file too ---------
# import_db remaps the imported rows to this host's identity; the archive's
# generated/battlegroup.env then overwrote runtime/generated/, so the database
# and the identity file disagreed.

case19_root="$test_root/case19"
mkdir -p "$case19_root"
case19_archive="$(make_restorable_archive "$case19_root")"
diverge_host_state "$case19_root/work"
printf 'BATTLEGROUP_ID=sh-current-9999\nSERVER_IP=203.0.113.5\nSERVER_IP_MODE=public\n' \
  > "$case19_root/work/runtime/generated/battlegroup.env"

case19_status=0
run_restore "$case19_root" "$case19_root/tmp" "$TEST_PASSPHRASE" "$case19_archive" --keep-current-battlegroup || case19_status=$?

if [ "$case19_status" -ne 0 ]; then
  echo "FAIL restore-keep-current-keeps-identity-file: expected exit 0, got $case19_status"
  cat "$case19_root/restore.log"
  exit 1
fi
if ! grep -q "BATTLEGROUP_ID=sh-current-9999" "$case19_root/work/runtime/generated/battlegroup.env"; then
  echo "FAIL restore-keep-current-keeps-identity-file: the archive's identity overwrote the current one"
  cat "$case19_root/work/runtime/generated/battlegroup.env"
  exit 1
fi
# The rest of generated/ must still have been restored from the archive.
if ! grep -q "$SECRET_SIETCH_PASSWORD" "$case19_root/work/runtime/generated/sietch-config.json"; then
  echo "FAIL restore-keep-current-keeps-identity-file: runtime/generated was not otherwise restored"
  exit 1
fi
assert_no_plaintext_leak restore-keep-current-keeps-identity-file "$case19_root/tmp"
echo "PASS restore-keep-current-keeps-identity-file"

# --- Case 20: restore safety copies are pruned to the newest N ------------
# Each restore-<timestamp>/ is a plaintext .env plus every secret. Unlike an
# encrypted system archive it is not the only copy of anything -- the archive
# it came from still exists -- so it is pruned automatically rather than
# requiring opt-in.

case20_root="$test_root/case20"
mkdir -p "$case20_root"
case20_archive="$(make_restorable_archive "$case20_root")"

case20_restore_once() {
  diverge_host_state "$case20_root/work"
  run_restore "$case20_root" "$case20_root/tmp" "$TEST_PASSPHRASE" "$case20_archive"
  sleep 1.1
}

DUNE_RESTORE_SAFETY_KEEP=2
export DUNE_RESTORE_SAFETY_KEEP
case20_restore_once
case20_restore_once
case20_restore_once
case20_restore_once
unset DUNE_RESTORE_SAFETY_KEEP

case20_count="$(find "$case20_root/work/runtime/backups" -maxdepth 1 -type d -name 'restore-*' | wc -l | tr -d '[:space:]')"
if [ "$case20_count" != "2" ]; then
  echo "FAIL restore-safety-copies-are-pruned: expected 2 kept, found $case20_count"
  find "$case20_root/work/runtime/backups" -maxdepth 1 -type d -name 'restore-*'
  cat "$case20_root/restore.log"
  exit 1
fi
# The two kept must be the two NEWEST, not an arbitrary pair.
case20_kept="$(find "$case20_root/work/runtime/backups" -maxdepth 1 -type d -name 'restore-*' | sort)"
case20_newest_two="$(printf '%s\n' "$case20_kept" | sort -r | head -n2 | sort)"
if [ "$case20_kept" != "$case20_newest_two" ]; then
  echo "FAIL restore-safety-copies-are-pruned: the kept copies were not the newest ones"
  exit 1
fi
echo "PASS restore-safety-copies-are-pruned"

# --- Case 21: DUNE_RESTORE_SAFETY_KEEP=0 keeps every copy ------------------

case21_root="$test_root/case21"
mkdir -p "$case21_root"
case21_archive="$(make_restorable_archive "$case21_root")"

DUNE_RESTORE_SAFETY_KEEP=0
export DUNE_RESTORE_SAFETY_KEEP
diverge_host_state "$case21_root/work"
run_restore "$case21_root" "$case21_root/tmp1" "$TEST_PASSPHRASE" "$case21_archive"
sleep 1.1
diverge_host_state "$case21_root/work"
run_restore "$case21_root" "$case21_root/tmp2" "$TEST_PASSPHRASE" "$case21_archive"
unset DUNE_RESTORE_SAFETY_KEEP

case21_count="$(find "$case21_root/work/runtime/backups" -maxdepth 1 -type d -name 'restore-*' | wc -l | tr -d '[:space:]')"
if [ "$case21_count" != "2" ]; then
  echo "FAIL restore-safety-keep-zero-keeps-all: expected 2 (pruning disabled), found $case21_count"
  exit 1
fi
echo "PASS restore-safety-keep-zero-keeps-all"

# --- Case 22: a real audit log does not make backup_system produce an -----
# archive that restore_system refuses -- found live: a freshly created
# archive on a real host failed its own dry-run restore with "Refusing
# archive: it carries an audit log", because backup_system tarred
# runtime/generated/ verbatim (excluding only the ephemeral k8s-serviceaccount
# dirs) while restore_system refuses any archive containing
# ./generated/web-admin-audit.jsonl. Every host that has ever logged an admin
# action -- virtually all of them -- produced a self-contradicting archive.
# (The fix at the time excluded the file; superseded by [[system-backup-audit-log-choice]],
# which includes it deliberately and resolves it at restore time instead.)

case22_root="$test_root/case22"
mkdir -p "$case22_root/work"
seed_repo_tree "$case22_root/work"
# The exact condition that triggered it: a real audit log already sitting in
# runtime/generated/ at backup time, same as any host that has used the
# console at all.
printf '{"ts":"2026-09-06T00:00:00Z","action":"auth.login"}\n' \
  > "$case22_root/work/runtime/generated/web-admin-audit.jsonl"

case22_status=0
(
  cd "$case22_root/work"
  PATH="$bin_dir:$PATH" DUNE_SYSTEM_BACKUP_PASSPHRASE="$TEST_PASSPHRASE" \
    bash runtime/scripts/db.sh backup-system
) > "$case22_root/backup.log" 2>&1 || case22_status=$?

if [ "$case22_status" -ne 0 ]; then
  echo "FAIL restore-not-refused-for-hosts-with-audit-history: backup-system itself failed"
  cat "$case22_root/backup.log"
  exit 1
fi

case22_archive="$(find "$case22_root/work/runtime/backups/system" -maxdepth 1 -name '*.tar.gz.enc' | head -n1)"
if [ -z "$case22_archive" ]; then
  echo "FAIL restore-not-refused-for-hosts-with-audit-history: no archive was written"
  exit 1
fi

# Superseded by [[system-backup-audit-log-choice]]: the archive DOES carry the
# audit log now, deliberately (backup_system() includes it, restore_system()
# resolves what to do with it at restore time). What this case still proves is
# the original bug's actual symptom: carrying one does not make restore refuse
# the archive outright.
if ! decrypt_and_extract "$case22_archive" "$test_root/case22-extract" "$TEST_PASSPHRASE" || [ ! -f "$test_root/case22-extract/generated/web-admin-audit.jsonl" ]; then
  echo "FAIL restore-not-refused-for-hosts-with-audit-history: the archive does not carry the audit log"
  exit 1
fi

case22_status=0
run_restore "$case22_root" "$case22_root/tmp" "$TEST_PASSPHRASE" "$(basename "$case22_archive")" --dry-run || case22_status=$?

if [ "$case22_status" -ne 0 ]; then
  echo "FAIL restore-not-refused-for-hosts-with-audit-history: dry-run restore was refused"
  cat "$case22_root/restore.log"
  exit 1
fi
if grep -qi "carries an audit log" "$case22_root/restore.log"; then
  echo "FAIL restore-not-refused-for-hosts-with-audit-history: refused for carrying an audit log"
  exit 1
fi
assert_no_plaintext_leak restore-not-refused-for-hosts-with-audit-history "$case22_root/tmp"
echo "PASS restore-not-refused-for-hosts-with-audit-history"

# =========================================================================
# Cases 23-27: the adopt/keep choice for a restored audit log.
#
# backup_system() includes web-admin-audit.jsonl deliberately (a system
# backup is a migration artifact; the audit trail is part of what moves with
# a server). restore_system() decides what to do with it at restore time,
# mirroring choose_import_battlegroup_action()'s shape: nothing to decide if
# the archive has none, auto-adopt if only the archive has one, and a real
# choice -- flag, prompt, or a hard stop under DUNE_DB_ASSUME_YES=1 with
# neither -- only when both sides genuinely have one. See
# [[system-backup-audit-log-choice]].
# =========================================================================

# Case 23: host has none, archive has one -> auto-adopt, no flag needed.

case23_root="$test_root/case23"
mkdir -p "$case23_root/work"
seed_repo_tree "$case23_root/work"
printf '{"ts":"archive-entry"}\n' > "$case23_root/work/runtime/generated/web-admin-audit.jsonl"
(
  cd "$case23_root/work"
  PATH="$bin_dir:$PATH" DUNE_SYSTEM_BACKUP_PASSPHRASE="$TEST_PASSPHRASE" \
    bash runtime/scripts/db.sh backup-system
) > "$case23_root/backup.log" 2>&1
case23_archive="$(find "$case23_root/work/runtime/backups/system" -maxdepth 1 -name '*.tar.gz.enc' | head -n1)"
if [ -z "$case23_archive" ]; then
  echo "FAIL restore-audit-log-auto-adopts-when-host-has-none: could not build an archive to restore"
  cat "$case23_root/backup.log"
  exit 1
fi
rm -f "$case23_root/work/runtime/generated/web-admin-audit.jsonl"

case23_status=0
run_restore "$case23_root" "$case23_root/tmp" "$TEST_PASSPHRASE" "$(basename "$case23_archive")" || case23_status=$?
if [ "$case23_status" -ne 0 ]; then
  echo "FAIL restore-audit-log-auto-adopts-when-host-has-none: expected exit 0, got $case23_status"
  cat "$case23_root/restore.log"
  exit 1
fi
if ! grep -q "archive-entry" "$case23_root/work/runtime/generated/web-admin-audit.jsonl" 2>/dev/null; then
  echo "FAIL restore-audit-log-auto-adopts-when-host-has-none: the archive's audit log was not adopted"
  exit 1
fi
assert_no_plaintext_leak restore-audit-log-auto-adopts-when-host-has-none "$case23_root/tmp"
echo "PASS restore-audit-log-auto-adopts-when-host-has-none"

# Case 24: both have one, no flag, DUNE_DB_ASSUME_YES=1 -> hard stop before
# anything changes. Never decide silently which forensic record to keep.

case24_root="$test_root/case24"
mkdir -p "$case24_root/work"
seed_repo_tree "$case24_root/work"
printf '{"ts":"archive-entry"}\n' > "$case24_root/work/runtime/generated/web-admin-audit.jsonl"
(
  cd "$case24_root/work"
  PATH="$bin_dir:$PATH" DUNE_SYSTEM_BACKUP_PASSPHRASE="$TEST_PASSPHRASE" \
    bash runtime/scripts/db.sh backup-system
) > "$case24_root/backup.log" 2>&1
case24_archive="$(find "$case24_root/work/runtime/backups/system" -maxdepth 1 -name '*.tar.gz.enc' | head -n1)"
diverge_host_state "$case24_root/work"
printf '{"ts":"host-entry"}\n' > "$case24_root/work/runtime/generated/web-admin-audit.jsonl"

case24_status=0
run_restore "$case24_root" "$case24_root/tmp" "$TEST_PASSPHRASE" "$(basename "$case24_archive")" || case24_status=$?
if [ "$case24_status" -eq 0 ]; then
  echo "FAIL restore-audit-log-conflict-hard-stops-when-silent: expected a non-zero exit"
  cat "$case24_root/restore.log"
  exit 1
fi
if ! grep -qi "before making changes" "$case24_root/restore.log"; then
  echo "FAIL restore-audit-log-conflict-hard-stops-when-silent: no clear stop-before-changes message"
  cat "$case24_root/restore.log"
  exit 1
fi
if ! grep -q "host-entry" "$case24_root/work/runtime/generated/web-admin-audit.jsonl"; then
  echo "FAIL restore-audit-log-conflict-hard-stops-when-silent: the host's own audit log was modified"
  exit 1
fi
if ! grep -q "diverged-pw" "$case24_root/work/.env"; then
  echo "FAIL restore-audit-log-conflict-hard-stops-when-silent: .env was modified despite the hard stop"
  exit 1
fi
assert_no_plaintext_leak restore-audit-log-conflict-hard-stops-when-silent "$case24_root/tmp"
echo "PASS restore-audit-log-conflict-hard-stops-when-silent"

# Case 25: both have one, --keep-current-audit-log -> the host's own survives
# byte-for-byte; the archive's copy lands only in the safety copy.

case25_root="$test_root/case25"
mkdir -p "$case25_root/work"
seed_repo_tree "$case25_root/work"
printf '{"ts":"archive-entry"}\n' > "$case25_root/work/runtime/generated/web-admin-audit.jsonl"
(
  cd "$case25_root/work"
  PATH="$bin_dir:$PATH" DUNE_SYSTEM_BACKUP_PASSPHRASE="$TEST_PASSPHRASE" \
    bash runtime/scripts/db.sh backup-system
) > "$case25_root/backup.log" 2>&1
case25_archive="$(find "$case25_root/work/runtime/backups/system" -maxdepth 1 -name '*.tar.gz.enc' | head -n1)"
diverge_host_state "$case25_root/work"
printf '{"ts":"host-entry"}\n' > "$case25_root/work/runtime/generated/web-admin-audit.jsonl"

case25_status=0
run_restore "$case25_root" "$case25_root/tmp" "$TEST_PASSPHRASE" "$(basename "$case25_archive")" --keep-current-audit-log || case25_status=$?
if [ "$case25_status" -ne 0 ]; then
  echo "FAIL restore-audit-log-keep-current: expected exit 0, got $case25_status"
  cat "$case25_root/restore.log"
  exit 1
fi
if ! grep -q "host-entry" "$case25_root/work/runtime/generated/web-admin-audit.jsonl"; then
  echo "FAIL restore-audit-log-keep-current: the host's own audit log did not survive"
  exit 1
fi
if grep -q "archive-entry" "$case25_root/work/runtime/generated/web-admin-audit.jsonl"; then
  echo "FAIL restore-audit-log-keep-current: the archive's audit log leaked into the live tree"
  exit 1
fi
case25_safety="$(find "$case25_root/work/runtime/backups" -maxdepth 1 -type d -name 'restore-*' | head -n1)"
if ! grep -q "host-entry" "$case25_safety/generated/web-admin-audit.jsonl" 2>/dev/null; then
  echo "FAIL restore-audit-log-keep-current: the safety copy does not hold the pre-restore audit log"
  exit 1
fi
assert_no_plaintext_leak restore-audit-log-keep-current "$case25_root/tmp"
echo "PASS restore-audit-log-keep-current"

# Case 26: both have one, --adopt-backup-audit-log -> the archive's replaces
# the host's own (the migration case this whole design exists for).

case26_root="$test_root/case26"
mkdir -p "$case26_root/work"
seed_repo_tree "$case26_root/work"
printf '{"ts":"archive-entry"}\n' > "$case26_root/work/runtime/generated/web-admin-audit.jsonl"
(
  cd "$case26_root/work"
  PATH="$bin_dir:$PATH" DUNE_SYSTEM_BACKUP_PASSPHRASE="$TEST_PASSPHRASE" \
    bash runtime/scripts/db.sh backup-system
) > "$case26_root/backup.log" 2>&1
case26_archive="$(find "$case26_root/work/runtime/backups/system" -maxdepth 1 -name '*.tar.gz.enc' | head -n1)"
diverge_host_state "$case26_root/work"
printf '{"ts":"host-entry"}\n' > "$case26_root/work/runtime/generated/web-admin-audit.jsonl"

case26_status=0
run_restore "$case26_root" "$case26_root/tmp" "$TEST_PASSPHRASE" "$(basename "$case26_archive")" --adopt-backup-audit-log || case26_status=$?
if [ "$case26_status" -ne 0 ]; then
  echo "FAIL restore-audit-log-adopt-backup: expected exit 0, got $case26_status"
  cat "$case26_root/restore.log"
  exit 1
fi
if ! grep -q "archive-entry" "$case26_root/work/runtime/generated/web-admin-audit.jsonl"; then
  echo "FAIL restore-audit-log-adopt-backup: the archive's audit log was not adopted"
  exit 1
fi
if grep -q "host-entry" "$case26_root/work/runtime/generated/web-admin-audit.jsonl"; then
  echo "FAIL restore-audit-log-adopt-backup: the host's previous audit log is still live"
  exit 1
fi
assert_no_plaintext_leak restore-audit-log-adopt-backup "$case26_root/tmp"
echo "PASS restore-audit-log-adopt-backup"

# Case 27: both have one, --dry-run -> the conflict is reported (unlike
# Battlegroup identity, which a dry run never reaches), and nothing changes.

case27_root="$test_root/case27"
mkdir -p "$case27_root/work"
seed_repo_tree "$case27_root/work"
printf '{"ts":"archive-entry"}\n' > "$case27_root/work/runtime/generated/web-admin-audit.jsonl"
(
  cd "$case27_root/work"
  PATH="$bin_dir:$PATH" DUNE_SYSTEM_BACKUP_PASSPHRASE="$TEST_PASSPHRASE" \
    bash runtime/scripts/db.sh backup-system
) > "$case27_root/backup.log" 2>&1
case27_archive="$(find "$case27_root/work/runtime/backups/system" -maxdepth 1 -name '*.tar.gz.enc' | head -n1)"
diverge_host_state "$case27_root/work"
printf '{"ts":"host-entry"}\n' > "$case27_root/work/runtime/generated/web-admin-audit.jsonl"

case27_status=0
run_restore "$case27_root" "$case27_root/tmp" "$TEST_PASSPHRASE" "$(basename "$case27_archive")" --dry-run || case27_status=$?
if [ "$case27_status" -ne 0 ]; then
  echo "FAIL restore-audit-log-conflict-reported-in-dry-run: expected exit 0, got $case27_status"
  cat "$case27_root/restore.log"
  exit 1
fi
if ! grep -qi "own admin audit history" "$case27_root/restore.log"; then
  echo "FAIL restore-audit-log-conflict-reported-in-dry-run: the conflict was not reported during preview"
  cat "$case27_root/restore.log"
  exit 1
fi
if ! grep -q "host-entry" "$case27_root/work/runtime/generated/web-admin-audit.jsonl"; then
  echo "FAIL restore-audit-log-conflict-reported-in-dry-run: the host's audit log was modified by a dry run"
  exit 1
fi
assert_no_plaintext_leak restore-audit-log-conflict-reported-in-dry-run "$case27_root/tmp"
echo "PASS restore-audit-log-conflict-reported-in-dry-run"

# Case 28: neither side has one -> completely silent, no flags required.

case28_root="$test_root/case28"
case28_archive="$(make_restorable_archive "$case28_root")"
if [ -z "$case28_archive" ]; then
  echo "FAIL restore-audit-log-silent-when-neither-side-has-one: could not build an archive to restore"
  cat "$case28_root/backup.log"
  exit 1
fi
diverge_host_state "$case28_root/work"

case28_status=0
run_restore "$case28_root" "$case28_root/tmp" "$TEST_PASSPHRASE" "$(basename "$case28_archive")" || case28_status=$?
if [ "$case28_status" -ne 0 ]; then
  echo "FAIL restore-audit-log-silent-when-neither-side-has-one: expected exit 0, got $case28_status"
  cat "$case28_root/restore.log"
  exit 1
fi
if grep -qi "audit history" "$case28_root/restore.log"; then
  echo "FAIL restore-audit-log-silent-when-neither-side-has-one: an unexpected audit-log message was printed"
  cat "$case28_root/restore.log"
  exit 1
fi
assert_no_plaintext_leak restore-audit-log-silent-when-neither-side-has-one "$case28_root/tmp"
echo "PASS restore-audit-log-silent-when-neither-side-has-one"

# Case 29: includes_audit_log round-trips through a real backup into the
# sidecar -- what the console reads to decide whether to offer the choice at
# all, without spending a passphrase.

case29_root="$test_root/case29"
mkdir -p "$case29_root/work"
seed_repo_tree "$case29_root/work"
printf '{"ts":"archive-entry"}\n' > "$case29_root/work/runtime/generated/web-admin-audit.jsonl"
(
  cd "$case29_root/work"
  PATH="$bin_dir:$PATH" DUNE_SYSTEM_BACKUP_PASSPHRASE="$TEST_PASSPHRASE" \
    bash runtime/scripts/db.sh backup-system
) > "$case29_root/backup.log" 2>&1
case29_sidecar="$(find "$case29_root/work/runtime/backups/system" -maxdepth 1 -name '*.tar.gz.enc.yaml' | head -n1)"
if [ -z "$case29_sidecar" ] || ! grep -qx "includes_audit_log: true" "$case29_sidecar"; then
  echo "FAIL restore-audit-log-sidecar-field: includes_audit_log: true was not written to the sidecar"
  [ -n "$case29_sidecar" ] && cat "$case29_sidecar"
  exit 1
fi
echo "PASS restore-audit-log-sidecar-field"

# Case 30: an interactive restore prompts once, with restore's own wording --
# not backup_system's "Set a passphrase to encrypt" (create-only, and wrong:
# a restore's passphrase already exists, it is not being set) followed by a
# confirmation nothing here needs (a typo just fails to decrypt, immediately,
# with no silent data-loss mode the way a create-time typo has).

case30_root="$test_root/case30"
case30_archive="$(make_restorable_archive "$case30_root")"
if [ -z "$case30_archive" ]; then
  echo "FAIL restore-passphrase-prompt-wording: could not build an archive to restore"
  cat "$case30_root/backup.log"
  exit 1
fi

set +e
(
  cd "$case30_root/work"
  printf '%s\n' "$TEST_PASSPHRASE" | PATH="$bin_dir:$PATH" \
    script -qec "bash runtime/scripts/db.sh restore-system $(basename "$case30_archive") --dry-run" /dev/null
) > "$case30_root/output.log" 2>&1
case30_exit=$?
set -e

if [ "$case30_exit" -ne 0 ]; then
  echo "FAIL restore-passphrase-prompt-wording: expected exit 0 from a single correct passphrase entry"
  cat "$case30_root/output.log"
  exit 1
fi
if ! grep -q "Enter the passphrase for this system backup" "$case30_root/output.log"; then
  echo "FAIL restore-passphrase-prompt-wording: expected restore's own prompt wording"
  cat "$case30_root/output.log"
  exit 1
fi
if grep -q "Set a passphrase to encrypt" "$case30_root/output.log"; then
  echo "FAIL restore-passphrase-prompt-wording: showed backup_system's create-only prompt during a restore"
  cat "$case30_root/output.log"
  exit 1
fi
if grep -qi "Confirm passphrase" "$case30_root/output.log"; then
  echo "FAIL restore-passphrase-prompt-wording: restore should not ask for confirmation -- one line was supplied and it succeeded, so a second prompt would have consumed EOF"
  cat "$case30_root/output.log"
  exit 1
fi
echo "PASS restore-passphrase-prompt-wording"

# --- Postgres autostart ---------------------------------------------------
# Stopping the battlegroup removes the dune-postgres container, so backup and
# restore had nothing to talk to and failed outright. These cases cover the
# autostart that fixes that, and -- more importantly -- the guard that keeps it
# from touching a database that is already up.

# Installs a stub start-postgres.sh that reports itself and (unless told to
# fail) marks Postgres as running, the way the real script's docker run does.
seed_start_postgres_stub() {
  local work="$1" marker="$2" state_file="$3" succeed="${4:-1}"
  cat > "$work/runtime/scripts/start-postgres.sh" <<STUB
#!/usr/bin/env bash
printf 'invoked\n' >> "$marker"
[ "$succeed" = "1" ] || exit 1
printf 1 > "$state_file"
STUB
  chmod +x "$work/runtime/scripts/start-postgres.sh"
}

# --- Case 31: a stopped Postgres is started, and the backup then succeeds --

case31_root="$test_root/case31"
mkdir -p "$case31_root/work"
seed_repo_tree "$case31_root/work"
case31_marker="$case31_root/start-invoked"
case31_state="$case31_root/pg-state"
printf 0 > "$case31_state"
seed_start_postgres_stub "$case31_root/work" "$case31_marker" "$case31_state"

set +e
(
  cd "$case31_root/work"
  PATH="$bin_dir:$PATH" MOCK_POSTGRES_STATE_FILE="$case31_state" \
    DUNE_SYSTEM_BACKUP_PASSPHRASE="$TEST_PASSPHRASE" \
    bash runtime/scripts/db.sh backup-system
) > "$case31_root/output.log" 2>&1
case31_exit=$?
set -e

if [ "$case31_exit" -ne 0 ]; then
  echo "FAIL postgres-autostart-starts-stopped-database: expected exit 0, got $case31_exit"
  cat "$case31_root/output.log"
  exit 1
fi
if [ ! -f "$case31_marker" ]; then
  echo "FAIL postgres-autostart-starts-stopped-database: start-postgres.sh was never invoked"
  cat "$case31_root/output.log"
  exit 1
fi
if ! find "$case31_root/work/runtime/backups/system" -maxdepth 1 -name '*.tar.gz.enc' | grep -q .; then
  echo "FAIL postgres-autostart-starts-stopped-database: no archive was produced"
  cat "$case31_root/output.log"
  exit 1
fi
echo "PASS postgres-autostart-starts-stopped-database"

# --- Case 32: a RUNNING Postgres is never handed to start-postgres.sh -----
# The decisive one. start-postgres.sh opens with `docker rm -f dune-postgres`,
# so invoking it against a live database destroys it -- here, in the middle of
# the dump it was called to enable. The early return is a safety property, not
# an optimization, and this is the case that holds it in place.

case32_root="$test_root/case32"
mkdir -p "$case32_root/work"
seed_repo_tree "$case32_root/work"
case32_marker="$case32_root/start-invoked"
case32_state="$case32_root/pg-state"
printf 1 > "$case32_state"
seed_start_postgres_stub "$case32_root/work" "$case32_marker" "$case32_state"

set +e
(
  cd "$case32_root/work"
  PATH="$bin_dir:$PATH" MOCK_POSTGRES_STATE_FILE="$case32_state" \
    DUNE_SYSTEM_BACKUP_PASSPHRASE="$TEST_PASSPHRASE" \
    bash runtime/scripts/db.sh backup-system
) > "$case32_root/output.log" 2>&1
case32_exit=$?
set -e

if [ "$case32_exit" -ne 0 ]; then
  echo "FAIL postgres-autostart-never-touches-a-running-database: expected exit 0, got $case32_exit"
  cat "$case32_root/output.log"
  exit 1
fi
if [ -f "$case32_marker" ]; then
  echo "FAIL postgres-autostart-never-touches-a-running-database: start-postgres.sh ran against a LIVE database (its rm -f would have destroyed it)"
  cat "$case32_root/output.log"
  exit 1
fi
echo "PASS postgres-autostart-never-touches-a-running-database"

# --- Case 33: DUNE_DB_AUTOSTART_POSTGRES=0 restores the old behavior ------

case33_root="$test_root/case33"
mkdir -p "$case33_root/work"
seed_repo_tree "$case33_root/work"
case33_marker="$case33_root/start-invoked"
case33_state="$case33_root/pg-state"
printf 0 > "$case33_state"
seed_start_postgres_stub "$case33_root/work" "$case33_marker" "$case33_state"

set +e
(
  cd "$case33_root/work"
  PATH="$bin_dir:$PATH" MOCK_POSTGRES_STATE_FILE="$case33_state" \
    DUNE_DB_AUTOSTART_POSTGRES=0 DUNE_SYSTEM_BACKUP_PASSPHRASE="$TEST_PASSPHRASE" \
    bash runtime/scripts/db.sh backup-system
) > "$case33_root/output.log" 2>&1
case33_exit=$?
set -e

if [ "$case33_exit" -eq 0 ]; then
  echo "FAIL postgres-autostart-opt-out: expected a non-zero exit with autostart off"
  cat "$case33_root/output.log"
  exit 1
fi
if [ -f "$case33_marker" ]; then
  echo "FAIL postgres-autostart-opt-out: start-postgres.sh ran despite DUNE_DB_AUTOSTART_POSTGRES=0"
  exit 1
fi
if find "$case33_root/work/runtime/backups/system" -maxdepth 1 -type f | grep -q .; then
  echo "FAIL postgres-autostart-opt-out: an artifact was left behind"
  exit 1
fi
echo "PASS postgres-autostart-opt-out"

# --- Case 34: a restore autostarts Postgres and completes -----------------

case34_root="$test_root/case34"
mkdir -p "$case34_root"
case34_archive="$(make_restorable_archive "$case34_root")"
if [ -z "$case34_archive" ]; then
  echo "FAIL restore-autostarts-postgres: could not build an archive to restore"
  cat "$case34_root/backup.log"
  exit 1
fi
diverge_host_state "$case34_root/work"
mkdir -p "$case34_root/tmp"
case34_marker="$case34_root/start-invoked"
case34_state="$case34_root/pg-state"
printf 0 > "$case34_state"
seed_start_postgres_stub "$case34_root/work" "$case34_marker" "$case34_state"

set +e
(
  cd "$case34_root/work"
  PATH="$bin_dir:$PATH" TMPDIR="$case34_root/tmp" MOCK_POSTGRES_STATE_FILE="$case34_state" \
    DUNE_SYSTEM_BACKUP_PASSPHRASE="$TEST_PASSPHRASE" DUNE_DB_ASSUME_YES=1 \
    bash runtime/scripts/db.sh restore-system "$(basename "$case34_archive")"
) > "$case34_root/restore.log" 2>&1
case34_exit=$?
set -e

if [ "$case34_exit" -ne 0 ]; then
  echo "FAIL restore-autostarts-postgres: expected exit 0, got $case34_exit"
  cat "$case34_root/restore.log"
  exit 1
fi
if [ ! -f "$case34_marker" ]; then
  echo "FAIL restore-autostarts-postgres: start-postgres.sh was never invoked"
  cat "$case34_root/restore.log"
  exit 1
fi
if ! grep -q "$SECRET_ADMIN_PASSWORD" "$case34_root/work/.env"; then
  echo "FAIL restore-autostarts-postgres: the restore did not complete"
  cat "$case34_root/restore.log"
  exit 1
fi
echo "PASS restore-autostarts-postgres"

# --- Case 35: a dry run needs no database at all --------------------------
# Preview decrypts and reports; it never reaches import_db. Starting Postgres
# to answer "what would this replace" would be a side effect of asking.

case35_root="$test_root/case35"
mkdir -p "$case35_root"
case35_archive="$(make_restorable_archive "$case35_root")"
if [ -z "$case35_archive" ]; then
  echo "FAIL restore-dry-run-needs-no-database: could not build an archive to restore"
  exit 1
fi
mkdir -p "$case35_root/tmp"
case35_marker="$case35_root/start-invoked"
case35_state="$case35_root/pg-state"
printf 0 > "$case35_state"
seed_start_postgres_stub "$case35_root/work" "$case35_marker" "$case35_state"

set +e
(
  cd "$case35_root/work"
  PATH="$bin_dir:$PATH" TMPDIR="$case35_root/tmp" MOCK_POSTGRES_STATE_FILE="$case35_state" \
    DUNE_SYSTEM_BACKUP_PASSPHRASE="$TEST_PASSPHRASE" DUNE_DB_ASSUME_YES=1 \
    bash runtime/scripts/db.sh restore-system "$(basename "$case35_archive")" --dry-run
) > "$case35_root/restore.log" 2>&1
case35_exit=$?
set -e

if [ "$case35_exit" -ne 0 ]; then
  echo "FAIL restore-dry-run-needs-no-database: expected exit 0 with Postgres down, got $case35_exit"
  cat "$case35_root/restore.log"
  exit 1
fi
if [ -f "$case35_marker" ]; then
  echo "FAIL restore-dry-run-needs-no-database: a preview started Postgres"
  cat "$case35_root/restore.log"
  exit 1
fi
echo "PASS restore-dry-run-needs-no-database"

# --- Case 36: Postgres that will not come up stops the restore BEFORE -----
# --- a safety copy exists -------------------------------------------------
# import_db checks too, and that check is what actually gates the restore, but
# reaching it means runtime/backups/restore-* has already been written for a
# restore that cannot proceed -- which is what a stopped battlegroup produced
# live. The check belongs ahead of the safety copy.

case36_root="$test_root/case36"
mkdir -p "$case36_root"
case36_archive="$(make_restorable_archive "$case36_root")"
if [ -z "$case36_archive" ]; then
  echo "FAIL restore-refuses-before-safety-copy-when-postgres-will-not-start: could not build an archive"
  exit 1
fi
mkdir -p "$case36_root/tmp"
case36_marker="$case36_root/start-invoked"
case36_state="$case36_root/pg-state"
printf 0 > "$case36_state"
seed_start_postgres_stub "$case36_root/work" "$case36_marker" "$case36_state" 0

set +e
(
  cd "$case36_root/work"
  PATH="$bin_dir:$PATH" TMPDIR="$case36_root/tmp" MOCK_POSTGRES_STATE_FILE="$case36_state" \
    DUNE_SYSTEM_BACKUP_PASSPHRASE="$TEST_PASSPHRASE" DUNE_DB_ASSUME_YES=1 \
    bash runtime/scripts/db.sh restore-system "$(basename "$case36_archive")"
) > "$case36_root/restore.log" 2>&1
case36_exit=$?
set -e

if [ "$case36_exit" -eq 0 ]; then
  echo "FAIL restore-refuses-before-safety-copy-when-postgres-will-not-start: expected a non-zero exit"
  cat "$case36_root/restore.log"
  exit 1
fi
if [ ! -f "$case36_marker" ]; then
  echo "FAIL restore-refuses-before-safety-copy-when-postgres-will-not-start: start-postgres.sh was never attempted"
  exit 1
fi
if find "$case36_root/work/runtime/backups" -maxdepth 1 -type d -name 'restore-*' | grep -q .; then
  echo "FAIL restore-refuses-before-safety-copy-when-postgres-will-not-start: a safety copy was written for a restore that could not run"
  find "$case36_root/work/runtime/backups" -maxdepth 1 -type d -name 'restore-*' -print
  exit 1
fi
assert_no_plaintext_leak restore-refuses-before-safety-copy-when-postgres-will-not-start "$case36_root/tmp"
echo "PASS restore-refuses-before-safety-copy-when-postgres-will-not-start"

# --- Case 37: no local Postgres image refuses BEFORE attempting to start --
# start-postgres.sh builds a registry.funcom.com reference and docker run then
# attempts a pull that cannot succeed on any host -- this repo never logs into
# that registry. The refusal has to land before that, or the operator gets a
# network-shaped error for a missing-game-files problem.

case37_root="$test_root/case37"
mkdir -p "$case37_root/work"
seed_repo_tree "$case37_root/work"
case37_marker="$case37_root/start-invoked"
case37_state="$case37_root/pg-state"
printf 0 > "$case37_state"
seed_start_postgres_stub "$case37_root/work" "$case37_marker" "$case37_state"

set +e
(
  cd "$case37_root/work"
  PATH="$bin_dir:$PATH" MOCK_POSTGRES_STATE_FILE="$case37_state" \
    MOCK_POSTGRES_IMAGE_PRESENT=0 DUNE_SYSTEM_BACKUP_PASSPHRASE="$TEST_PASSPHRASE" \
    bash runtime/scripts/db.sh backup-system
) > "$case37_root/output.log" 2>&1
case37_exit=$?
set -e

if [ "$case37_exit" -eq 0 ]; then
  echo "FAIL postgres-image-missing-refuses: expected a non-zero exit with no image installed"
  cat "$case37_root/output.log"
  exit 1
fi
if [ -f "$case37_marker" ]; then
  echo "FAIL postgres-image-missing-refuses: start-postgres.sh ran, so docker would have attempted an impossible pull"
  cat "$case37_root/output.log"
  exit 1
fi
if ! grep -q "DUNE_GAME_ASSETS_MISSING" "$case37_root/output.log"; then
  echo "FAIL postgres-image-missing-refuses: the machine-readable marker was not emitted"
  cat "$case37_root/output.log"
  exit 1
fi
if ! grep -q "dune update install-assets" "$case37_root/output.log"; then
  echo "FAIL postgres-image-missing-refuses: the message does not name the fix"
  cat "$case37_root/output.log"
  exit 1
fi
echo "PASS postgres-image-missing-refuses"

# --- Case 38: same refusal on a restore, before any safety copy exists ----

case38_root="$test_root/case38"
mkdir -p "$case38_root"
case38_archive="$(make_restorable_archive "$case38_root")"
if [ -z "$case38_archive" ]; then
  echo "FAIL restore-refuses-when-image-missing: could not build an archive"
  exit 1
fi
mkdir -p "$case38_root/tmp"
case38_marker="$case38_root/start-invoked"
case38_state="$case38_root/pg-state"
printf 0 > "$case38_state"
seed_start_postgres_stub "$case38_root/work" "$case38_marker" "$case38_state"

set +e
(
  cd "$case38_root/work"
  PATH="$bin_dir:$PATH" TMPDIR="$case38_root/tmp" MOCK_POSTGRES_STATE_FILE="$case38_state" \
    MOCK_POSTGRES_IMAGE_PRESENT=0 DUNE_SYSTEM_BACKUP_PASSPHRASE="$TEST_PASSPHRASE" \
    DUNE_DB_ASSUME_YES=1 \
    bash runtime/scripts/db.sh restore-system "$(basename "$case38_archive")"
) > "$case38_root/restore.log" 2>&1
case38_exit=$?
set -e

if [ "$case38_exit" -eq 0 ]; then
  echo "FAIL restore-refuses-when-image-missing: expected a non-zero exit"
  cat "$case38_root/restore.log"
  exit 1
fi
if find "$case38_root/work/runtime/backups" -maxdepth 1 -type d -name 'restore-*' | grep -q .; then
  echo "FAIL restore-refuses-when-image-missing: a safety copy was written for a restore that could not run"
  exit 1
fi
if ! grep -q "DUNE_GAME_ASSETS_MISSING" "$case38_root/restore.log"; then
  echo "FAIL restore-refuses-when-image-missing: the marker was not emitted"
  cat "$case38_root/restore.log"
  exit 1
fi
assert_no_plaintext_leak restore-refuses-when-image-missing "$case38_root/tmp"
echo "PASS restore-refuses-when-image-missing"

# --- Case 39: the new check must not weaken the running-database guard ----
# Case 32 pins "never hand a live database to start-postgres.sh". Inserting an
# image check at the wrong depth could bypass that early return.

case39_root="$test_root/case39"
mkdir -p "$case39_root/work"
seed_repo_tree "$case39_root/work"
case39_marker="$case39_root/start-invoked"
case39_state="$case39_root/pg-state"
printf 1 > "$case39_state"
seed_start_postgres_stub "$case39_root/work" "$case39_marker" "$case39_state"

set +e
(
  cd "$case39_root/work"
  PATH="$bin_dir:$PATH" MOCK_POSTGRES_STATE_FILE="$case39_state" \
    MOCK_POSTGRES_IMAGE_PRESENT=1 DUNE_SYSTEM_BACKUP_PASSPHRASE="$TEST_PASSPHRASE" \
    bash runtime/scripts/db.sh backup-system
) > "$case39_root/output.log" 2>&1
case39_exit=$?
set -e

if [ "$case39_exit" -ne 0 ]; then
  echo "FAIL image-check-keeps-running-database-guard: expected exit 0, got $case39_exit"
  cat "$case39_root/output.log"
  exit 1
fi
if [ -f "$case39_marker" ]; then
  echo "FAIL image-check-keeps-running-database-guard: start-postgres.sh ran against a LIVE database"
  exit 1
fi
echo "PASS image-check-keeps-running-database-guard"

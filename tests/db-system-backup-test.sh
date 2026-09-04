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
    if [ "${MOCK_POSTGRES_RUNNING:-1}" = "1" ]; then
      printf '%s\n' dune-postgres
    fi
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
  printf '%s
' --aead-algo
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
if ! grep -qi "dune restart" "$case11_root/restore.log"; then
  echo "FAIL restore-round-trip: the required restart was never stated"
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

# An audit log is the destination host's own forensic record; transplanting
# one would destroy the record of the restore itself.
case15_audit="$case15_root/tree-audit"
mkdir -p "$case15_audit/db" "$case15_audit/generated"
printf 'x\n' > "$case15_audit/env"
printf 'dump\n' > "$case15_audit/db/test.backup"
printf '{}\n' > "$case15_audit/generated/web-admin-audit.jsonl"
case15_check audit-log "$case15_audit" "audit log"

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

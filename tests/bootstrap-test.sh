#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

test_root="$(mktemp -d)"
trap 'chmod -R u+w "$test_root" 2>/dev/null || true; rm -rf "$test_root"' EXIT
mkdir -p "$test_root/bin" "$test_root/release/dune-awakening-selfhost-docker-v9.8.7"
printf '#!/bin/sh\nexit 0\n' >"$test_root/release/dune-awakening-selfhost-docker-v9.8.7/install.sh"
tar -czf "$test_root/release.tar.gz" -C "$test_root/release" dune-awakening-selfhost-docker-v9.8.7

cat >"$test_root/bin/curl" <<'SH'
#!/bin/sh
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    output="$2"
    shift 2
    continue
  fi
  shift
done
if [ -n "$output" ]; then
  cp "$BOOTSTRAP_FIXTURE_ARCHIVE" "$output"
else
  # An uploaded asset's digest does not describe GitHub's generated tag archive.
  printf '%s\n' '{"tag_name":"v9.8.7","assets":[{"digest":"sha256:0000000000000000000000000000000000000000000000000000000000000000"}]}'
fi
SH
chmod +x "$test_root/bin/curl"

install_dir="$test_root/disk/dune-awakening-selfhost-docker"
mkdir -p "$test_root/disk"
PATH="$test_root/bin:$PATH" \
BOOTSTRAP_FIXTURE_ARCHIVE="$test_root/release.tar.gz" \
DUNE_BOOTSTRAP_SKIP_INSTALL=1 \
DUNE_INSTALL_DIR="$install_dir" \
  sh bootstrap.sh >/dev/null
test -x "$install_dir/install.sh"
test -z "$(find "$test_root/disk" -maxdepth 1 -name '.dune-*' -print -quit)"

if PATH="$test_root/bin:$PATH" \
  BOOTSTRAP_FIXTURE_ARCHIVE="$test_root/release.tar.gz" \
  DUNE_BOOTSTRAP_SKIP_INSTALL=1 \
  DUNE_INSTALL_DIR="$install_dir" \
    sh bootstrap.sh >"$test_root/retry.out" 2>"$test_root/retry.err"; then
  echo "bootstrap unexpectedly overwrote an existing installation" >&2
  exit 1
fi
grep -q 'already contains Dune Docker' "$test_root/retry.err"
test -x "$install_dir/install.sh"

# Exclude the host curl from PATH so these exercise the actual wget fallback.
mkdir -p "$test_root/wget-bin"
for utility in awk cat chmod cp df dirname grep gzip head id mkdir mktemp mv rm sed sh sha256sum tar uname; do
  ln -s "$(command -v "$utility")" "$test_root/wget-bin/$utility"
done
cat >"$test_root/wget-bin/wget" <<'SH'
#!/bin/sh
if [ "${1:-}" = "--help" ]; then
  case "$BOOTSTRAP_WGET_FLAVOR" in
    gnu) printf '%s\n' 'GNU Wget: --https-only -O FILE -q' ;;
    busybox) printf '%s\n' 'BusyBox wget: -O FILE -q' ;;
  esac
  exit 0
fi
printf '%s\n' "$*" >> "$BOOTSTRAP_WGET_LOG"
output=""
https_only=0
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --https-only)
      [ "$BOOTSTRAP_WGET_FLAVOR" = gnu ] || { echo "wget: unrecognized option '--https-only'" >&2; exit 1; }
      https_only=1
      shift
      ;;
    -O) output="$2"; shift 2 ;;
    -qO-) shift ;;
    https://*) url="$1"; shift ;;
    *) echo "Unexpected wget argument: $1" >&2; exit 1 ;;
  esac
done
case "$BOOTSTRAP_WGET_FLAVOR:$https_only" in
  gnu:1|busybox:0) ;;
  *) echo 'Incorrect HTTPS option selection' >&2; exit 1 ;;
esac
[ -n "$url" ] || exit 1
if [ -n "$output" ]; then
  [ "${BOOTSTRAP_DOWNLOAD_FAIL:-0}" != 1 ] || exit 1
  cp "$BOOTSTRAP_FIXTURE_ARCHIVE" "$output"
else
  printf '%s\n' '{"tag_name":"v9.8.7"}'
fi
SH
chmod +x "$test_root/wget-bin/wget"

for wget_flavor in gnu busybox; do
  destination="$test_root/$wget_flavor-disk/project"
  PATH="$test_root/wget-bin" \
  BOOTSTRAP_WGET_FLAVOR="$wget_flavor" \
  BOOTSTRAP_WGET_LOG="$test_root/$wget_flavor.log" \
  BOOTSTRAP_FIXTURE_ARCHIVE="$test_root/release.tar.gz" \
  DUNE_RELEASE_SHA256="" \
  DUNE_BOOTSTRAP_SKIP_INSTALL=1 \
  DUNE_INSTALL_DIR="$destination" \
    sh bootstrap.sh >/dev/null
  test -x "$destination/install.sh"
  test "$(wc -l < "$test_root/$wget_flavor.log")" -eq 2
  test -z "$(find "$(dirname "$destination")" -maxdepth 1 -name '.dune-*' -print -quit)"
done

# Explicit checksums still protect the downloaded archive without relying on
# unrelated GitHub release asset metadata.
archive_sha256="$(sha256sum "$test_root/release.tar.gz" | awk '{print $1}')"
PATH="$test_root/bin:$PATH" \
BOOTSTRAP_FIXTURE_ARCHIVE="$test_root/release.tar.gz" \
DUNE_RELEASE_SHA256="$archive_sha256" \
DUNE_BOOTSTRAP_SKIP_INSTALL=1 \
DUNE_INSTALL_DIR="$test_root/verified/project" \
  sh bootstrap.sh >/dev/null
test -x "$test_root/verified/project/install.sh"

if PATH="$test_root/bin:$PATH" \
  BOOTSTRAP_FIXTURE_ARCHIVE="$test_root/release.tar.gz" \
  DUNE_RELEASE_SHA256="0000000000000000000000000000000000000000000000000000000000000000" \
  DUNE_BOOTSTRAP_SKIP_INSTALL=1 \
  DUNE_INSTALL_DIR="$test_root/bad-checksum/project" \
    sh bootstrap.sh >"$test_root/checksum.out" 2>"$test_root/checksum.err"; then
  echo "bootstrap unexpectedly accepted an incorrect checksum" >&2
  exit 1
fi
grep -q 'SHA-256 mismatch' "$test_root/checksum.err"
test ! -e "$test_root/bad-checksum/project"
test -z "$(find "$test_root/bad-checksum" -maxdepth 1 -name '.dune-*' -print -quit)"

if PATH="$test_root/wget-bin" \
  BOOTSTRAP_WGET_FLAVOR=busybox \
  BOOTSTRAP_WGET_LOG="$test_root/failed-download.log" \
  BOOTSTRAP_DOWNLOAD_FAIL=1 \
  DUNE_INSTALL_DIR="$test_root/failed-download/project" \
    sh bootstrap.sh >"$test_root/download.out" 2>"$test_root/download.err"; then
  echo "bootstrap unexpectedly accepted a failed download" >&2
  exit 1
fi
test ! -e "$test_root/failed-download/project"
test -z "$(find "$test_root/failed-download" -maxdepth 1 -name '.dune-*' -print -quit)"

cat >"$test_root/bin/uname" <<'SH'
#!/bin/sh
printf '%s\n' '6.6.87.2-microsoft-standard-WSL2 docker-desktop linuxkit'
SH
chmod +x "$test_root/bin/uname"
if PATH="$test_root/bin:$PATH" DUNE_INSTALL_DIR="$test_root/desktop-target" sh bootstrap.sh \
    >"$test_root/desktop.out" 2>"$test_root/desktop.err"; then
  echo "bootstrap unexpectedly accepted Docker Desktop's internal environment" >&2
  exit 1
fi
grep -q "Docker Desktop's internal Linux environment" "$test_root/desktop.err"

echo "bootstrap passes curl/GNU wget/BusyBox wget, checksum, download failure, existing-install, and Docker Desktop checks"

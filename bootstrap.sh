#!/bin/sh
set -eu

PROJECT="dune-awakening-selfhost-docker"
REPOSITORY="Red-Blink/$PROJECT"
DEFAULT_INSTALL_DIR="${HOME:?HOME is not set}/$PROJECT"
INSTALL_DIR="${DUNE_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
STAGE_DIR=""
ARCHIVE=""

cleanup() {
  [ -z "$STAGE_DIR" ] || rm -rf "$STAGE_DIR"
  [ -z "$ARCHIVE" ] || rm -f "$ARCHIVE"
}
trap cleanup EXIT HUP INT TERM

fail() {
  printf '\nInstallation could not continue: %s\n' "$1" >&2
  exit 1
}

case "$(uname -r 2>/dev/null || true) $(cat /etc/os-release 2>/dev/null || true)" in
  *docker-desktop*|*Docker\ Desktop*|*linuxkit*)
    fail "this is Docker Desktop's internal Linux environment. Open a normal Ubuntu WSL2 terminal, enable Docker Desktop's Ubuntu WSL integration, and run the command there."
    ;;
esac

[ "$(id -u)" -ne 0 ] || fail "run this as your normal Linux user, without sudo."
command -v tar >/dev/null 2>&1 || fail "tar is missing. Install curl and tar with your distribution's package manager, then retry."
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fL --proto '=https' --retry 3 --connect-timeout 20 "$1" -o "$2"; }
  fetch_text() { curl -fsSL --proto '=https' --retry 3 --connect-timeout 20 "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget --https-only -O "$2" "$1"; }
  fetch_text() { wget --https-only -qO- "$1"; }
else
  fail "curl or wget is required. Install curl and tar with your distribution's package manager, then retry."
fi

verify_archive_sha256() {
  expected_sha256="$1"
  archive_path="$2"
  [ -n "$expected_sha256" ] || return 0
  if command -v sha256sum >/dev/null 2>&1; then
    actual_sha256=$(sha256sum "$archive_path" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    actual_sha256=$(shasum -a 256 "$archive_path" | awk '{print $1}')
  else
    fail "sha256sum or shasum is required to verify release archive integrity."
  fi
  [ "$actual_sha256" = "$expected_sha256" ] || fail "release archive SHA-256 mismatch (expected $expected_sha256, got $actual_sha256)."
}

if [ -e "$INSTALL_DIR" ]; then
  if [ -f "$INSTALL_DIR/install.sh" ]; then
    fail "$INSTALL_DIR already contains Dune Docker. Run its existing install.sh or use the Console updater instead."
  fi
  fail "$INSTALL_DIR already exists. Move or remove that incomplete directory, or choose another location with DUNE_INSTALL_DIR=/path/to/folder."
fi

PARENT_DIR=$(dirname "$INSTALL_DIR")
mkdir -p "$PARENT_DIR" 2>/dev/null || fail "cannot create $PARENT_DIR. Choose a writable Linux directory."
WRITE_TEST="$PARENT_DIR/.dune-bootstrap-write-$$"
if ! (umask 077 && : >"$WRITE_TEST") 2>/dev/null; then
  fail "$PARENT_DIR is read-only. Choose a writable Linux filesystem; do not install inside Docker Desktop's internal shell."
fi
rm -f "$WRITE_TEST"

AVAILABLE_KB=$(df -Pk "$PARENT_DIR" 2>/dev/null | awk 'NR == 2 { print $4 }')
case "$AVAILABLE_KB" in
  ''|*[!0-9]*) ;;
  *) [ "$AVAILABLE_KB" -ge 102400 ] || fail "$PARENT_DIR has less than 100 MB free before Docker images are downloaded. Choose a larger Linux filesystem." ;;
esac

printf '%s\n' "==> Finding the latest Dune Docker release..."
RELEASE_JSON=$(fetch_text "https://api.github.com/repos/$REPOSITORY/releases/latest") \
  || fail "GitHub did not return the latest release. Check internet access and try again."
VERSION=$(printf '%s\n' "$RELEASE_JSON" | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
case "$VERSION" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) fail "the latest GitHub release did not contain a valid version tag." ;;
esac

ARCHIVE=$(mktemp "$PARENT_DIR/.dune-release.XXXXXX.tar.gz") \
  || fail "cannot create a temporary download in $PARENT_DIR."
STAGE_DIR=$(mktemp -d "$PARENT_DIR/.dune-install.XXXXXX") \
  || fail "cannot create a temporary installation directory in $PARENT_DIR."

printf '%s\n' "==> Downloading $PROJECT $VERSION..."
fetch "https://github.com/$REPOSITORY/archive/refs/tags/$VERSION.tar.gz" "$ARCHIVE" \
  || fail "the release download failed. Check free space and internet access, then retry."
EXPECTED_SHA256="${DUNE_RELEASE_SHA256:-}"
verify_archive_sha256 "$EXPECTED_SHA256" "$ARCHIVE"
if tar -tzf "$ARCHIVE" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  fail "the release archive contains unsafe path entries."
fi
tar -xzf "$ARCHIVE" -C "$STAGE_DIR" --strip-components=1 \
  || fail "the release archive could not be extracted. Check free space and filesystem permissions."
[ -f "$STAGE_DIR/install.sh" ] || fail "the downloaded release is incomplete."

mv "$STAGE_DIR" "$INSTALL_DIR" \
  || fail "the prepared installation could not be moved into $INSTALL_DIR."
STAGE_DIR=""
chmod +x "$INSTALL_DIR/install.sh"

printf '%s\n' "==> Installed release files in $INSTALL_DIR"
if [ "${DUNE_BOOTSTRAP_SKIP_INSTALL:-0}" = "1" ]; then
  exit 0
fi

printf '%s\n' "==> Starting the installer..."
cd "$INSTALL_DIR"
exec ./install.sh

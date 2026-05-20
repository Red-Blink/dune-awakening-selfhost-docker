#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT_DIR="$(pwd)"

CURRENT_VERSION="dev"
[ -f VERSION ] && CURRENT_VERSION="$(tr -d '[:space:]' < VERSION)"

detect_github_repo() {
  local remote

  if [ -n "${DUNE_SELF_UPDATE_REPO:-}" ]; then
    printf '%s\n' "$DUNE_SELF_UPDATE_REPO"
    return 0
  fi

  if command -v git >/dev/null 2>&1; then
    remote="$(git remote get-url origin 2>/dev/null || true)"
    case "$remote" in
      https://github.com/*)
        remote="${remote#https://github.com/}"
        remote="${remote%.git}"
        printf '%s\n' "$remote"
        return 0
        ;;
      git@github.com:*)
        remote="${remote#git@github.com:}"
        remote="${remote%.git}"
        printf '%s\n' "$remote"
        return 0
        ;;
    esac
  fi

  printf '%s\n' "Red-Blink/dune-awakening-selfhost-docker"
}

GITHUB_REPO="$(detect_github_repo)"
GITHUB_API_BASE="${DUNE_SELF_UPDATE_API_BASE:-https://api.github.com}"
GITHUB_TOKEN="${DUNE_SELF_UPDATE_TOKEN:-}"

api_get() {
  local path="$1"

  if [ -n "$GITHUB_TOKEN" ]; then
    curl -fsSL \
      -H "Accept: application/vnd.github+json" \
      -H "Authorization: Bearer $GITHUB_TOKEN" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "${GITHUB_API_BASE}/repos/${GITHUB_REPO}${path}"
  else
    curl -fsSL \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "${GITHUB_API_BASE}/repos/${GITHUB_REPO}${path}"
  fi
}

latest_release_json() {
  api_get "/releases/latest"
}

extract_json_field() {
  local field="$1"
  python3 -c 'import json,sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(1)
value = data.get(sys.argv[1], "")
print(value if value is not None else "")' "$field"
}

latest_release_tag() {
  local json
  json="$(latest_release_json 2>/dev/null)" || return 1
  [ -n "$json" ] || return 1
  printf '%s' "$json" | extract_json_field tag_name
}

release_tarball_url() {
  local tag="$1"
  local json
  json="$(api_get "/releases/tags/${tag}" 2>/dev/null)" || return 1
  [ -n "$json" ] || return 1
  printf '%s' "$json" | extract_json_field tarball_url
}

version_newer() {
  local current="$1"
  local latest="$2"
  current="${current#v}"
  latest="${latest#v}"
  [ "$current" = "$latest" ] && return 1
  [ "$(printf '%s\n%s\n' "$current" "$latest" | sort -V | tail -n1)" = "$latest" ]
}

print_versions() {
  local latest="$1"
  echo "Current stack version: $CURRENT_VERSION"
  echo "Latest release:        $latest"
  echo "GitHub repo:           $GITHUB_REPO"
}

check_dirty_git_tree() {
  if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if ! git diff --quiet --ignore-submodules -- 2>/dev/null || ! git diff --cached --quiet --ignore-submodules -- 2>/dev/null; then
      echo "Local repo has uncommitted changes."
      echo "Commit or back up your local edits before installing a stack release."
      exit 3
    fi
  fi
}

download_release_archive() {
  local tag="$1"
  local out="$2"
  local tarball_url

  tarball_url="$(release_tarball_url "$tag")"
  if [ -z "$tarball_url" ]; then
    echo "Could not find tarball URL for release tag: $tag"
    exit 2
  fi

  if [ -n "$GITHUB_TOKEN" ]; then
    curl -fsSL \
      -H "Accept: application/vnd.github+json" \
      -H "Authorization: Bearer $GITHUB_TOKEN" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      -L "$tarball_url" -o "$out"
  else
    curl -fsSL \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      -L "$tarball_url" -o "$out"
  fi
}

backup_current_stack() {
  local backup_dir="$1"
  mkdir -p "$backup_dir"

  tar -czf "$backup_dir/project-files.tgz" \
    --exclude='./.git' \
    --exclude='./.env' \
    --exclude='./runtime/generated' \
    --exclude='./runtime/secrets' \
    --exclude='./runtime/backups' \
    --exclude='./runtime/game' \
    --exclude='./work' \
    .

  {
    echo "from_version=$CURRENT_VERSION"
    echo "repo=$GITHUB_REPO"
  } > "$backup_dir/meta.env"
}

install_release_tag() {
  local tag="$1"
  local tmpdir archive src backup_dir new_version expected_version

  check_dirty_git_tree

  tmpdir="$(mktemp -d)"
  archive="$tmpdir/release.tar.gz"

  echo "Downloading stack release: $tag"
  download_release_archive "$tag" "$archive"

  tar -xzf "$archive" -C "$tmpdir"
  src="$(find "$tmpdir" -mindepth 1 -maxdepth 1 -type d | head -n1)"
  if [ -z "$src" ] || [ ! -d "$src" ]; then
    echo "Could not unpack the stack release archive."
    rm -rf "$tmpdir"
    exit 2
  fi

  backup_dir="runtime/backups/self-update/$(date +%Y%m%d-%H%M%S)-${tag#v}"
  echo "Backing up current stack files to:"
  echo "  $backup_dir"
  backup_current_stack "$backup_dir"

  echo "Installing stack release into:"
  echo "  $ROOT_DIR"
  (
    cd "$src"
    tar --exclude='.git' -cf - .
  ) | (
    cd "$ROOT_DIR"
    tar -xf -
  )

  new_version="$CURRENT_VERSION"
  [ -f VERSION ] && new_version="$(tr -d '[:space:]' < VERSION)"
  expected_version="$tag"

  if [ "${new_version#v}" != "${expected_version#v}" ]; then
    echo
    echo "Downloaded release tag $expected_version, but installed VERSION is $new_version."
    echo "This usually means the GitHub release tag points to a commit with the wrong VERSION file."
    echo "Publish a corrected release tag from the intended commit, then try again."
    echo
    echo "Previous stack files backup:"
    echo "  $backup_dir/project-files.tgz"
    rm -rf "$tmpdir"
    exit 4
  fi

  echo
  echo "Installed stack version: $new_version"
  echo "Previous stack files backup:"
  echo "  $backup_dir/project-files.tgz"
  echo
  echo "Exit and reopen dune manager so the updated scripts are reloaded."

  rm -rf "$tmpdir"
}

cmd="${1:-check}"
tag="${2:-}"

case "$cmd" in
  check|status)
    set +e
    latest="$(latest_release_tag)"
    rc=$?
    set -e

    if [ "$rc" -ne 0 ] || [ -z "${latest:-}" ]; then
      echo "Could not check stack releases from GitHub."
      echo "If the repo is still private, this is expected until public releases are published"
      echo "or a GitHub token is configured in DUNE_SELF_UPDATE_TOKEN."
      exit 2
    fi

    print_versions "$latest"
    echo
    if version_newer "$CURRENT_VERSION" "$latest"; then
      echo "A newer stack version is available."
      exit 100
    fi

    echo "You are already on the latest stack version."
    exit 0
    ;;

  install|apply)
    if [ -z "$tag" ] || [ "$tag" = "latest" ]; then
      set +e
      tag="$(latest_release_tag)"
      rc=$?
      set -e
      if [ "$rc" -ne 0 ] || [ -z "$tag" ]; then
        echo "Could not resolve the latest stack release."
        echo "If the repo is still private, publish releases first or configure DUNE_SELF_UPDATE_TOKEN."
        exit 2
      fi
    fi

    install_release_tag "$tag"
    ;;

  *)
    echo "Usage:"
    echo "  runtime/scripts/self-update.sh check"
    echo "  runtime/scripts/self-update.sh install [latest|<tag>]"
    exit 2
    ;;
esac

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
LATEST_TAG_CACHE_FILE="runtime/generated/self-update-latest-tag.txt"
API_LAST_STATUS=""

detect_host_repo_root() {
  local source

  if [ -n "${DUNE_HOST_REPO_ROOT:-}" ]; then
    printf '%s\n' "$DUNE_HOST_REPO_ROOT"
    return 0
  fi

  if [ -f /.dockerenv ] && command -v docker >/dev/null 2>&1; then
    source="$(
      docker inspect redblink-dune-docker-console \
        --format '{{range .Mounts}}{{if eq .Destination "/repo"}}{{.Source}}{{end}}{{end}}' \
        2>/dev/null || true
    )"
    if [ -n "$source" ] && [ "$source" != "/repo" ]; then
      printf '%s\n' "$source"
      return 0
    fi
  fi

  printf '%s\n' "$ROOT_DIR"
}

HOST_ROOT_DIR="$(detect_host_repo_root)"
export DUNE_HOST_REPO_ROOT="$HOST_ROOT_DIR"

api_curl_common_args() {
  printf '%s\n' \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28"
  if [ -n "$GITHUB_TOKEN" ]; then
    printf '%s\n' -H "Authorization: Bearer $GITHUB_TOKEN"
  fi
}

api_get() {
  local path="$1"
  local tmp_body
  local http_code
  local curl_rc
  local -a curl_args

  API_LAST_STATUS=""
  tmp_body="$(mktemp)"
  mapfile -t curl_args < <(api_curl_common_args)

  set +e
  http_code="$(
    curl -sSL \
      "${curl_args[@]}" \
      -o "$tmp_body" \
      -w '%{http_code}' \
      "${GITHUB_API_BASE}/repos/${GITHUB_REPO}${path}"
  )"
  curl_rc=$?
  set -e

  if [ "$curl_rc" -ne 0 ]; then
    rm -f "$tmp_body"
    return "$curl_rc"
  fi

  API_LAST_STATUS="$http_code"
  if [ "${http_code:-000}" -lt 200 ] || [ "${http_code:-000}" -ge 300 ]; then
    rm -f "$tmp_body"
    return 22
  fi

  cat "$tmp_body"
  rm -f "$tmp_body"
}

print_release_fetch_failure() {
  local action="$1"

  echo "Could not $action from GitHub."
  echo "GitHub repo: $GITHUB_REPO"
  case "${API_LAST_STATUS:-}" in
    401|403)
      echo "GitHub API access was denied or rate-limited."
      if [ -n "$GITHUB_TOKEN" ]; then
        echo "Check whether DUNE_SELF_UPDATE_TOKEN is valid and still has access."
      else
        echo "If GitHub rate limiting is the issue, set DUNE_SELF_UPDATE_TOKEN to increase the API limit."
      fi
      ;;
    404)
      echo "The repository or its published releases could not be found through the GitHub API."
      echo "Check that the detected repo is correct and that releases are published."
      ;;
    "")
      echo "The GitHub API request failed before a response was returned."
      ;;
    *)
      echo "GitHub API returned HTTP ${API_LAST_STATUS}."
      echo "Check that the repo is reachable and that published releases exist."
      ;;
  esac
}

latest_release_json() {
  api_get "/releases/latest"
}

releases_json() {
  api_get "/releases?per_page=20"
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

latest_release_tag_from_releases_list() {
  local json
  json="$(releases_json 2>/dev/null)" || return 1
  [ -n "$json" ] || return 1
  printf '%s' "$json" | python3 -c 'import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
for release in data:
    if not isinstance(release, dict):
        continue
    if release.get("draft") or release.get("prerelease"):
        continue
    tag = release.get("tag_name") or ""
    if tag:
        print(tag)
        raise SystemExit(0)
raise SystemExit(1)'
}

previous_release_tag_from_releases_list() {
  local json
  json="$(releases_json 2>/dev/null)" || return 1
  [ -n "$json" ] || return 1
  printf '%s' "$json" | python3 -c 'import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
seen = 0
for release in data:
    if not isinstance(release, dict):
        continue
    if release.get("draft") or release.get("prerelease"):
        continue
    tag = release.get("tag_name") or ""
    if not tag:
        continue
    if seen == 0:
        seen = 1
        continue
    print(tag)
    raise SystemExit(0)
raise SystemExit(1)'
}

cache_latest_release_tag() {
  local tag="$1"
  mkdir -p runtime/generated
  printf '%s\n' "$tag" > "$LATEST_TAG_CACHE_FILE"
}

read_cached_latest_release_tag() {
  [ -s "$LATEST_TAG_CACHE_FILE" ] || return 1
  tr -d '[:space:]' < "$LATEST_TAG_CACHE_FILE"
}

latest_release_tag() {
  local json tag

  json="$(latest_release_json 2>/dev/null)" || true
  if [ -n "$json" ]; then
    tag="$(printf '%s' "$json" | extract_json_field tag_name 2>/dev/null || true)"
    if [ -n "$tag" ]; then
      printf '%s' "$tag"
      return 0
    fi
  fi

  latest_release_tag_from_releases_list
}

previous_release_tag() {
  previous_release_tag_from_releases_list
}

list_release_rows() {
  local json
  json="$(releases_json 2>/dev/null)" || return 1
  [ -n "$json" ] || return 1
  printf '%s' "$json" | python3 -c 'import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
for release in data:
    if not isinstance(release, dict):
        continue
    if release.get("draft") or release.get("prerelease"):
        continue
    tag = (release.get("tag_name") or "").strip()
    if not tag:
        continue
    published = (release.get("published_at") or "").strip()
    published = published[:10] if published else "unknown"
    name = (release.get("name") or "").strip().replace("	", " ")
    print(f"{tag}	{published}	{name}")'
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
  local changed_files=""

  if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if ! git diff --quiet --ignore-submodules -- 2>/dev/null || ! git diff --cached --quiet --ignore-submodules -- 2>/dev/null; then
      changed_files="$(
        {
          git diff --name-only --ignore-submodules -- 2>/dev/null || true
          git diff --cached --name-only --ignore-submodules -- 2>/dev/null || true
        } | sed '/^$/d' | sort -u
      )"

      echo "Local repo has uncommitted tracked changes."
      echo "The stack update will continue and back up the current project files first."
      if [ -n "$changed_files" ]; then
        echo
        echo "Tracked files with local changes:"
        printf '%s\n' "$changed_files" | sed 's/^/  /'
      fi
      echo
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
    --exclude='./runtime/text-router' \
    --exclude='./work' \
    .

  {
    echo "from_version=$CURRENT_VERSION"
    echo "repo=$GITHUB_REPO"
  } > "$backup_dir/meta.env"
}

git_worktree_available() {
  command -v git >/dev/null 2>&1 || return 1
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 1
  git remote get-url origin >/dev/null 2>&1 || return 1
}

validate_release_tag_for_git() {
  local tag="$1"
  git check-ref-format "refs/tags/$tag" >/dev/null 2>&1
}

verify_installed_version() {
  local tag="$1"
  local backup_dir="$2"
  local new_version expected_version

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
    return 1
  fi

  echo
  echo "Installed stack version: $new_version"
  echo "Previous stack files backup:"
  echo "  $backup_dir/project-files.tgz"
  echo
  echo "Dune Docker Console files were updated."
}

web_console_service_name() {
  local service
  [ -f docker-compose.web.yml ] || return 1
  if ! command -v docker >/dev/null 2>&1; then
    return 1
  fi
  service="$(docker compose -f docker-compose.web.yml config --services 2>/dev/null | grep -E '^redblink-dune-docker-console$' | head -n1 || true)"
  [ -n "$service" ] || return 1
  printf '%s\n' "$service"
}

rebuild_web_console_now() {
  local service="$1"
  COMPOSE_PROJECT_NAME="${DUNE_COMPOSE_PROJECT_NAME:-dune-awakening-selfhost-docker}" DUNE_HOST_REPO_ROOT="$HOST_ROOT_DIR" docker compose -f docker-compose.web.yml build "$service"
  docker rm -f "$service" >/dev/null 2>&1 || true
  COMPOSE_PROJECT_NAME="${DUNE_COMPOSE_PROJECT_NAME:-dune-awakening-selfhost-docker}" DUNE_HOST_REPO_ROOT="$HOST_ROOT_DIR" docker compose -f docker-compose.web.yml up -d --force-recreate "$service"
}

rebuild_web_console_with_helper() {
  local service="$1"
  local helper_name="dune-console-self-update-$(date +%s)"
  local compose_project="${DUNE_COMPOSE_PROJECT_NAME:-dune-awakening-selfhost-docker}"
  local helper_image="${DUNE_SYSTEMD_HELPER_IMAGE:-redblink-dune-docker-console:dev}"

  docker run --rm -d \
    --name "$helper_name" \
    --network host \
    -v "$HOST_ROOT_DIR:/repo" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -e "DUNE_HOST_REPO_ROOT=$HOST_ROOT_DIR" \
    -e "COMPOSE_PROJECT_NAME=$compose_project" \
    -e "DUNE_COMPOSE_PROJECT_NAME=$compose_project" \
    -w /repo \
    "$helper_image" \
    sh -lc "sleep 2; runtime/scripts/self-update.sh rebuild-web-console '$service' >> runtime/generated/web-console-rebuild.log 2>&1"
}

rebuild_web_console_after_update() {
  local service log_file
  service="$(web_console_service_name 2>/dev/null || true)"
  if [ -z "$service" ]; then
    echo
    echo "Dune Docker Console rebuild was skipped because docker-compose.web.yml or Docker Compose is unavailable."
    echo "Run this manually after the update if you use the web panel:"
    echo "  dune console restart"
    return 0
  fi

  mkdir -p runtime/generated
  log_file="runtime/generated/web-console-rebuild.log"
  echo
  echo "Rebuilding Dune Docker Console container: $service"
  if { [ -n "${DUNE_CONTAINER_REPO_ROOT:-}" ] || [ -f /.dockerenv ]; } && [ "${DUNE_WEB_SELF_UPDATE_HELPER:-0}" != "1" ]; then
    echo "The rebuild will continue in a helper container because this update is running from the web console."
    echo "Rebuild log: $log_file"
    rebuild_web_console_with_helper "$service" >"$log_file" 2>&1 || {
      echo "Could not launch the Dune Docker Console rebuild helper."
      echo "Run this from the server folder if the web panel does not return:"
      echo "  dune console restart"
    }
  else
    rebuild_web_console_now "$service"
    echo "Dune Docker Console was rebuilt successfully."
  fi
}

install_cli_command_after_update() {
  if [ ! -x runtime/scripts/install-command.sh ]; then
    return 0
  fi

  if [ -f /.dockerenv ]; then
    echo
    echo "The dune CLI command install was skipped because the update is running inside the web console container."
    echo "If the host does not have the dune command yet, run this once from the server folder:"
    echo "  sudo ./runtime/scripts/install-command.sh"
    return 0
  fi

  echo
  echo "Installing dune CLI command..."
  if [ "$(id -u)" -eq 0 ]; then
    runtime/scripts/install-command.sh || true
  elif command -v sudo >/dev/null 2>&1; then
    sudo runtime/scripts/install-command.sh || true
  else
    echo "Could not install the dune command automatically because sudo is not available."
    echo "Run this once as root if you want the CLI command:"
    echo "  runtime/scripts/install-command.sh"
  fi
}

install_release_tag_with_git() {
  local tag="$1"
  local backup_dir target remote

  validate_release_tag_for_git "$tag" || {
    echo "Invalid release tag for Git checkout: $tag"
    exit 2
  }

  remote="$(git remote get-url origin 2>/dev/null || true)"
  echo "Updating stack Git checkout from:"
  echo "  $remote"
  echo "Fetching release tag: $tag"
  git fetch --force --tags origin
  git fetch --force origin "refs/tags/${tag}:refs/tags/${tag}" >/dev/null 2>&1 || true

  target="$(git rev-parse -q --verify "refs/tags/${tag}^{commit}" 2>/dev/null || true)"
  if [ -z "$target" ]; then
    echo "Could not resolve release tag in Git after fetch: $tag"
    exit 2
  fi

  backup_dir="runtime/backups/self-update/$(date +%Y%m%d-%H%M%S)-${tag#v}"
  echo "Backing up current stack files to:"
  echo "  $backup_dir"
  backup_current_stack "$backup_dir"

  echo "Resetting stack checkout to release tag:"
  echo "  $tag ($target)"
  git reset --hard "$target"

  verify_installed_version "$tag" "$backup_dir" || exit 4
}

install_release_tag_from_archive() {
  local tag="$1"
  local tmpdir archive src backup_dir

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

  if ! verify_installed_version "$tag" "$backup_dir"; then
    rm -rf "$tmpdir"
    exit 4
  fi

  rm -rf "$tmpdir"
}

install_release_tag() {
  local tag="$1"

  check_dirty_git_tree

  if git_worktree_available; then
    install_release_tag_with_git "$tag"
  else
    install_release_tag_from_archive "$tag"
  fi
}

cmd="${1:-check}"
tag="${2:-}"

case "$cmd" in
  rebuild-web-console)
    service="${tag:-}"
    if [ -z "$service" ]; then
      service="$(web_console_service_name 2>/dev/null || true)"
    fi
    if [ -z "$service" ]; then
      echo "Dune Docker Console service was not found in docker-compose.web.yml."
      exit 2
    fi
    rebuild_web_console_now "$service"
    echo "Dune Docker Console was rebuilt successfully."
    ;;

  check|status)
    echo "Current stack version: $CURRENT_VERSION"
    set +e
    latest="$(latest_release_tag)"
    rc=$?
    set -e

    if [ "$rc" -ne 0 ] || [ -z "${latest:-}" ]; then
      echo "Latest release:        unknown"
      echo "GitHub repo:           $GITHUB_REPO"
      echo
      print_release_fetch_failure "check stack releases"
      exit 2
    fi

    cache_latest_release_tag "$latest"
    print_versions "$latest"
    echo
    if version_newer "$CURRENT_VERSION" "$latest"; then
      echo "A newer stack version is available."
      exit 100
    fi

    echo "You are already on the latest stack version."
    exit 0
    ;;

  list|releases)
    if ! list_release_rows; then
      print_release_fetch_failure "fetch stack releases"
      exit 2
    fi
    ;;

  install|apply)
    if [ -z "$tag" ] || [ "$tag" = "latest" ]; then
      set +e
      tag="$(latest_release_tag)"
      rc=$?
      set -e
      if [ "$rc" -ne 0 ] || [ -z "$tag" ]; then
        tag="$(read_cached_latest_release_tag 2>/dev/null || true)"
      fi
      if [ -z "$tag" ]; then
        echo "Could not resolve the latest stack release."
        case "${API_LAST_STATUS:-}" in
          401|403)
            echo "GitHub API access was denied or rate-limited."
            ;;
          404)
            echo "No published release could be resolved from the detected GitHub repo."
            ;;
        esac
        exit 2
      fi
    elif [ "$tag" = "previous" ]; then
      set +e
      tag="$(previous_release_tag)"
      rc=$?
      set -e
      if [ "$rc" -ne 0 ] || [ -z "$tag" ]; then
        echo "Could not resolve the previous stack release."
        echo "Make sure the GitHub repo has at least two published non-prerelease releases."
        exit 2
      fi
    fi

    cache_latest_release_tag "$tag"
    install_release_tag "$tag"
    install_cli_command_after_update
    rebuild_web_console_after_update
    ;;

  *)
    echo "Usage:"
    echo "  runtime/scripts/self-update.sh check"
    echo "  runtime/scripts/self-update.sh list"
    echo "  runtime/scripts/self-update.sh install [latest|previous|<tag>]"
    exit 2
    ;;
esac

#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT_DIR="$(pwd)"

. runtime/scripts/compose-project.sh
DUNE_COMPOSE_PROJECT_NAME="$(dune_resolve_compose_project_name "$ROOT_DIR")"
export DUNE_COMPOSE_PROJECT_NAME

CURRENT_VERSION="dev"
[ -f VERSION ] && CURRENT_VERSION="$(tr -d '[:space:]' < VERSION)"
DEFAULT_SELF_UPDATE_REPO="Red-Blink/dune-awakening-selfhost-docker"

normalize_github_remote_repo() {
  local remote="$1"

  case "$remote" in
    https://github.com/*)
      remote="${remote#https://github.com/}"
      ;;
    git@github.com:*)
      remote="${remote#git@github.com:}"
      ;;
    ssh://git@github.com/*)
      remote="${remote#ssh://git@github.com/}"
      ;;
    *)
      return 1
      ;;
  esac

  remote="${remote%.git}"
  remote="${remote%/}"
  [ -n "$remote" ] || return 1
  printf '%s\n' "$remote"
}

github_repo_from_git_remote() {
  local remote_name="$1"
  local remote

  remote="$(git remote get-url "$remote_name" 2>/dev/null || true)"
  [ -n "$remote" ] || return 1
  normalize_github_remote_repo "$remote"
}

detect_github_repo() {
  local remote_name repo

  if [ -n "${DUNE_SELF_UPDATE_REPO:-}" ]; then
    printf '%s\n' "$DUNE_SELF_UPDATE_REPO"
    return 0
  fi

  if command -v git >/dev/null 2>&1; then
    for remote_name in upstream origin; do
      repo="$(github_repo_from_git_remote "$remote_name" 2>/dev/null || true)"
      if [ "$repo" = "$DEFAULT_SELF_UPDATE_REPO" ]; then
        printf '%s\n' "$repo"
        return 0
      fi
    done

    repo="$(github_repo_from_git_remote upstream 2>/dev/null || true)"
    if [ -n "$repo" ]; then
      printf '%s\n' "$repo"
      return 0
    fi

    repo="$(github_repo_from_git_remote origin 2>/dev/null || true)"
    if [ -n "$repo" ]; then
      printf '%s\n' "$repo"
      return 0
    fi
  fi

  printf '%s\n' "$DEFAULT_SELF_UPDATE_REPO"
}

detect_github_fetch_remote() {
  local repo="$1"
  local remote_name remote_repo

  # Release updates for the public project must not inherit an installation's
  # credential-bearing, SSH-only, or otherwise locally rewritten remote. The
  # detached Console helper has no interactive terminal and users do not need
  # a GitHub account to download a public release.
  if [ "$repo" = "$DEFAULT_SELF_UPDATE_REPO" ]; then
    printf '%s\n' "https://github.com/${repo}.git"
    return 0
  fi

  if command -v git >/dev/null 2>&1; then
    for remote_name in upstream origin; do
      remote_repo="$(github_repo_from_git_remote "$remote_name" 2>/dev/null || true)"
      if [ "$remote_repo" = "$repo" ]; then
        printf '%s\n' "$remote_name"
        return 0
      fi
    done
  fi

  printf '%s\n' "https://github.com/${repo}.git"
}

GITHUB_REPO="$(detect_github_repo)"
GITHUB_FETCH_REMOTE="$(detect_github_fetch_remote "$GITHUB_REPO")"
GITHUB_API_BASE="${DUNE_SELF_UPDATE_API_BASE:-https://api.github.com}"
GITHUB_WEB_BASE="${DUNE_SELF_UPDATE_WEB_BASE:-https://github.com}"
GITHUB_TOKEN="${DUNE_SELF_UPDATE_TOKEN:-}"
LATEST_TAG_CACHE_FILE="runtime/generated/self-update-latest-tag.txt"
API_LAST_STATUS=""
SELF_UPDATE_RUN_ID="${DUNE_SELF_UPDATE_RUN_ID:-}"
SELF_UPDATE_STATUS_DIR="runtime/generated/self-update-status"
SELF_UPDATE_STATUS_STARTED_AT=""
SELF_UPDATE_STATUS_FINALIZED=0
SELF_UPDATE_STATUS_STAGE="launching"
SELF_UPDATE_STATUS_PERCENT=1

self_update_status_enabled() {
  [[ "$SELF_UPDATE_RUN_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]
}

self_update_write_status() {
  local state="$1"
  local stage="$2"
  local percent="$3"
  local message="$4"
  local finished_at="${5:-}"
  local status_file tmp_file updated_at

  self_update_status_enabled || return 0
  SELF_UPDATE_STATUS_STAGE="$stage"
  SELF_UPDATE_STATUS_PERCENT="$percent"
  mkdir -p "$SELF_UPDATE_STATUS_DIR"
  status_file="$SELF_UPDATE_STATUS_DIR/$SELF_UPDATE_RUN_ID.env"
  tmp_file="$status_file.tmp.$$"
  updated_at="$(date -Is)"
  [ -n "$SELF_UPDATE_STATUS_STARTED_AT" ] || SELF_UPDATE_STATUS_STARTED_AT="$updated_at"
  message="${message//$'\n'/ }"
  message="${message//$'\r'/ }"
  {
    printf 'run_id=%s\n' "$SELF_UPDATE_RUN_ID"
    printf 'state=%s\n' "$state"
    printf 'stage=%s\n' "$stage"
    printf 'percent=%s\n' "$percent"
    printf 'message=%s\n' "$message"
    printf 'started_at=%s\n' "$SELF_UPDATE_STATUS_STARTED_AT"
    printf 'updated_at=%s\n' "$updated_at"
    printf 'finished_at=%s\n' "$finished_at"
  } > "$tmp_file"
  chmod 600 "$tmp_file"
  mv -f "$tmp_file" "$status_file"
}

self_update_running() {
  self_update_write_status running "$1" "$2" "$3"
}

self_update_finish_success() {
  local now
  now="$(date -Is)"
  self_update_write_status succeeded complete 100 "Console update completed successfully." "$now"
  SELF_UPDATE_STATUS_FINALIZED=1
}

self_update_finish_failure() {
  local stage="$1"
  local percent="$2"
  local message="$3"
  local now
  now="$(date -Is)"
  self_update_write_status failed "$stage" "$percent" "$message" "$now"
  SELF_UPDATE_STATUS_FINALIZED=1
}

self_update_on_exit() {
  local rc=$?
  trap - EXIT
  if self_update_status_enabled && [ "$SELF_UPDATE_STATUS_FINALIZED" != "1" ] && [ "$rc" -ne 0 ]; then
    self_update_write_status failed "$SELF_UPDATE_STATUS_STAGE" "$SELF_UPDATE_STATUS_PERCENT" "Console update failed. Review runtime/generated/web-self-update.log for details." "$(date -Is)" || true
  fi
  exit "$rc"
}

trap self_update_on_exit EXIT

acquire_self_update_lock() {
  mkdir -p runtime/generated
  exec 9>runtime/generated/self-update.lock
  if ! flock -n 9; then
    self_update_write_status failed busy 0 "Another console update is already running." "$(date -Is)" || true
    SELF_UPDATE_STATUS_FINALIZED=1
    echo "Another console update is already running. Wait for it to finish before retrying." >&2
    exit 75
  fi
  find "$SELF_UPDATE_STATUS_DIR" -type f -name '*.env' -mtime +7 -delete 2>/dev/null || true
  self_update_running preparing 5 "Preparing the console update."
}

self_update_build_timeout_seconds() {
  local value="${DUNE_SELF_UPDATE_BUILD_TIMEOUT_SECONDS:-1800}"
  if [[ "$value" =~ ^[0-9]+$ ]] && [ "$value" -ge 60 ] && [ "$value" -le 7200 ]; then
    printf '%s\n' "$value"
  else
    printf '%s\n' 1800
  fi
}

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

github_curl_headers() {
  printf '%s\n' \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28"
  if [ -n "$GITHUB_TOKEN" ]; then
    printf '%s\n' -H "Authorization: Bearer $GITHUB_TOKEN"
  fi
}

api_curl_common_args() {
  printf '%s\n' \
    --connect-timeout 15 \
    --max-time 60 \
    --retry 2 \
    --retry-delay 2 \
    --retry-all-errors
  github_curl_headers
}

self_update_download_timeout_seconds() {
  local value="${DUNE_SELF_UPDATE_DOWNLOAD_TIMEOUT_SECONDS:-7200}"
  if [[ "$value" =~ ^[0-9]+$ ]] && [ "$value" -ge 2 ] && [ "$value" -le 14400 ]; then
    printf '%s\n' "$value"
  else
    printf '%s\n' 7200
  fi
}

self_update_progress_interval_seconds() {
  local value="${DUNE_SELF_UPDATE_PROGRESS_INTERVAL_SECONDS:-5}"
  if [[ "$value" =~ ^[0-9]+$ ]] && [ "$value" -ge 1 ] && [ "$value" -le 30 ]; then
    printf '%s\n' "$value"
  else
    printf '%s\n' 5
  fi
}

download_archive_with_progress() {
  local url="$1"
  local out="$2"
  local label="$3"
  local timeout_seconds interval_seconds error_file curl_pid curl_rc bytes megabytes ticks=0
  local -a curl_args

  timeout_seconds="$(self_update_download_timeout_seconds)"
  interval_seconds="$(self_update_progress_interval_seconds)"
  error_file="$(mktemp)"
  mapfile -t curl_args < <(github_curl_headers)

  self_update_running downloading 20 "$label (starting download)."
  set +e
  timeout --signal=TERM --kill-after=10 "${timeout_seconds}s" \
    curl -fsSL \
      "${curl_args[@]}" \
      --connect-timeout 15 \
      --retry 3 \
      --retry-delay 3 \
      --retry-all-errors \
      --speed-limit 1024 \
      --speed-time 120 \
      -L "$url" -o "$out" 2>"$error_file" &
  curl_pid=$!
  set -e

  while kill -0 "$curl_pid" 2>/dev/null; do
    sleep 1
    kill -0 "$curl_pid" 2>/dev/null || break
    ticks=$((ticks + 1))
    [ "$ticks" -ge "$interval_seconds" ] || continue
    ticks=0
    bytes="$(stat -c '%s' "$out" 2>/dev/null || printf '0')"
    [[ "$bytes" =~ ^[0-9]+$ ]] || bytes=0
    megabytes=$((bytes / 1048576))
    self_update_running downloading 20 "$label (${megabytes} MB received)."
  done

  set +e
  wait "$curl_pid"
  curl_rc=$?
  set -e
  if [ "$curl_rc" -ne 0 ]; then
    if [ "$curl_rc" -eq 124 ]; then
      self_update_finish_failure downloading 20 "$label timed out after ${timeout_seconds} seconds. Check the server's connection to GitHub, then retry."
      echo "$label timed out after ${timeout_seconds} seconds." >&2
    elif [ -s "$error_file" ]; then
      self_update_finish_failure downloading 20 "$label failed after retrying. Check the server's connection to GitHub, then retry."
      cat "$error_file" >&2
    else
      self_update_finish_failure downloading 20 "$label failed after retrying. Check the server's connection to GitHub, then retry."
    fi
    rm -f "$error_file"
    return "$curl_rc"
  fi

  rm -f "$error_file"
  bytes="$(stat -c '%s' "$out" 2>/dev/null || printf '0')"
  [[ "$bytes" =~ ^[0-9]+$ ]] || bytes=0
  if [ "$bytes" -le 0 ]; then
    self_update_finish_failure downloading 20 "$label completed without an archive. Retry the update."
    echo "Release download completed without an archive." >&2
    return 22
  fi
  megabytes=$((bytes / 1048576))
  self_update_running downloading 35 "$label (${megabytes} MB received; validating archive)."
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

latest_release_tag_from_web_redirect() {
  local effective_url prefix tag

  effective_url="$(
    curl -fsSL \
      --connect-timeout 10 \
      --max-time 20 \
      -o /dev/null \
      -w '%{url_effective}' \
      "${GITHUB_WEB_BASE}/${GITHUB_REPO}/releases/latest"
  )" || return 1
  prefix="${GITHUB_WEB_BASE}/${GITHUB_REPO}/releases/tag/"
  [[ "$effective_url" == "$prefix"* ]] || return 1
  tag="${effective_url#"$prefix"}"
  [[ "$tag" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] || return 1
  printf '%s' "$tag"
}

cache_latest_release_tag() {
  local tag="$1"
  (
    mkdir -p runtime/generated
    printf '%s\n' "$tag" > "$LATEST_TAG_CACHE_FILE"
  ) 2>/dev/null || true
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

  tag="$(latest_release_tag_from_releases_list 2>/dev/null || true)"
  if [ -n "$tag" ]; then
    printf '%s' "$tag"
    return 0
  fi

  latest_release_tag_from_web_redirect
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

self_update_repair_command() {
  printf 'sudo chown -R "%s:%s" %q\n' "$(id -u)" "$(id -g)" "$HOST_ROOT_DIR"
}

print_repo_not_writable() {
  echo "Self-update cannot continue because the install folder is not writable by the current user."
  echo "Install folder:"
  echo "  $HOST_ROOT_DIR"
  echo
  echo "This usually happens when earlier install or update commands were run with sudo."
  echo "Run this once, then retry the update:"
  echo "  $(self_update_repair_command)"
}

ensure_path_writable() {
  local path="$1"
  [ -e "$path" ] || return 0
  [ -w "$path" ] || {
    print_repo_not_writable
    echo
    echo "Blocked path:"
    echo "  $path"
    exit 13
  }
}

ensure_self_update_writable() {
  local test_file

  ensure_path_writable "$ROOT_DIR"
  ensure_path_writable "VERSION"
  ensure_path_writable "runtime"
  ensure_path_writable "runtime/scripts"
  ensure_path_writable "runtime/scripts/self-update.sh"

  if ! mkdir -p runtime/generated runtime/backups/self-update 2>/dev/null; then
    print_repo_not_writable
    exit 13
  fi

  for test_file in runtime/generated/.self-update-write-test runtime/backups/self-update/.self-update-write-test; do
    if ! : > "$test_file" 2>/dev/null; then
      print_repo_not_writable
      echo
      echo "Blocked path:"
      echo "  $test_file"
      exit 13
    fi
    rm -f "$test_file" 2>/dev/null || true
  done
}

ensure_docker_access_for_console_rebuild() {
  [ -f docker-compose.web.yml ] || return 0
  command -v docker >/dev/null 2>&1 || return 0
  if docker ps >/dev/null 2>&1; then
    return 0
  fi

  echo "Self-update cannot continue because the current user cannot access Docker."
  echo
  echo "The update needs Docker access to rebuild and restart the Dune Docker Console."
  echo "Run this once, then fully log out and back in before retrying:"
  echo "  sudo usermod -aG docker \"\$USER\""
  echo
  echo "After reconnecting, verify Docker access with:"
  echo "  docker ps"
  exit 13
}

ensure_self_update_preflight() {
  ensure_self_update_writable
  ensure_docker_access_for_console_rebuild
}

download_release_archive() {
  local tag="$1"
  local out="$2"
  local tarball_url

  self_update_running downloading 20 "Downloading console release $tag."
  tarball_url="$(release_tarball_url "$tag")"
  if [ -z "$tarball_url" ]; then
    echo "Could not find tarball URL for release tag: $tag"
    exit 2
  fi

  download_archive_with_progress "$tarball_url" "$out" "Downloading console release $tag"
}

backup_current_stack() {
  local backup_dir="$1"
  self_update_running backup 40 "Backing up the current console files."
  mkdir -p "$backup_dir"

  tar -czf "$backup_dir/project-files.tgz" \
    --exclude='./.git' \
    --exclude='./.env' \
    --exclude='*/__pycache__' \
    --exclude='*/__pycache__/*' \
    --exclude='*.pyc' \
    --exclude='*.pyo' \
    --exclude='./runtime/generated' \
    --exclude='./runtime/secrets' \
    --exclude='./runtime/backups' \
    --exclude='./runtime/addons' \
    --exclude='./runtime/game' \
    --exclude='./runtime/logs' \
    --exclude='./runtime/text-router' \
    --exclude='./runtime/rabbitmq-admin' \
    --exclude='./runtime/rabbitmq-game' \
    --exclude='./runtime/postgres' \
    --exclude='./runtime/director' \
    --exclude='./runtime/server-gateway' \
    --exclude='./runtime/fake-k8s-serviceaccount' \
    --exclude='./work' \
    .

  {
    echo "from_version=$CURRENT_VERSION"
    echo "repo=$GITHUB_REPO"
  } > "$backup_dir/meta.env"

  backup_local_state "$backup_dir"
}

remove_backed_up_project_files() {
  local backup_dir="$1"
  local manifest path relative target parent unsafe_path blocked_path

  [ -s "$backup_dir/project-files.tgz" ] || return 0
  unsafe_path=""
  blocked_path=""
  manifest="$(mktemp)"
  tar -tzf "$backup_dir/project-files.tgz" > "$manifest"

  # Validate the complete removal set before changing the checkout. Deleting a
  # file requires write and search permission on its parent directory; checking
  # only the file itself misses root-owned directories such as __pycache__.
  while IFS= read -r path; do
    relative="${path#./}"
    [ -n "$relative" ] || continue
    case "/$relative/" in
      *"/../"*|*"/./"*)
        unsafe_path="$path"
        break
        ;;
    esac
    target="$ROOT_DIR/$relative"
    if [ -f "$target" ] || [ -L "$target" ]; then
      parent="$(dirname "$target")"
      if [ ! -w "$parent" ] || [ ! -x "$parent" ]; then
        blocked_path="$target"
        break
      fi
    fi
  done < "$manifest"

  if [ -n "$unsafe_path" ]; then
    rm -f "$manifest"
    echo "Refusing unsafe path from project backup: $unsafe_path"
    return 1
  fi
  if [ -n "$blocked_path" ]; then
    rm -f "$manifest"
    print_repo_not_writable
    echo
    echo "Blocked project file:"
    echo "  $blocked_path"
    echo
    echo "No project files were removed. Repair ownership, then retry the update."
    return 13
  fi

  while IFS= read -r path; do
    relative="${path#./}"
    [ -n "$relative" ] || continue
    target="$ROOT_DIR/$relative"
    if [ -f "$target" ] || [ -L "$target" ]; then
      rm -f "$target"
    fi
  done < "$manifest"

  rm -f "$manifest"
}

backup_local_state() {
  local backup_dir="$1"
  local manifest="$backup_dir/local-state-files.txt"

  : > "$manifest"
  for path in \
    .env \
    runtime/generated/battlegroup.env \
    runtime/generated/db-backup.env \
    runtime/generated/director-character-transfer.ini \
    runtime/generated/director-capacity.ini \
    runtime/generated/director-deepdesert-dual.ini \
    runtime/generated/ip-change-restart.env \
    runtime/generated/landsraad-milestones.json \
    runtime/generated/map-runtime-modes.json \
    runtime/generated/memory-balancer.json \
    runtime/generated/message-of-the-day.json \
    runtime/generated/message-of-the-day-state.json \
    runtime/generated/player-announcements.json \
    runtime/generated/player-announcements-state.json \
    runtime/generated/scheduled-map-messages.json \
    runtime/generated/public-directory-status.json \
    runtime/generated/public-probe.env \
    runtime/generated/restart-schedule.env \
    runtime/generated/shutdown-protection.env \
    runtime/generated/sietch-config.json \
    runtime/generated/spicefield-overrides.json \
    runtime/generated/update-auto.env \
    runtime/generated/usersettings.json \
    runtime/generated/auto-refill-bases.json \
    runtime/generated/pending-generator-refills.json \
    runtime/generated/gameplay-profile.ini \
    runtime/generated/care-package.json \
    runtime/generated/care-package-grants.jsonl \
    runtime/generated/care-package-grant-receipts.json \
    runtime/generated/care-package-first-online-claims.json \
    runtime/generated/care-package-pending-returns.json \
    runtime/addons/state.json \
    runtime/secrets/funcom-token.txt \
    runtime/secrets/public-directory.json
  do
    [ -e "$path" ] || continue
    printf '%s\n' "$path" >> "$manifest"
  done

  if [ -s "$manifest" ]; then
    # Writers stay online. Archive private, bounded copies instead of live files.
    python3 - "$backup_dir" "$manifest" <<'PY'
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile

backup = Path(sys.argv[1]).resolve()
paths = Path(sys.argv[2]).read_text().splitlines()
with tempfile.TemporaryDirectory(prefix=".local-state-", dir=backup) as staging:
    for name in paths:
        target = Path(staging) / name
        target.parent.mkdir(parents=True, exist_ok=True)
        with open(name, "rb") as source, open(target, "xb") as output:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise RuntimeError(f"Local state is not a regular file: {name}")
            os.fchmod(output.fileno(), stat.S_IMODE(info.st_mode))
            remaining = info.st_size
            while remaining:
                chunk = source.read(min(remaining, 1024 * 1024))
                if not chunk:
                    raise RuntimeError(f"Local state truncated during snapshot: {name}")
                output.write(chunk)
                remaining -= len(chunk)
        # An append may have been in progress: preserve only complete audit rows.
        if name.endswith(".jsonl"):
            with open(target, "r+b") as snapshot:
                end = snapshot.seek(0, os.SEEK_END)
                while end:
                    start = max(0, end - 65536)
                    snapshot.seek(start)
                    chunk = snapshot.read(end - start)
                    newline = chunk.rfind(b"\n")
                    if newline >= 0:
                        end = start + newline + 1
                        break
                    end = start
                snapshot.truncate(end)
    archive = backup / ".local-state.tgz.tmp"
    try:
        subprocess.run(["tar", "-czf", str(archive), "-C", staging, "--", *paths], check=True, umask=0o077)
        os.replace(archive, backup / "local-state.tgz")
    finally:
        archive.unlink(missing_ok=True)
PY
  else
    rm -f "$manifest"
  fi
}

restore_local_state_file_if_needed() {
  local backup_dir="$1"
  local path="$2"
  local tmpdir

  [ -s "$backup_dir/local-state.tgz" ] || return 0
  if [ -s "$path" ]; then
    return 0
  fi

  tmpdir="$(mktemp -d)"
  tar -xzf "$backup_dir/local-state.tgz" -C "$tmpdir" "$path" 2>/dev/null || {
    rm -rf "$tmpdir"
    return 0
  }
  if [ -e "$tmpdir/$path" ]; then
    mkdir -p "$(dirname "$path")"
    cp -a "$tmpdir/$path" "$path"
    echo "Restored local state file after update: $path"
  fi
  rm -rf "$tmpdir"
}

merge_env_keys_from_backup() {
  local backup_dir="$1"
  local path="$2"
  local tmpdir backup_file merged

  [ -s "$backup_dir/local-state.tgz" ] || return 0
  tmpdir="$(mktemp -d)"
  tar -xzf "$backup_dir/local-state.tgz" -C "$tmpdir" "$path" 2>/dev/null || {
    rm -rf "$tmpdir"
    return 0
  }
  backup_file="$tmpdir/$path"
  [ -s "$backup_file" ] || {
    rm -rf "$tmpdir"
    return 0
  }

  mkdir -p "$(dirname "$path")"
  [ -f "$path" ] || : > "$path"
  merged="$(mktemp)"
  awk -F= '
    FNR == NR {
      line = $0
      if (line ~ /^[[:space:]]*($|#)/ || index(line, "=") == 0) {
        next
      }
      key = $1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
      if (!(key in backup_line)) {
        backup_key[++backup_count] = key
      }
      backup_line[key] = line
      next
    }
    {
      if ($0 ~ /^[[:space:]]*($|#)/ || index($0, "=") == 0) {
        print
        next
      }
      key = $1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
      present[key] = 1
      if (key in backup_line) {
        print backup_line[key]
      } else {
        print
      }
    }
    END {
      added = 0
      for (i = 1; i <= backup_count; i++) {
        key = backup_key[i]
        if (key == "" || present[key]) continue
        if (!added) {
          print ""
          print "# Restored from pre-update local state"
          added = 1
        }
        print backup_line[key]
      }
    }
  ' "$backup_file" "$path" > "$merged"
  if ! cmp -s "$merged" "$path"; then
    cp "$merged" "$path"
    echo "Merged missing local config keys after update: $path"
  fi
  rm -f "$merged"
  rm -rf "$tmpdir"
}

restore_local_state_after_install() {
  local backup_dir="$1"

  restore_local_state_file_if_needed "$backup_dir" .env
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/battlegroup.env
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/db-backup.env
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/director-character-transfer.ini
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/director-capacity.ini
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/director-deepdesert-dual.ini
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/ip-change-restart.env
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/landsraad-milestones.json
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/map-runtime-modes.json
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/memory-balancer.json
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/message-of-the-day.json
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/message-of-the-day-state.json
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/player-announcements.json
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/player-announcements-state.json
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/scheduled-map-messages.json
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/public-directory-status.json
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/public-probe.env
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/restart-schedule.env
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/shutdown-protection.env
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/sietch-config.json
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/spicefield-overrides.json
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/update-auto.env
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/usersettings.json
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/auto-refill-bases.json
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/pending-generator-refills.json
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/gameplay-profile.ini
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/care-package.json
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/care-package-grants.jsonl
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/care-package-grant-receipts.json
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/care-package-first-online-claims.json
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/care-package-pending-returns.json
  restore_local_state_file_if_needed "$backup_dir" runtime/addons/state.json
  restore_local_state_file_if_needed "$backup_dir" runtime/secrets/funcom-token.txt
  restore_local_state_file_if_needed "$backup_dir" runtime/secrets/public-directory.json
  merge_env_keys_from_backup "$backup_dir" .env
  merge_env_keys_from_backup "$backup_dir" runtime/generated/battlegroup.env
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
  rm -f runtime/generated/qa-update-channel.env
  echo "Previous stack files backup:"
  echo "  $backup_dir/project-files.tgz"
  echo
  echo "Dune Docker Console files were updated."
}

validate_commit_sha() {
  [[ "$1" =~ ^[0-9a-fA-F]{40}$ ]]
}

download_commit_archive() {
  local sha="$1"
  local out="$2"

  self_update_running downloading 20 "Downloading QA build ${sha:0:8}."
  download_archive_with_progress \
    "${GITHUB_API_BASE}/repos/${GITHUB_REPO}/tarball/${sha}" \
    "$out" \
    "Downloading QA build ${sha:0:8}"
}

install_qa_commit() {
  local sha="$1"
  local tmpdir archive src backup_dir

  validate_commit_sha "$sha" || {
    echo "Invalid QA build identifier."
    exit 2
  }
  sha="${sha,,}"
  check_dirty_git_tree

  tmpdir="$(mktemp -d)"
  archive="$tmpdir/qa.tar.gz"
  download_commit_archive "$sha" "$archive"
  tar -xzf "$archive" -C "$tmpdir"
  src="$(find "$tmpdir" -mindepth 1 -maxdepth 1 -type d | head -n1)"
  if [ -z "$src" ] || [ ! -d "$src" ] || [ ! -f "$src/runtime/scripts/self-update.sh" ] || [ ! -f "$src/docker-compose.web.yml" ]; then
    echo "The downloaded QA build is incomplete."
    rm -rf "$tmpdir"
    exit 2
  fi

  backup_dir="runtime/backups/self-update/$(date +%Y%m%d-%H%M%S)-qa-${sha:0:12}"
  echo "Backing up current stack files to:"
  echo "  $backup_dir"
  backup_current_stack "$backup_dir"

  echo "Installing QA build into:"
  echo "  $ROOT_DIR"
  self_update_running installing 62 "Installing QA build ${sha:0:8}."
  remove_backed_up_project_files "$backup_dir"
  (
    cd "$src"
    tar --exclude='.git' -cf - .
  ) | (
    cd "$ROOT_DIR"
    tar -xf -
  )
  restore_local_state_after_install "$backup_dir"
  mkdir -p runtime/generated
  {
    echo "channel=qa"
    echo "commit_sha=$sha"
    echo "installed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > runtime/generated/qa-update-channel.env
  rm -rf "$tmpdir"

  echo
  echo "Installed QA build: ${sha:0:8}"
  echo "Previous stack files backup:"
  echo "  $backup_dir/project-files.tgz"
  self_update_running installed 75 "QA build files were installed and verified."
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

read_env_file_value() {
  local key="$1"
  [ -f .env ] || return 1
  awk -F= -v key="$key" '$1 == key {print $2; exit}' .env | tr -d '[:space:]"'\'''
}

persist_env_file_value() {
  local key="$1"
  local value="$2"
  [ -n "$value" ] || return 0
  if [ -f .env ] && grep -q "^${key}=" .env; then
    sed -i "s/^${key}=.*/${key}=${value}/" .env
  else
    printf '\n%s=%s\n' "$key" "$value" >> .env
  fi
}

running_console_env_value() {
  local key="$1"
  command -v docker >/dev/null 2>&1 || return 1
  docker inspect redblink-dune-docker-console \
    --format "{{range .Config.Env}}{{println .}}{{end}}" \
    2>/dev/null | awk -F= -v key="$key" '$1 == key {print $2; exit}'
}

host_repo_owner_id() {
  local field="$1"
  local path="${HOST_ROOT_DIR:-$ROOT_DIR}"

  if command -v stat >/dev/null 2>&1; then
    case "$field" in
      uid)
        stat -c '%u' "$path" 2>/dev/null || true
        ;;
      gid)
        stat -c '%g' "$path" 2>/dev/null || true
        ;;
    esac
  fi
}

normalize_host_owner_env() {
  local owner_uid owner_gid

  owner_uid="$(host_repo_owner_id uid)"
  owner_gid="$(host_repo_owner_id gid)"

  if [ -z "${DUNE_HOST_UID:-}" ] || { [ "${DUNE_HOST_UID:-}" = "0" ] && [ -n "$owner_uid" ] && [ "$owner_uid" != "0" ]; }; then
    DUNE_HOST_UID="${owner_uid:-$(id -u)}"
  fi
  if [ -z "${DUNE_HOST_GID:-}" ] || { [ "${DUNE_HOST_GID:-}" = "0" ] && [ -n "$owner_gid" ] && [ "$owner_gid" != "0" ]; }; then
    DUNE_HOST_GID="${owner_gid:-$(id -g)}"
  fi

  export DUNE_HOST_UID DUNE_HOST_GID
}

restore_local_state_ownership() {
  [ -n "${DUNE_HOST_UID:-}" ] || return 0
  [ -n "${DUNE_HOST_GID:-}" ] || return 0
  [ "$DUNE_HOST_UID" != "0" ] || return 0

  chown "$DUNE_HOST_UID:$DUNE_HOST_GID" \
    . \
    .env \
    runtime/generated \
    runtime/generated/battlegroup.env \
    runtime/generated/db-backup.env \
    runtime/generated/director-character-transfer.ini \
    runtime/generated/director-capacity.ini \
    runtime/generated/director-deepdesert-dual.ini \
    runtime/generated/ip-change-restart.env \
    runtime/generated/landsraad-milestones.json \
    runtime/generated/map-runtime-modes.json \
    runtime/generated/memory-balancer.json \
    runtime/generated/message-of-the-day.json \
    runtime/generated/message-of-the-day-state.json \
    runtime/generated/player-announcements.json \
    runtime/generated/player-announcements-state.json \
    runtime/generated/scheduled-map-messages.json \
    runtime/generated/public-directory-status.json \
    runtime/generated/public-probe.env \
    runtime/generated/restart-schedule.env \
    runtime/generated/shutdown-protection.env \
    runtime/generated/sietch-config.json \
    runtime/generated/spicefield-overrides.json \
    runtime/generated/update-auto.env \
    runtime/generated/usersettings.json \
    runtime/generated/auto-refill-bases.json \
    runtime/generated/pending-generator-refills.json \
    runtime/generated/gameplay-profile.ini \
    runtime/generated/care-package.json \
    runtime/generated/care-package-grants.jsonl \
    runtime/generated/care-package-grant-receipts.json \
    runtime/generated/care-package-first-online-claims.json \
    runtime/generated/care-package-pending-returns.json \
    runtime/addons \
    runtime/addons/downloads \
    runtime/addons/installed \
    runtime/addons/staging \
    runtime/addons/state.json \
    runtime/secrets/public-directory.json \
    runtime/secrets/funcom-token.txt \
    2>/dev/null || true
}

prepare_docker_socket_gid() {
  if [ -z "${DOCKER_SOCKET_GID:-}" ]; then
    DOCKER_SOCKET_GID="$(read_env_file_value DOCKER_SOCKET_GID 2>/dev/null || true)"
  fi
  if [ -z "${DOCKER_SOCKET_GID:-}" ]; then
    DOCKER_SOCKET_GID="$(running_console_env_value DOCKER_SOCKET_GID 2>/dev/null || true)"
  fi
  if [ -z "${DOCKER_SOCKET_GID:-}" ] && [ -S /var/run/docker.sock ] && command -v stat >/dev/null 2>&1; then
    DOCKER_SOCKET_GID="$(stat -c '%g' /var/run/docker.sock 2>/dev/null || true)"
  fi
  export DOCKER_SOCKET_GID="${DOCKER_SOCKET_GID:-0}"
  persist_env_file_value DOCKER_SOCKET_GID "$DOCKER_SOCKET_GID"
}

prepare_web_console_rebuild_env() {
  local port
  normalize_host_owner_env

  port="${ADMIN_BIND_PORT:-}"
  if [ -z "$port" ]; then
    port="$(read_env_file_value ADMIN_BIND_PORT 2>/dev/null || true)"
  fi
  if [ -z "$port" ]; then
    port="$(running_console_env_value ADMIN_BIND_PORT 2>/dev/null || true)"
  fi
  if [ -n "$port" ]; then
    export ADMIN_BIND_PORT="$port"
    persist_env_file_value ADMIN_BIND_PORT "$port"
  fi
  prepare_docker_socket_gid
  normalize_host_owner_env
  persist_env_file_value DUNE_HOST_UID "$DUNE_HOST_UID"
  persist_env_file_value DUNE_HOST_GID "$DUNE_HOST_GID"
  restore_local_state_ownership
}

rebuild_web_console_now() {
  local service="$1"
  local web_compose_project="${DUNE_WEB_COMPOSE_PROJECT_NAME:-dune-awakening-selfhost-docker}"
  local build_timeout build_rc=0
  prepare_web_console_rebuild_env
  build_timeout="$(self_update_build_timeout_seconds)"
  self_update_running building 82 "Building the updated web console (timeout: ${build_timeout}s)."
  COMPOSE_PROJECT_NAME="$web_compose_project" DUNE_COMPOSE_PROJECT_NAME="$DUNE_COMPOSE_PROJECT_NAME" DUNE_HOST_REPO_ROOT="$HOST_ROOT_DIR" \
    timeout --signal=TERM --kill-after=30s "${build_timeout}s" \
      docker compose -f docker-compose.web.yml build "$service" || build_rc=$?
  if [ "$build_rc" -ne 0 ]; then
    if [ "$build_rc" -eq 124 ] || [ "$build_rc" -eq 137 ]; then
      echo "Dune Docker Console build timed out after ${build_timeout} seconds." >&2
    fi
    return "$build_rc"
  fi
  # Reconcile supporting services before publishing the replacement Console.
  # Otherwise the new UI can become reachable first, capture a transient
  # Missing/Failed snapshot, and retain it until the next manual refresh.
  reconcile_coriolis_coordinator_after_deploy
  self_update_running restarting 94 "Restarting the updated web console."
  docker rm -f "$service" >/dev/null 2>&1 || true
  COMPOSE_PROJECT_NAME="$web_compose_project" DUNE_COMPOSE_PROJECT_NAME="$DUNE_COMPOSE_PROJECT_NAME" DUNE_HOST_REPO_ROOT="$HOST_ROOT_DIR" docker compose -f docker-compose.web.yml up -d --force-recreate "$service"
}

reconcile_coriolis_coordinator_after_deploy() {
  [ -x runtime/scripts/start-coriolis-coordinator.sh ] || return 0

  # The shared launcher knows whether the Battlegroup is active. This keeps a
  # Console-only update from reviving an intentionally stopped deployment.
  runtime/scripts/start-coriolis-coordinator.sh --replace-if-stack-running || {
    echo "Warning: the Coriolis Coordinator could not be started after the Console deployment." >&2
  }
}

rebuild_web_console_with_helper() {
  local service="$1"
  local helper_name
  helper_name="dune-console-self-update-$(date +%s)"
  local compose_project="$DUNE_COMPOSE_PROJECT_NAME"
  local helper_image="${DUNE_SYSTEMD_HELPER_IMAGE:-redblink-dune-docker-console:dev}"

  prepare_web_console_rebuild_env

  docker run --rm -d \
    --name "$helper_name" \
    --user "${DUNE_HOST_UID:-0}:${DUNE_HOST_GID:-0}" \
    --group-add "${DOCKER_SOCKET_GID:-0}" \
    --network host \
    -v "$HOST_ROOT_DIR:/repo" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -e "DUNE_HOST_REPO_ROOT=$HOST_ROOT_DIR" \
    -e "COMPOSE_PROJECT_NAME=$compose_project" \
    -e "DUNE_COMPOSE_PROJECT_NAME=$compose_project" \
    -e "DUNE_HOST_UID=${DUNE_HOST_UID:-0}" \
    -e "DUNE_HOST_GID=${DUNE_HOST_GID:-0}" \
    -e "DOCKER_SOCKET_GID=${DOCKER_SOCKET_GID:-0}" \
    -e "DUNE_SELF_UPDATE_BUILD_TIMEOUT_SECONDS=$(self_update_build_timeout_seconds)" \
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
  local backup_dir target remote timeout_seconds fetch_rc

  validate_release_tag_for_git "$tag" || {
    echo "Invalid release tag for Git checkout: $tag"
    exit 2
  }

  remote="$GITHUB_FETCH_REMOTE"
  echo "Updating stack Git checkout from:"
  echo "  $remote"
  echo "Fetching release tag: $tag"
  timeout_seconds="$(self_update_download_timeout_seconds)"
  self_update_running downloading 20 "Fetching console release $tag."
  set +e
  timeout --signal=TERM --kill-after=10 "${timeout_seconds}s" \
    env GIT_TERMINAL_PROMPT=0 git fetch --force --tags "$remote"
  fetch_rc=$?
  set -e
  if [ "$fetch_rc" -ne 0 ]; then
    if [ "$fetch_rc" -eq 124 ]; then
      self_update_finish_failure downloading 20 "Fetching console release $tag timed out after ${timeout_seconds} seconds. Check the server's connection to GitHub, then retry."
      echo "Git release download timed out after ${timeout_seconds} seconds." >&2
    else
      self_update_finish_failure downloading 20 "Fetching console release $tag failed. Check the server's connection to GitHub, then retry."
      echo "Git release download failed." >&2
    fi
    return "$fetch_rc"
  fi
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
  self_update_running installing 62 "Installing console release $tag."
  git reset --hard "$target"
  restore_local_state_after_install "$backup_dir"

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
  self_update_running installing 62 "Installing console release $tag."
  echo "Removing project-managed files from the current release..."
  remove_backed_up_project_files "$backup_dir"
  (
    cd "$src"
    tar --exclude='.git' -cf - .
  ) | (
    cd "$ROOT_DIR"
    tar -xf -
  )
  restore_local_state_after_install "$backup_dir"

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
  self_update_running installed 75 "Console release files were installed and verified."
}

cmd="${1:-check}"
tag="${2:-}"

case "$cmd" in
  rebuild-web-console)
    dune_persist_compose_project_name "$ROOT_DIR" "$DUNE_COMPOSE_PROJECT_NAME"
    service="${tag:-}"
    if [ -z "$service" ]; then
      service="$(web_console_service_name 2>/dev/null || true)"
    fi
    if [ -z "$service" ]; then
      echo "Dune Docker Console service was not found in docker-compose.web.yml."
      exit 2
    fi
    ensure_docker_access_for_console_rebuild
    rebuild_web_console_now "$service"
    echo "Dune Docker Console was rebuilt successfully."
    ;;

  check|status)
    set +e
    latest="$(latest_release_tag)"
    rc=$?
    set -e

    if [ "$rc" -ne 0 ] || [ -z "${latest:-}" ]; then
      echo "Current stack version: $CURRENT_VERSION"
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
    acquire_self_update_lock
    dune_persist_compose_project_name "$ROOT_DIR" "$DUNE_COMPOSE_PROJECT_NAME"
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
    fi

    cache_latest_release_tag "$tag"
    ensure_self_update_preflight
    install_release_tag "$tag"
    install_cli_command_after_update
    rebuild_web_console_after_update
    self_update_finish_success
    ;;

  install-qa)
    acquire_self_update_lock
    dune_persist_compose_project_name "$ROOT_DIR" "$DUNE_COMPOSE_PROJECT_NAME"
    validate_commit_sha "$tag" || {
      echo "A full 40-character QA commit SHA is required."
      exit 2
    }
    ensure_self_update_preflight
    install_qa_commit "$tag"
    install_cli_command_after_update
    rebuild_web_console_after_update
    self_update_finish_success
    ;;

  *)
    echo "Usage:"
    echo "  runtime/scripts/self-update.sh check"
    echo "  runtime/scripts/self-update.sh list"
    echo "  runtime/scripts/self-update.sh install [latest|<tag>]"
    echo "  runtime/scripts/self-update.sh install-qa <commit-sha>"
    exit 2
    ;;
esac

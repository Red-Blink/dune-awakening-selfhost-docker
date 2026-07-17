#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT_DIR="$(pwd)"

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

  latest_release_tag_from_releases_list
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
  # shellcheck disable=SC2016
  printf 'sudo chown -R "$USER:$USER" %q\n' "$HOST_ROOT_DIR"
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
    --exclude='./runtime/addons' \
    --exclude='./runtime/game' \
    --exclude='./runtime/logs' \
    --exclude='./runtime/text-router' \
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
  local manifest path relative target unsafe_path

  [ -s "$backup_dir/project-files.tgz" ] || return 0
  unsafe_path=""
  manifest="$(mktemp)"
  tar -tzf "$backup_dir/project-files.tgz" > "$manifest"

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
      rm -f "$target"
    fi
  done < "$manifest"

  rm -f "$manifest"
  if [ -n "$unsafe_path" ]; then
    echo "Refusing unsafe path from project backup: $unsafe_path"
    return 1
  fi
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
    runtime/generated/director-deepdesert-dual.ini \
    runtime/generated/ip-change-restart.env \
    runtime/generated/map-runtime-modes.json \
    runtime/generated/memory-balancer.json \
    runtime/generated/message-of-the-day.json \
    runtime/generated/message-of-the-day-state.json \
    runtime/generated/player-announcements.json \
    runtime/generated/player-announcements-state.json \
    runtime/generated/public-directory-status.json \
    runtime/generated/public-probe.env \
    runtime/generated/restart-schedule.env \
    runtime/generated/shutdown-protection.env \
    runtime/generated/sietch-config.json \
    runtime/generated/spicefield-overrides.json \
    runtime/generated/update-auto.env \
    runtime/generated/usersettings.json \
    runtime/generated/gameplay-profile.ini \
    runtime/generated/care-package.json \
    runtime/generated/care-package-grants.jsonl \
    runtime/generated/care-package-pending-returns.json \
    runtime/addons/state.json \
    runtime/secrets/funcom-token.txt \
    runtime/secrets/public-directory.json
  do
    [ -e "$path" ] || continue
    printf '%s\n' "$path" >> "$manifest"
  done

  if [ -s "$manifest" ]; then
    tar -czf "$backup_dir/local-state.tgz" -T "$manifest"
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
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/director-deepdesert-dual.ini
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/ip-change-restart.env
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/map-runtime-modes.json
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/memory-balancer.json
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/message-of-the-day.json
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/message-of-the-day-state.json
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/player-announcements.json
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/player-announcements-state.json
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/public-directory-status.json
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/public-probe.env
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/restart-schedule.env
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/shutdown-protection.env
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/sietch-config.json
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/spicefield-overrides.json
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/update-auto.env
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/usersettings.json
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/gameplay-profile.ini
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/care-package.json
  restore_local_state_file_if_needed "$backup_dir" runtime/generated/care-package-grants.jsonl
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
    runtime/generated/director-deepdesert-dual.ini \
    runtime/generated/ip-change-restart.env \
    runtime/generated/map-runtime-modes.json \
    runtime/generated/memory-balancer.json \
    runtime/generated/message-of-the-day.json \
    runtime/generated/message-of-the-day-state.json \
    runtime/generated/player-announcements.json \
    runtime/generated/player-announcements-state.json \
    runtime/generated/public-directory-status.json \
    runtime/generated/public-probe.env \
    runtime/generated/restart-schedule.env \
    runtime/generated/shutdown-protection.env \
    runtime/generated/sietch-config.json \
    runtime/generated/spicefield-overrides.json \
    runtime/generated/update-auto.env \
    runtime/generated/usersettings.json \
    runtime/generated/gameplay-profile.ini \
    runtime/generated/care-package.json \
    runtime/generated/care-package-grants.jsonl \
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
  prepare_web_console_rebuild_env
  COMPOSE_PROJECT_NAME="${DUNE_COMPOSE_PROJECT_NAME:-dune-awakening-selfhost-docker}" DUNE_HOST_REPO_ROOT="$HOST_ROOT_DIR" docker compose -f docker-compose.web.yml build "$service"
  docker rm -f "$service" >/dev/null 2>&1 || true
  COMPOSE_PROJECT_NAME="${DUNE_COMPOSE_PROJECT_NAME:-dune-awakening-selfhost-docker}" DUNE_HOST_REPO_ROOT="$HOST_ROOT_DIR" docker compose -f docker-compose.web.yml up -d --force-recreate "$service"
}

rebuild_web_console_with_helper() {
  local service="$1"
  local helper_name
  helper_name="dune-console-self-update-$(date +%s)"
  local compose_project="${DUNE_COMPOSE_PROJECT_NAME:-dune-awakening-selfhost-docker}"
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

  remote="$GITHUB_FETCH_REMOTE"
  echo "Updating stack Git checkout from:"
  echo "  $remote"
  echo "Fetching release tag: $tag"
  git fetch --force --tags "$remote"
  git fetch --force "$remote" "refs/tags/${tag}:refs/tags/${tag}" >/dev/null 2>&1 || true

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
    ;;

  *)
    echo "Usage:"
    echo "  runtime/scripts/self-update.sh check"
    echo "  runtime/scripts/self-update.sh list"
    echo "  runtime/scripts/self-update.sh install [latest|<tag>]"
    exit 2
    ;;
esac

#!/bin/sh

# Resolve the main Dune Compose project without silently changing the names of
# persistent volumes. This file is intentionally POSIX shell compatible because
# it is sourced by both install.sh and the Bash runtime helpers.

dune_compose_project_is_valid() {
  printf '%s' "${1:-}" | grep -Eq '^[a-z0-9][a-z0-9_-]*$'
}

dune_compose_normalize_project_name() {
  printf '%s' "${1:-}" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -e 's/[^a-z0-9_-]//g' -e 's/^[^a-z0-9]*//'
}

dune_compose_env_file_value() {
  dune_compose_env_file="$1"
  dune_compose_env_key="$2"
  [ -r "$dune_compose_env_file" ] || return 1
  awk -F= -v key="$dune_compose_env_key" '
    $1 == key {
      value = substr($0, length(key) + 2)
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      if ((substr(value, 1, 1) == "\"" && substr(value, length(value), 1) == "\"") ||
          (substr(value, 1, 1) == "\047" && substr(value, length(value), 1) == "\047")) {
        value = substr(value, 2, length(value) - 2)
      }
      print value
      exit
    }
  ' "$dune_compose_env_file"
}

dune_compose_container_label() {
  dune_compose_container="$1"
  command -v docker >/dev/null 2>&1 || return 1
  docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' \
    "$dune_compose_container" 2>/dev/null | head -n 1
}

dune_compose_service_projects() {
  dune_compose_service="$1"
  command -v docker >/dev/null 2>&1 || return 1

  docker ps -a \
    --filter "label=com.docker.compose.service=$dune_compose_service" \
    --filter "label=com.docker.compose.container-number" \
    --filter "label=com.docker.compose.oneoff=False" \
    --format '{{.ID}}' 2>/dev/null \
    | while IFS= read -r dune_compose_container_id; do
        [ -n "$dune_compose_container_id" ] || continue
        dune_compose_project="$(dune_compose_container_label "$dune_compose_container_id" 2>/dev/null || true)"
        dune_compose_project_is_valid "$dune_compose_project" \
          && printf '%s\n' "$dune_compose_project"
      done \
    | sort -u
}

dune_compose_running_service_container() {
  dune_compose_project="$1"
  dune_compose_service="$2"
  dune_compose_project_is_valid "$dune_compose_project" || return 1
  [ -n "$dune_compose_service" ] || return 1
  command -v docker >/dev/null 2>&1 || return 1

  dune_compose_containers="$(docker ps \
    --filter "label=com.docker.compose.project=$dune_compose_project" \
    --filter "label=com.docker.compose.service=$dune_compose_service" \
    --filter "label=com.docker.compose.container-number" \
    --filter "label=com.docker.compose.oneoff=False" \
    --format '{{.Names}}' 2>/dev/null || true)"
  [ "$(printf '%s\n' "$dune_compose_containers" | awk 'NF { count++ } END { print count + 0 }')" = "1" ] \
    || return 1
  printf '%s\n' "$dune_compose_containers" | awk 'NF { print; exit }'
}

dune_compose_console_main_project() {
  command -v docker >/dev/null 2>&1 || return 1
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
    redblink-dune-docker-console 2>/dev/null \
    | awk -F= '
        $1 == "DUNE_COMPOSE_PROJECT_NAME" || $1 == "COMPOSE_PROJECT_NAME" {
          print substr($0, length($1) + 2)
          exit
        }
      '
}

dune_compose_complete_volume_projects() {
  command -v docker >/dev/null 2>&1 || return 0
  docker volume ls --format '{{.Name}}' 2>/dev/null \
    | sed -n 's/_dune-server$//p' \
    | sort -u \
    | while IFS= read -r dune_compose_candidate; do
        [ -n "$dune_compose_candidate" ] || continue
        dune_compose_complete=1
        for dune_compose_suffix in dune-server dune-steam dune-cache dune-generated dune-work; do
          if ! docker volume inspect "${dune_compose_candidate}_${dune_compose_suffix}" >/dev/null 2>&1; then
            dune_compose_complete=0
            break
          fi
        done
        [ "$dune_compose_complete" = "1" ] && printf '%s\n' "$dune_compose_candidate"
      done
}

dune_resolve_compose_project_name() {
  dune_compose_root="${1:-$(pwd -P)}"
  dune_compose_value="${DUNE_COMPOSE_PROJECT_NAME:-}"

  if [ -n "$dune_compose_value" ]; then
    if ! dune_compose_project_is_valid "$dune_compose_value"; then
      echo "Invalid DUNE_COMPOSE_PROJECT_NAME=$dune_compose_value" >&2
      return 1
    fi
    printf '%s\n' "$dune_compose_value"
    return 0
  fi

  dune_compose_value="${COMPOSE_PROJECT_NAME:-}"
  if [ -n "$dune_compose_value" ]; then
    if ! dune_compose_project_is_valid "$dune_compose_value"; then
      echo "Invalid COMPOSE_PROJECT_NAME=$dune_compose_value" >&2
      return 1
    fi
    printf '%s\n' "$dune_compose_value"
    return 0
  fi

  dune_compose_value="$(dune_compose_env_file_value "$dune_compose_root/.env" DUNE_COMPOSE_PROJECT_NAME 2>/dev/null || true)"
  if [ -n "$dune_compose_value" ]; then
    if ! dune_compose_project_is_valid "$dune_compose_value"; then
      echo "Invalid DUNE_COMPOSE_PROJECT_NAME in $dune_compose_root/.env: $dune_compose_value" >&2
      return 1
    fi
    printf '%s\n' "$dune_compose_value"
    return 0
  fi

  dune_compose_value="$(dune_compose_env_file_value "$dune_compose_root/.env" COMPOSE_PROJECT_NAME 2>/dev/null || true)"
  if [ -n "$dune_compose_value" ]; then
    if ! dune_compose_project_is_valid "$dune_compose_value"; then
      echo "Invalid COMPOSE_PROJECT_NAME in $dune_compose_root/.env: $dune_compose_value" >&2
      return 1
    fi
    printf '%s\n' "$dune_compose_value"
    return 0
  fi

  dune_compose_candidates="$(dune_compose_complete_volume_projects 2>/dev/null || true)"
  dune_compose_candidate_count="$(printf '%s\n' "$dune_compose_candidates" | awk 'NF { count++ } END { print count + 0 }')"

  dune_compose_value="$(dune_compose_container_label dune-orchestrator 2>/dev/null || true)"
  if ! dune_compose_project_is_valid "$dune_compose_value"; then
    dune_compose_service_candidates="$(dune_compose_service_projects orchestrator 2>/dev/null || true)"
    dune_compose_service_candidate_count="$(printf '%s\n' "$dune_compose_service_candidates" | awk 'NF { count++ } END { print count + 0 }')"
    if [ "$dune_compose_service_candidate_count" = "1" ]; then
      dune_compose_value="$(printf '%s\n' "$dune_compose_service_candidates" | awk 'NF { print; exit }')"
    elif [ "$dune_compose_service_candidate_count" -gt 1 ]; then
      echo "Multiple Docker Compose projects contain an orchestrator service:" >&2
      printf '%s\n' "$dune_compose_service_candidates" | awk 'NF { print "  - " $0 }' >&2
      echo "Set DUNE_COMPOSE_PROJECT_NAME in .env to the project that owns the intended server before continuing." >&2
      return 2
    fi
  fi
  if ! dune_compose_project_is_valid "$dune_compose_value"; then
    dune_compose_value="$(dune_compose_console_main_project 2>/dev/null || true)"
  fi
  if dune_compose_project_is_valid "$dune_compose_value"; then
    if [ "$dune_compose_candidate_count" -le 1 ]; then
      printf '%s\n' "$dune_compose_value"
      return 0
    fi
    echo "The active containers report Compose project '$dune_compose_value', but multiple existing Dune volume sets were found:" >&2
    printf '%s\n' "$dune_compose_candidates" | awk 'NF { print "  - " $0 }' >&2
    echo "Set DUNE_COMPOSE_PROJECT_NAME in .env to the project that owns the intended server data before continuing." >&2
    return 2
  fi

  if [ "$dune_compose_candidate_count" = "1" ]; then
    dune_compose_value="$(printf '%s\n' "$dune_compose_candidates" | awk 'NF { print; exit }')"
    if dune_compose_project_is_valid "$dune_compose_value"; then
      printf '%s\n' "$dune_compose_value"
      return 0
    fi
  elif [ "$dune_compose_candidate_count" -gt 1 ]; then
    echo "Multiple existing Dune Compose volume sets were found:" >&2
    printf '%s\n' "$dune_compose_candidates" | awk 'NF { print "  - " $0 }' >&2
    echo "Set DUNE_COMPOSE_PROJECT_NAME to the project that owns the active server data before continuing." >&2
    return 2
  fi

  dune_compose_value="$(dune_compose_normalize_project_name "$(basename "$dune_compose_root")")"
  dune_compose_value="${dune_compose_value:-dune-awakening-selfhost-docker}"
  if ! dune_compose_project_is_valid "$dune_compose_value"; then
    echo "Could not derive a valid Compose project name from $dune_compose_root" >&2
    return 1
  fi
  printf '%s\n' "$dune_compose_value"
}

dune_persist_compose_project_name() {
  dune_compose_root="$1"
  dune_compose_value="$2"
  dune_compose_env_file="$dune_compose_root/.env"
  dune_compose_tmp_file=""
  dune_compose_env_existed=0
  dune_compose_current_dune=""
  dune_compose_current_compose=""

  dune_compose_project_is_valid "$dune_compose_value" || return 1

  if [ -f "$dune_compose_env_file" ]; then
    dune_compose_env_existed=1
    dune_compose_current_dune="$(dune_compose_env_file_value "$dune_compose_env_file" DUNE_COMPOSE_PROJECT_NAME 2>/dev/null || true)"
    dune_compose_current_compose="$(dune_compose_env_file_value "$dune_compose_env_file" COMPOSE_PROJECT_NAME 2>/dev/null || true)"
    if [ "$dune_compose_current_dune" = "$dune_compose_value" ] \
      && [ "$dune_compose_current_compose" = "$dune_compose_value" ]; then
      return 0
    fi
  else
    touch "$dune_compose_env_file" || return 1
  fi

  dune_compose_tmp_file="$(mktemp "${dune_compose_env_file}.tmp.XXXXXX")"
  if ! awk -v value="$dune_compose_value" '
    BEGIN { dune_found = 0; compose_found = 0 }
    /^DUNE_COMPOSE_PROJECT_NAME=/ {
      print "DUNE_COMPOSE_PROJECT_NAME=" value
      dune_found = 1
      next
    }
    /^COMPOSE_PROJECT_NAME=/ {
      print "COMPOSE_PROJECT_NAME=" value
      compose_found = 1
      next
    }
    { print }
    END {
      if (!dune_found) print "DUNE_COMPOSE_PROJECT_NAME=" value
      if (!compose_found) print "COMPOSE_PROJECT_NAME=" value
    }
  ' "$dune_compose_env_file" > "$dune_compose_tmp_file"; then
    rm -f "$dune_compose_tmp_file"
    return 1
  fi

  if [ "$dune_compose_env_existed" = "1" ]; then
    # Scheduled systemd helpers can run as root. Preserve both mode and
    # ownership before the atomic replacement so a root-created temporary file
    # cannot turn the operator's .env into root-owned state.
    # The GNU-coreutils "reference file" chmod/chown flag fails on BusyBox
    # (Alpine), so derive the mode/owner via `stat` instead.
    dune_compose_ref_mode="$(stat -c '%a' "$dune_compose_env_file" 2>/dev/null || true)"
    dune_compose_ref_owner="$(stat -c '%u:%g' "$dune_compose_env_file" 2>/dev/null || true)"
    if [ -z "$dune_compose_ref_mode" ] || [ -z "$dune_compose_ref_owner" ]; then
      rm -f "$dune_compose_tmp_file"
      return 1
    fi
    if ! chmod "$dune_compose_ref_mode" "$dune_compose_tmp_file" \
      || ! chown "$dune_compose_ref_owner" "$dune_compose_tmp_file"; then
      rm -f "$dune_compose_tmp_file"
      return 1
    fi
  fi

  if ! mv "$dune_compose_tmp_file" "$dune_compose_env_file"; then
    rm -f "$dune_compose_tmp_file"
    return 1
  fi
}

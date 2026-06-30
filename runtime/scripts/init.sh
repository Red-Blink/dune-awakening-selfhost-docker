#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

mkdir -p runtime/secrets runtime/generated

require_docker_prereqs() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is required but was not found in PATH."
    echo
    echo "Use this command to install Docker Engine and Docker Compose:"
    echo '  sudo apt-get update && sudo apt-get install -y ca-certificates curl && sudo install -m 0755 -d /etc/apt/keyrings && sudo curl -fsSL https://download.docker.com/linux/$(. /etc/os-release && echo "$ID")/gpg -o /etc/apt/keyrings/docker.asc && sudo chmod a+r /etc/apt/keyrings/docker.asc && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$(. /etc/os-release && echo "$ID") $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null && sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin && sudo systemctl enable --now docker && docker --version && docker compose version'
    echo
    echo "Then run:"
    echo "  dune init"
    exit 1
  fi

  if ! docker info >/dev/null 2>&1; then
    echo "Docker is installed, but the Docker daemon is not reachable."
    echo
    echo "Make sure Docker is running and that your user can access it."
    echo "Common fixes:"
    echo "  sudo systemctl enable --now docker"
    echo "  sudo usermod -aG docker \$USER"
    echo "  newgrp docker"
    exit 1
  fi
}

run_timed_step() {
  local label="$1"
  shift
  local start
  local end
  local elapsed

  start="$(date +%s)"
  echo
  echo "=== $label ==="
  "$@"
  end="$(date +%s)"
  elapsed=$((end - start))
  echo "Finished: $label (${elapsed}s)"
}

prompt_default() {
  local prompt="$1"
  local default="$2"
  local value
  read -r -p "$prompt [$default]: " value
  if [ -z "$value" ]; then
    value="$default"
  fi
  printf '%s' "$value"
}

detect_public_ip() {
  local ip=""

  if command -v curl >/dev/null 2>&1; then
    for url in \
      "https://api.ipify.org" \
      "https://ipv4.icanhazip.com" \
      "https://ifconfig.me/ip"
    do
      ip="$(curl -fsS4 --max-time 8 "$url" 2>/dev/null | tr -d '[:space:]' || true)"
      if printf '%s' "$ip" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
        printf '%s' "$ip"
        return 0
      fi
    done
  fi

  if command -v wget >/dev/null 2>&1; then
    for url in \
      "https://api.ipify.org" \
      "https://ipv4.icanhazip.com"
    do
      ip="$(wget -qO- -T 8 "$url" 2>/dev/null | tr -d '[:space:]' || true)"
      if printf '%s' "$ip" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
        printf '%s' "$ip"
        return 0
      fi
    done
  fi

  return 1
}

is_private_ipv4() {
  local ip="$1"
  printf '%s' "$ip" | grep -Eq '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)'
}

detect_lan_ip() {
  local ip=""

  if command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '
      {
        for (i = 1; i <= NF; i++) {
          if ($i == "src") {
            print $(i + 1)
            exit
          }
        }
      }
    ' | tr -d '[:space:]' || true)"

    if is_private_ipv4 "$ip"; then
      printf '%s' "$ip"
      return 0
    fi
  fi

  if command -v hostname >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)' | head -n1 || true)"

    if is_private_ipv4 "$ip"; then
      printf '%s' "$ip"
      return 0
    fi
  fi

  return 1
}

check_running_stack() {
  local running
  running="$(docker ps --filter "name=dune-" --format "{{.Names}}" | grep -v '^dune-orchestrator$' || true)"

  if [ -n "$running" ]; then
    echo "A Dune Docker stack appears to be running:"
    echo "$running" | sed 's/^/  /'
    echo
    echo "Running init can overwrite local config and restart services."
    read -r -p "Continue anyway? [y/N]: " answer
    case "$answer" in
      y|Y|yes|YES) ;;
      *) echo "Init cancelled."; exit 1 ;;
    esac
  fi
}

confirm_overwrite() {
  if [ -f .env ] || [ -f runtime/generated/battlegroup.env ] || [ -f runtime/secrets/funcom-token.txt ]; then
    echo "Existing local configuration was found:"
    [ -f .env ] && echo "  .env"
    [ -f runtime/generated/battlegroup.env ] && echo "  runtime/generated/battlegroup.env"
    [ -f runtime/secrets/funcom-token.txt ] && echo "  runtime/secrets/funcom-token.txt"
    echo
    read -r -p "Overwrite local init config? [y/N]: " answer
    case "$answer" in
      y|Y|yes|YES) ;;
      *) echo "Init cancelled."; exit 1 ;;
    esac
  fi
}

fresh_reset_runtime() {
  echo
  echo "Preparing fresh runtime state..."

  mkdir -p runtime/backups runtime/generated

  local backup_dir
  backup_dir="runtime/backups/init-reset-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$backup_dir"

  echo "Backing up existing local config/state to:"
  echo "  $backup_dir"

  [ -f .env ] && cp -a .env "$backup_dir/.env"
  [ -f runtime/generated/battlegroup.env ] && cp -a runtime/generated/battlegroup.env "$backup_dir/battlegroup.env"
  [ -f runtime/secrets/funcom-token.txt ] && cp -a runtime/secrets/funcom-token.txt "$backup_dir/funcom-token.txt"

  echo "$backup_dir" > runtime/generated/last-init-backup.txt

  echo
  echo "Stopping existing Dune stack..."
  runtime/scripts/stop-all.sh || true

  echo
  echo "Resetting Postgres volume for fresh init..."

  if docker volume inspect dune-postgres-data >/dev/null 2>&1; then
    local volume_mount
    volume_mount="$(docker volume inspect -f '{{ .Mountpoint }}' dune-postgres-data 2>/dev/null || true)"

    if [ -n "$volume_mount" ] && [ -d "$volume_mount" ]; then
      echo "Backing up existing Postgres volume..."
      tar -czf "$backup_dir/dune-postgres-data.tgz" -C "$volume_mount" .
      echo "Postgres volume backup:"
      echo "  $backup_dir/dune-postgres-data.tgz"
    else
      echo "Could not find Postgres volume mountpoint; skipping volume tar backup."
    fi

    docker volume rm dune-postgres-data >/dev/null
    echo "Removed old Postgres volume: dune-postgres-data"
  else
    echo "No existing Postgres volume found."
  fi
}

preserve_env_extras() {
  local source_file="$1"
  [ -f "$source_file" ] || return 0
  awk -F= '
    /^[[:space:]]*($|#)/ { next }
    $1 == "SERVER_IP" { next }
    $1 == "SERVER_IP_MODE" { next }
    $1 == "SERVER_TITLE" { next }
    $1 == "SERVER_REGION" { next }
    $1 == "STEAM_APP_ID" { next }
    $1 == "BATTLEGROUP_ID" { next }
    { print }
  ' "$source_file"
}


derive_battlegroup_id() {
  TOKEN="$1" python3 - <<'PY'
import base64
import json
import os
import random
import string
import sys

token = os.environ["TOKEN"].strip()
parts = token.split(".")
if len(parts) < 2:
    print("Token does not look like a JWT.", file=sys.stderr)
    sys.exit(1)

payload = parts[1] + "=" * (-len(parts[1]) % 4)

try:
    data = json.loads(base64.urlsafe_b64decode(payload.encode()).decode())
except Exception as exc:
    print(f"Could not decode token payload: {exc}", file=sys.stderr)
    sys.exit(1)

host_id = data.get("HostId") or data.get("hostId") or data.get("host_id")
if not host_id:
    print("Token payload does not contain HostId.", file=sys.stderr)
    sys.exit(1)

host_id = str(host_id).lower()
suffix = "".join(random.choice(string.ascii_lowercase) for _ in range(6))

print(f"sh-{host_id}-{suffix}")
PY
}

echo "=== Dune Awakening Docker first-time init ==="
echo
echo "This will create local config, save your Funcom token locally, generate a battlegroup ID,"
echo "download/load server assets, run DB setup/update, and start the Docker stack."
echo
echo "Important: dune init creates a fresh local world and resets the local Postgres database."
echo "Existing local config/state is backed up first, but players should treat this as a reset."
echo

require_docker_prereqs
if [ "${DUNE_INIT_ASSUME_YES:-0}" = "1" ]; then
  echo "Using saved Web UI setup values."

  if [ ! -f .env ]; then
    echo "Saved server settings were not found. Open the Web UI setup wizard and complete Server Identity first."
    exit 1
  fi

  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a

  SERVER_TITLE="${SERVER_TITLE:-My Dune Server}"
  SERVER_REGION="${SERVER_REGION:-Europe}"
  SERVER_IP="${SERVER_IP:-auto}"
  SERVER_IP_MODE="${SERVER_IP_MODE:-public}"
  STEAM_APP_ID="${STEAM_APP_ID:-4754530}"

  if [ ! -f runtime/secrets/funcom-token.txt ]; then
    echo "Funcom token was not found. Open the Web UI setup wizard and paste your token before deploying."
    exit 1
  fi

  FUNCOM_TOKEN="$(tr -d '\r\n' < runtime/secrets/funcom-token.txt)"
  if [ -z "$FUNCOM_TOKEN" ]; then
    echo "Funcom token is empty. Open the Web UI setup wizard and save the token again."
    exit 1
  fi

  if [ -r runtime/generated/battlegroup.env ]; then
    set -a
    # shellcheck disable=SC1091
    . runtime/generated/battlegroup.env
    set +a
  fi

  if [ -z "${BATTLEGROUP_ID:-}" ]; then
    echo
    echo "Generating battlegroup ID using Funcom's world name format..."
    BATTLEGROUP_ID="$(derive_battlegroup_id "$FUNCOM_TOKEN")"
  fi
else
  check_running_stack
  confirm_overwrite

  SERVER_TITLE="$(prompt_default "Server title" "My Dune Server")"

  echo
  echo "Select server region:"
  echo "  1) Asia"
  echo "  2) Europe"
  echo "  3) North America"
  echo "  4) Oceania"
  echo "  5) South America"

  SERVER_REGION=""
  while [ -z "$SERVER_REGION" ]; do
    read -r -p "Choice [1-5]: " region_choice
    case "$region_choice" in
      1) SERVER_REGION="Asia" ;;
      2) SERVER_REGION="Europe" ;;
      3) SERVER_REGION="North America" ;;
      4) SERVER_REGION="Oceania" ;;
      5) SERVER_REGION="South America" ;;
      *) echo "Invalid choice. Pick 1, 2, 3, 4, or 5." ;;
    esac
  done

  echo
  echo "Detecting player-facing IP addresses..."
  PUBLIC_IP="$(detect_public_ip || true)"
  LAN_IP="$(detect_lan_ip || true)"

  echo
  echo "How will players connect to this server?"
  echo "  1) Public / internet server"
  echo "     Use this for VPS, dedicated servers, or home servers with port forwarding."
  echo "     Detected public IP: ${PUBLIC_IP:-not detected}"
  echo
  echo "  2) Local / LAN server"
  echo "     Use this for players on the same local network only."
  echo "     Detected local IP:  ${LAN_IP:-not detected}"
  echo

  SERVER_IP=""
  while [ -z "$SERVER_IP" ]; do
    read -r -p "Choice [1/2]: " ip_choice

    case "$ip_choice" in
      1)
        if [ -z "$PUBLIC_IP" ]; then
          echo "Public IP was not detected. Check internet access and try again."
          exit 1
        fi
        SERVER_IP="$PUBLIC_IP"
        SERVER_IP_MODE="public"
        ;;
      2)
        if [ -z "$LAN_IP" ]; then
          echo "Local/LAN IP was not detected. Check the host network and try again."
          exit 1
        fi
        SERVER_IP="$LAN_IP"
        SERVER_IP_MODE="local"
        ;;
      *)
        echo "Invalid choice. Pick 1 for public or 2 for local/LAN."
        ;;
    esac
  done

  echo "Selected player-facing IP: $SERVER_IP ($SERVER_IP_MODE)"

  # Funcom self-host server Steam app id. This is selected automatically, not prompted.
  STEAM_APP_ID="${STEAM_APP_ID:-4754530}"
  echo "Steam app id: $STEAM_APP_ID"

  echo
  echo "Paste your Funcom self-host service token."
  echo "Input is hidden. Press Enter after pasting."
  read -r -s -p "Funcom token: " FUNCOM_TOKEN
  echo

  if [ -z "$FUNCOM_TOKEN" ]; then
    echo "Token cannot be empty."
    exit 1
  fi

  echo
  echo "Generating battlegroup ID using Funcom's world name format..."
  BATTLEGROUP_ID="$(derive_battlegroup_id "$FUNCOM_TOKEN")"
fi

echo
echo "=== Setup summary ==="
echo "Server title: $SERVER_TITLE"
echo "Region:       $SERVER_REGION"
echo "Hosting mode: $SERVER_IP_MODE"
echo "Server IP:    $SERVER_IP"
echo "Steam app id: $STEAM_APP_ID"
echo "Battlegroup:  $BATTLEGROUP_ID"
if [ "$SERVER_IP_MODE" = "public" ]; then
  cat <<'EOF'

Public hosting reminder:
  Open or forward TCP 31982.
  Open or forward UDP 7777-7810.
EOF
fi
echo
echo "This will now stop existing local Dune services, reset the local database volume,"
echo "download/load assets if needed, apply world partitions, and start a fresh stack."
if [ "${DUNE_INIT_ASSUME_YES:-0}" = "1" ]; then
  echo "Web setup approved deployment. Continuing without terminal prompts."
else
  read -r -p "Create this fresh local world now? [y/N]: " final_answer
  case "$final_answer" in
    y|Y|yes|YES) ;;
    *) echo "Init cancelled."; exit 1 ;;
  esac
fi

preserved_env="$(mktemp)"
preserve_env_extras .env > "$preserved_env" || true

fresh_reset_runtime

cat > .env <<EOF
SERVER_IP=$SERVER_IP
SERVER_IP_MODE=$SERVER_IP_MODE
SERVER_TITLE="$SERVER_TITLE"
SERVER_REGION="$SERVER_REGION"
STEAM_APP_ID=$STEAM_APP_ID
EOF
if [ -s "$preserved_env" ]; then
  {
    echo
    cat "$preserved_env"
  } >> .env
fi
rm -f "$preserved_env"

cat > runtime/generated/battlegroup.env <<EOF
BATTLEGROUP_ID=$BATTLEGROUP_ID
EOF

printf '%s' "$FUNCOM_TOKEN" > runtime/secrets/funcom-token.txt

chmod 644 .env
chmod 664 runtime/generated/battlegroup.env
chmod 600 runtime/secrets/funcom-token.txt

export SERVER_IP SERVER_IP_MODE SERVER_TITLE SERVER_REGION STEAM_APP_ID BATTLEGROUP_ID

echo
echo "Wrote local config:"
echo "  .env"
echo "  runtime/generated/battlegroup.env"
echo "  runtime/secrets/funcom-token.txt"
echo
echo "Generated battlegroup ID:"
echo "  $BATTLEGROUP_ID"

echo
echo "Starting orchestrator container..."
docker compose up -d --build orchestrator

run_timed_step "Downloading/loading assets and running database setup/update" runtime/scripts/update.sh install

DUNE_START_SKIP_POSTGRES_START=1 DUNE_START_SKIP_DB_UPDATE=1 run_timed_step "Starting Dune stack" runtime/scripts/start-all.sh

echo
echo "Init complete."
echo "Survival_1 can take several minutes to become READY."
echo "After local READY, the in-game server browser may still take a few minutes"
echo "to show population and sietch availability."
echo
runtime/scripts/ready.sh || true

cat <<EOF

Next commands:
  Open Dune Docker Console in your browser for guided management.
  Run dune --help for CLI commands.
EOF

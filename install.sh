#!/bin/sh
set -eu

cd "$(dirname "$0")"

reject_root_install() {
  if [ "$(id -u)" -ne 0 ]; then
    return
  fi

  printf '\n%s\n\n' "This project must not be installed as root."

  if [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ]; then
    echo "The installer was started with sudo. Return to the ${SUDO_USER} account and run:"
    printf '\n  ./install.sh\n\n'
    echo "Do not put sudo before the installation command. The installer requests administrator access only when required."
    exit 1
  fi

  if [ -f /etc/debian_version ]; then
    echo "Create a regular user with sudo access by running:"
    cat <<'EOF'

  apt-get update
  apt-get install -y sudo
  adduser dune
  usermod -aG sudo dune
  su - dune

Then run the installation command again as the new "dune" user.
Do not put sudo before the installation command.
EOF
  else
    cat <<'EOF'
Create or use a regular user with administrator access, log in as that user,
and run the installation command again without putting sudo before it.
EOF
  fi
  exit 1
}

reject_root_install

. runtime/scripts/compose-project.sh

APP_NAME="Dune Docker Console"
WEB_COMPOSE="docker-compose.web.yml"
WEB_SERVICE="redblink-dune-docker-console"
WEB_PORT="${ADMIN_BIND_PORT:-8088}"
DOCKER_CMD="docker"
DOCKER_NEEDS_SUDO=0
DOCKER_GROUP_UPDATED=0

say() {
  printf '\n%s\n' "$1"
}

step() {
  printf '\n==> %s\n' "$1"
}

need_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "This installer needs administrator access for this step, but sudo was not found."
    echo "Please run this installer as root or install sudo, then start it again."
    exit 1
  fi
}

is_linux() {
  [ "$(uname -s 2>/dev/null || true)" = "Linux" ]
}

has_systemd() {
  command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]
}

has_openrc() {
  command -v rc-update >/dev/null 2>&1 && command -v rc-service >/dev/null 2>&1
}

install_basic_tools() {
  # gnupg/gnupg2/gpg2 (package name varies by distro) is required by
  # `dune db backup-system`'s authenticated (AEAD/OCB) archive encryption
  # -- openssl's own `enc` CLI cannot do any AEAD cipher at all (confirmed
  # directly: `openssl enc -aes-256-gcm` -> "AEAD ciphers not supported",
  # a permanent CLI-level policy, not a version gap).
  if command -v apt-get >/dev/null 2>&1; then
    need_sudo apt-get update
    need_sudo apt-get install -y ca-certificates curl bash tar openssl python3 gnupg
  elif command -v dnf >/dev/null 2>&1; then
    need_sudo dnf install -y ca-certificates curl bash tar openssl python3 gnupg2
  elif command -v yum >/dev/null 2>&1; then
    need_sudo yum install -y ca-certificates curl bash tar openssl python3 gnupg2
  elif command -v zypper >/dev/null 2>&1; then
    need_sudo zypper --non-interactive install ca-certificates curl bash tar openssl python3 gpg2
  elif command -v pacman >/dev/null 2>&1; then
    need_sudo pacman -Sy --noconfirm ca-certificates curl bash tar openssl python gnupg
  elif command -v apk >/dev/null 2>&1; then
    need_sudo apk add --no-cache ca-certificates curl bash tar openssl python3 gnupg
  elif command -v xbps-install >/dev/null 2>&1; then
    need_sudo xbps-install -Sy ca-certificates curl bash tar openssl python3 gnupg2
  else
    echo "This installer could not detect a supported package manager." >&2
    echo "Install curl, bash, tar, openssl, python3, and gnupg (gpg), then run it again." >&2
    exit 1
  fi
}

ensure_basic_tools() {
  if command -v curl >/dev/null 2>&1 \
    && command -v bash >/dev/null 2>&1 \
    && command -v tar >/dev/null 2>&1 \
    && command -v openssl >/dev/null 2>&1 \
    && command -v gpg >/dev/null 2>&1 \
    && { command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1; }; then
    return
  fi
  install_basic_tools

  missing_tools=""
  for required_tool in curl bash tar openssl gpg; do
    if ! command -v "$required_tool" >/dev/null 2>&1; then
      missing_tools="${missing_tools}${missing_tools:+, }${required_tool}"
    fi
  done
  if ! command -v python3 >/dev/null 2>&1 && ! command -v python >/dev/null 2>&1; then
    missing_tools="${missing_tools}${missing_tools:+, }python3"
  fi
  if [ -n "$missing_tools" ]; then
    echo "Required tools are still missing after package installation: $missing_tools" >&2
    echo "Install them manually, then run this installer again." >&2
    exit 1
  fi
}

install_docker() {
  if command -v docker >/dev/null 2>&1; then
    return
  fi

  step "Docker is missing. Installing Pre-requisites for Docker now."

  if command -v apk >/dev/null 2>&1; then
    step "Installing Docker from the Alpine community repository."
    install_docker_alpine
    return
  fi

  if ! command -v curl >/dev/null 2>&1; then
    echo "Docker is missing and curl is not available, so the installer cannot continue automatically."
    echo "Install Docker Engine or Docker Desktop, then run this installer again."
    exit 1
  fi

  step "Installing Docker now."

  get_docker_script="${TMPDIR:-/tmp}/dune-get-docker-$$.sh"
  trap 'rm -f "$get_docker_script"' 0

  if ! curl -fsSL https://get.docker.com -o "$get_docker_script"; then
    echo "Could not download the Docker install script from get.docker.com." >&2
    exit 1
  fi

  # Keep the upstream installer's package and service progress visible. Hiding
  # it makes a normal Docker installation look stalled after the sudo prompt.
  if ! need_sudo sh "$get_docker_script"; then
    echo "Docker installation failed. Review the installer output above for the cause." >&2
    exit 1
  fi
}

install_docker_alpine() {
  alpine_repos_file="/etc/apk/repositories"
  alpine_community_repository=""

  if grep -qE '^[[:space:]]*#.*\/community([[:space:]]*)$' "$alpine_repos_file"; then
    echo "The Alpine community repository is currently disabled in $alpine_repos_file."
    printf "Allow this installer to enable it for Docker installation? [y/N] "
    response=""
    read -r response || true
    if echo "$response" | grep -qi "^y"; then
      need_sudo sed -i 's|^[[:space:]]*#[[:space:]]*\(.*\/community\)[[:space:]]*$|\1|' "$alpine_repos_file"
    else
      echo "Cannot install Docker without the community repository. Aborting."
      exit 1
    fi
  elif ! grep -qE '^[[:space:]]*[^#].*\/community([[:space:]]*)$' "$alpine_repos_file"; then
    alpine_community_repository="$(awk '/^[[:space:]]*[^#].*\/main[[:space:]]*$/ { sub(/\/main[[:space:]]*$/, "/community"); print; exit }' "$alpine_repos_file")"
    if [ -z "$alpine_community_repository" ]; then
      echo "Could not derive an Alpine community repository from $alpine_repos_file." >&2
      echo "Enable the community repository manually, then run this installer again." >&2
      exit 1
    fi
    echo "The Alpine community repository is missing from $alpine_repos_file."
    printf "Allow this installer to add %s for Docker installation? [y/N] " "$alpine_community_repository"
    response=""
    read -r response || true
    if echo "$response" | grep -qi "^y"; then
      printf '%s\n' "$alpine_community_repository" | need_sudo tee -a "$alpine_repos_file" >/dev/null
    else
      echo "Cannot install Docker without the community repository. Aborting."
      exit 1
    fi
  fi

  need_sudo apk add --no-cache docker
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker was not available after Alpine package installation." >&2
    exit 1
  fi
}

select_docker_command() {
  if docker info >/dev/null 2>&1; then
    DOCKER_CMD="docker"
    DOCKER_NEEDS_SUDO=0
    return 0
  fi
  if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    DOCKER_CMD="sudo docker"
    DOCKER_NEEDS_SUDO=1
    return 0
  fi
  if [ "$(id -u)" -eq 0 ] && docker info >/dev/null 2>&1; then
    DOCKER_CMD="docker"
    DOCKER_NEEDS_SUDO=0
    return 0
  fi
  return 1
}

start_docker() {
  if select_docker_command; then
    return
  fi

  step "Docker is installed but is not running yet. Starting Docker now."

  if has_systemd; then
    need_sudo systemctl enable --now docker || true
  elif has_openrc; then
    need_sudo rc-update add docker default || true
    need_sudo rc-service docker start || true
  elif command -v service >/dev/null 2>&1; then
    need_sudo service docker start || true
  fi

  if select_docker_command; then
    return
  fi

  if [ "$(id -u)" -ne 0 ] && getent group docker >/dev/null 2>&1; then
    step "Giving your user access to Docker."
    need_sudo usermod -aG docker "$USER" || true
    if select_docker_command; then
      echo "Docker is ready. Setup can continue."
      return
    fi
  fi

  echo "Docker is installed, but this installer still cannot reach the Docker engine."
  echo "If you use Docker Desktop, start Docker Desktop and wait until it says it is running."
  echo "Then run this installer again."
  exit 1
}

set_docker_group_access() {
  docker_group_target_user="$1"

  if ! getent group docker >/dev/null 2>&1; then
    echo "Docker group does not exist yet — Is Docker installed?"
    return
  fi

  if command -v usermod >/dev/null 2>&1; then
    need_sudo usermod -aG docker "$docker_group_target_user"
  elif command -v addgroup >/dev/null 2>&1; then
    need_sudo addgroup "$docker_group_target_user" docker
  else
    echo "Cannot add user $docker_group_target_user to the docker group automatically."
    echo "Please manually add your user to the docker group and log out and back in."
  fi
}

ensure_docker_group_access() {
  docker_group_user="${SUDO_USER:-${USER:-}}"
  step "Checking if User: $docker_group_user is in the docker group."
  if [ -z "$docker_group_user" ] || [ "$docker_group_user" = "root" ]; then
    return
  fi
  if ! getent group docker >/dev/null 2>&1; then
    echo "Docker group does not exist yet — Is Docker installed?"
    return
  fi
  if id -nG "$docker_group_user" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
    echo "User $docker_group_user is already in the docker group."
    return
  fi

  echo "$docker_group_user is not in the docker group."
  set_docker_group_access "$docker_group_user"
  echo "User $docker_group_user has been added to the docker group. Log out and back in for this change to take effect."

  DOCKER_GROUP_UPDATED=1
}

ensure_compose() {
  if $DOCKER_CMD compose version >/dev/null 2>&1; then
    return
  fi

  step "Docker Compose is missing. Installing the Compose plugin now."

  if command -v apt-get >/dev/null 2>&1; then
    need_sudo apt-get update
    need_sudo apt-get install -y docker-compose-plugin
  elif command -v dnf >/dev/null 2>&1; then
    need_sudo dnf install -y docker-compose-plugin
  elif command -v yum >/dev/null 2>&1; then
    need_sudo yum install -y docker-compose-plugin
  elif command -v apk >/dev/null 2>&1; then
    need_sudo apk add --no-cache docker-compose
  else
    echo "Docker Compose is missing and this operating system is not supported for automatic Compose installation."
    echo "Install the Docker Compose v2 plugin or use Docker Desktop, then run this installer again."
    exit 1
  fi

  if ! $DOCKER_CMD compose version >/dev/null 2>&1; then
    echo "Docker Compose is still not available after installation."
    echo "Restart your shell or Docker Desktop, then run this installer again."
    exit 1
  fi
}

install_cli_command() {
  if [ ! -x runtime/scripts/install-command.sh ]; then
    return
  fi

  step "Installing the dune command."
  need_sudo runtime/scripts/install-command.sh
}

host_ip() {
  host_address=""
  if command -v ip >/dev/null 2>&1; then
    host_address="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i=1; i<=NF; i++) if ($i == "src") { print $(i + 1); exit } }' || true)"
  fi
  if [ -z "$host_address" ] && command -v hostname >/dev/null 2>&1; then
    host_address="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -Ev '^(127\.|169\.254\.|172\.17\.|172\.18\.|172\.19\.|172\.2[0-9]\.|172\.3[0-1]\.)' | head -n1 || true)"
  fi
  printf '%s' "${host_address:-127.0.0.1}"
}

public_ip() {
  public_address=""
  if command -v curl >/dev/null 2>&1; then
    public_address="$(curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null | tr -d '[:space:]' || true)"
    if printf '%s' "$public_address" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
      printf '%s' "$public_address"
      return
    fi
  fi
}

is_valid_port() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

port_in_use() {
  checked_port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn "sport = :$checked_port" 2>/dev/null | tail -n +2 | grep -q .
    return
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "(^|:)${checked_port}$"
    return
  fi
  return 1
}

next_available_port() {
  candidate_port="${1:-8088}"
  while [ "$candidate_port" -le 65535 ]; do
    if ! port_in_use "$candidate_port"; then
      printf '%s' "$candidate_port"
      return
    fi
    candidate_port=$((candidate_port + 1))
  done
  return 1
}

existing_web_port() {
  if [ -f .env ]; then
    awk -F= '/^ADMIN_BIND_PORT=/ {print $2; exit}' .env | sed "s/[[:space:]\"']//g"
  fi
}

existing_console_uses_port() {
  checked_port="$1"
  container_port=""

  if ! $DOCKER_CMD inspect -f '{{.State.Running}}' redblink-dune-docker-console 2>/dev/null | grep -qx true; then
    return 1
  fi
  container_port="$($DOCKER_CMD inspect -f '{{range .Config.Env}}{{println .}}{{end}}' redblink-dune-docker-console 2>/dev/null \
    | awk -F= '$1 == "ADMIN_BIND_PORT" { print $2; exit }' || true)"
  [ "$container_port" = "$checked_port" ]
}

default_host_uid() {
  printf '%s' "${SUDO_UID:-$(id -u)}"
}

default_host_gid() {
  printf '%s' "${SUDO_GID:-$(id -g)}"
}

persist_env_value() {
  env_key="$1"
  env_value="$2"
  env_target_file="${3:-.env}"

  touch "$env_target_file"
  env_escaped_value="$(printf '%s' "$env_value" | sed 's/[&|]/\\&/g')"

  if grep -q "^${env_key}=" "$env_target_file"; then
    sed -i "s|^${env_key}=.*|${env_key}=${env_escaped_value}|" "$env_target_file"
  else
    printf '%s=%s\n' "$env_key" "$env_value" >> "$env_target_file"
  fi
}

persist_web_port() {
  persist_env_value "ADMIN_BIND_PORT" "$WEB_PORT"
}

prepare_docker_socket_gid() {
  if [ -z "${DOCKER_SOCKET_GID:-}" ] && [ -S /var/run/docker.sock ] && command -v stat >/dev/null 2>&1; then
    DOCKER_SOCKET_GID="$(stat -c '%g' /var/run/docker.sock 2>/dev/null || true)"
  fi
  export DOCKER_SOCKET_GID="${DOCKER_SOCKET_GID:-0}"
}

persist_console_runtime_env() {
  persist_env_value "DUNE_HOST_REPO_ROOT" "$DUNE_HOST_REPO_ROOT"
  persist_env_value "DUNE_HOST_UID" "$DUNE_HOST_UID"
  persist_env_value "DUNE_HOST_GID" "$DUNE_HOST_GID"
  persist_env_value "DOCKER_SOCKET_GID" "$DOCKER_SOCKET_GID"
}

migrate_existing_ownership() {
  ownership_repo_root="${DUNE_HOST_REPO_ROOT:-$(pwd -P)}"
  ownership_target_uid="${DUNE_HOST_UID:-$(default_host_uid)}"
  ownership_target_gid="${DUNE_HOST_GID:-$(default_host_gid)}"
  ownership_env_file="${ownership_repo_root}/.env"

  if [ "$ownership_target_uid" = "0" ]; then
    return
  fi

  if [ ! -d "$ownership_repo_root" ]; then
    return
  fi

  if ! command -v find >/dev/null 2>&1; then
    return
  fi

  if ! find "$ownership_repo_root" -xdev \( -user root -o -group root \) -print -quit 2>/dev/null | grep -q .; then
    return
  fi

  if [ -f "$ownership_env_file" ]; then
    echo "[install] Existing install detected with root-owned files."
    echo "[install] Changing ownership to match current user (${ownership_target_uid}:${ownership_target_gid})..."
  else
    echo "[install] Root-owned files found in repo. Changing ownership to match current user..."
  fi

  need_sudo chown -R "${ownership_target_uid}:${ownership_target_gid}" "$ownership_repo_root" 2>/dev/null || {
    echo "[install] WARNING: Could not chown all files in ${ownership_repo_root}."
    echo "[install] The web container may not be able to write repo files."
  }
}

choose_web_port() {
  chosen_port=""
  port_prompt=""
  persisted_web_port="$(existing_web_port)"
  default_web_port="${ADMIN_BIND_PORT:-$persisted_web_port}"
  default_web_port="${default_web_port:-8088}"
  if ! is_valid_port "$default_web_port"; then
    default_web_port="8088"
  fi

  if [ -n "${ADMIN_BIND_PORT:-}" ]; then
    if ! is_valid_port "$ADMIN_BIND_PORT"; then
      echo "ADMIN_BIND_PORT must be a number between 1 and 65535."
      exit 1
    fi
    WEB_PORT="$ADMIN_BIND_PORT"
    persist_web_port
    return
  fi

  if is_valid_port "$persisted_web_port" && existing_console_uses_port "$persisted_web_port"; then
    WEB_PORT="$persisted_web_port"
    persist_web_port
    echo "Existing Dune Docker Console detected. Reusing Web UI port $WEB_PORT."
    return
  fi

  step "Choosing the Web UI port."
  if port_in_use "$default_web_port"; then
    echo "Port $default_web_port is already in use."
    port_prompt="Enter another port for the Web UI: "
  else
    port_prompt="Enter the Web UI port, or press Enter to use $default_web_port: "
  fi

  while true; do
    if [ -t 0 ]; then
      printf '%s' "$port_prompt"
      read -r chosen_port
    else
      chosen_port="$(next_available_port "$default_web_port" || true)"
      if [ -z "$chosen_port" ]; then
        echo "No available Web UI port was found."
        exit 1
      fi
      if [ "$chosen_port" != "$default_web_port" ]; then
        echo "Port $default_web_port is already in use. Using available port $chosen_port."
      fi
    fi
    chosen_port="${chosen_port:-$default_web_port}"
    if ! is_valid_port "$chosen_port"; then
      echo "Enter a number between 1 and 65535."
      continue
    fi
    if port_in_use "$chosen_port"; then
      echo "Port $chosen_port is already in use. Choose another port."
      port_prompt="Enter another port for the Web UI: "
      continue
    fi
    WEB_PORT="$chosen_port"
    persist_web_port
    echo "Web UI port set to $WEB_PORT."
    return
  done
}

start_console() {
  if [ ! -f "$WEB_COMPOSE" ]; then
    echo "The installer cannot find $WEB_COMPOSE."
    echo "Run this installer from the extracted release folder."
    exit 1
  fi

  step "Starting the Web UI."
  export ADMIN_BIND_PORT="$WEB_PORT"
  export DUNE_HOST_REPO_ROOT="${DUNE_HOST_REPO_ROOT:-$(pwd -P)}"
  export DUNE_HOST_UID="${DUNE_HOST_UID:-$(default_host_uid)}"
  export DUNE_HOST_GID="${DUNE_HOST_GID:-$(default_host_gid)}"
  DUNE_COMPOSE_PROJECT_NAME="$(dune_resolve_compose_project_name "$(pwd -P)")"
  export DUNE_COMPOSE_PROJECT_NAME
  export COMPOSE_PROJECT_NAME="${DUNE_WEB_COMPOSE_PROJECT_NAME:-dune-awakening-selfhost-docker}"
  prepare_docker_socket_gid
  migrate_existing_ownership
  dune_persist_compose_project_name "$(pwd -P)" "$DUNE_COMPOSE_PROJECT_NAME"
  persist_console_runtime_env
  if [ "$DOCKER_NEEDS_SUDO" = "1" ]; then
    need_sudo env \
      "ADMIN_BIND_PORT=$ADMIN_BIND_PORT" \
      "DUNE_HOST_REPO_ROOT=$DUNE_HOST_REPO_ROOT" \
      "DUNE_HOST_UID=$DUNE_HOST_UID" \
      "DUNE_HOST_GID=$DUNE_HOST_GID" \
      "DOCKER_SOCKET_GID=$DOCKER_SOCKET_GID" \
      "COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME" \
      "DUNE_COMPOSE_PROJECT_NAME=$DUNE_COMPOSE_PROJECT_NAME" \
      docker compose -f "$WEB_COMPOSE" up -d --build "$WEB_SERVICE"
  else
    $DOCKER_CMD compose -f "$WEB_COMPOSE" up -d --build "$WEB_SERVICE"
  fi
}

read_admin_password() {
  admin_password_file="$1"
  password_attempt=1
  while [ "$password_attempt" -le 20 ]; do
    if [ -r "$admin_password_file" ] && [ -s "$admin_password_file" ]; then
      tr -d '\r\n' < "$admin_password_file"
      return
    fi
    if command -v sudo >/dev/null 2>&1 && sudo test -s "$admin_password_file" 2>/dev/null; then
      sudo cat "$admin_password_file" | tr -d '\r\n'
      return
    fi
    sleep 1
    password_attempt=$((password_attempt + 1))
  done
}

show_finish() {
  finish_host_ip="$(host_ip)"
  finish_public_ip="$(public_ip)"
  finish_password_file="$(pwd)/runtime/secrets/admin-web-password.txt"
  finish_admin_password="$(read_admin_password "$finish_password_file")"

  say "$APP_NAME is ready."
  echo
  echo "Open the Web UI in your browser:"
  if [ -n "$finish_public_ip" ] && [ "$finish_public_ip" != "$finish_host_ip" ]; then
    echo "  Remote / public access: http://$finish_public_ip:$WEB_PORT"
    echo "  Same network access:    http://$finish_host_ip:$WEB_PORT"
  else
    echo "  http://$finish_host_ip:$WEB_PORT"
  fi
  echo
  echo "If you are on the same local network as this server, use the same-network address."
  echo "If you are connecting over the internet, use the public address and make sure TCP $WEB_PORT is allowed by the server firewall or VPS firewall."
  echo "Optional direct listing pings: allow or forward UDP 32000-32015 through the host firewall and any internet-to-DMZ firewall or router."
  echo "If this optional UDP range remains closed, DuneDocker.app automatically uses its ping relay instead."
  if [ "$DOCKER_GROUP_UPDATED" = "1" ]; then
    echo
    echo "Docker is ready. Setup can continue."
  fi
  echo
  echo "Your first admin password was generated automatically."
  if [ -n "$finish_admin_password" ]; then
    echo "Use this password to sign in:"
    echo "  $finish_admin_password"
  else
    echo "The password was not ready yet. Wait a few seconds and run ./install.sh again to show it."
  fi
  echo
  echo "After signing in, the setup wizard will check the server and finish everything from the browser."
  echo "If you prefer the terminal, you can also run: dune --help"
}

say "Starting Dune Docker Console Installer."

if ! is_linux; then
  echo "This automatic installer runs on Linux servers."
  echo "For Docker Desktop on Windows or another VM setup, start Docker Desktop first, then start the Web UI from the extracted release folder."
  exit 1
fi

ensure_basic_tools
install_docker
start_docker
ensure_docker_group_access
ensure_compose
install_cli_command
migrate_existing_ownership
choose_web_port
start_console
show_finish

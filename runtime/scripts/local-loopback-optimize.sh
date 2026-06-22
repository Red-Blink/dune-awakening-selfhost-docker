#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

[ -f .env ] && . ./.env
[ -r runtime/generated/battlegroup.env ] && . runtime/generated/battlegroup.env

source runtime/scripts/runtime-env.sh

CHAIN_NAME="DUNE_LOCAL_LOOPBACK"

SERVER_IP="$(resolve_server_ip)"
BIND_IP="$(resolve_bind_ip)"
CLIENT_PORT_BASE="$(resolve_client_port_base)"
IGW_PORT_BASE="$(resolve_igw_port_base)"
CLIENT_PORT_END="$((CLIENT_PORT_BASE + 33))"
IGW_PORT_END="$((IGW_PORT_BASE + 33))"

is_ipv4() {
  printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'
}

is_private_ipv4() {
  local ip="$1"
  printf '%s' "$ip" | grep -Eq '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)'
}

iptables_cmd() {
  if command -v iptables >/dev/null 2>&1; then
    if iptables "$@" 2>/dev/null; then
      return 0
    fi
    if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
      sudo -n iptables "$@"
      return $?
    fi
  fi
  return 127
}

ensure_chain() {
  iptables_cmd -t nat -N "$CHAIN_NAME" 2>/dev/null || true
  iptables_cmd -t nat -F "$CHAIN_NAME"
  iptables_cmd -t nat -C OUTPUT -d "$SERVER_IP" -j "$CHAIN_NAME" >/dev/null 2>&1 || \
    iptables_cmd -t nat -A OUTPUT -d "$SERVER_IP" -j "$CHAIN_NAME"
}

install_rules() {
  iptables_cmd -t nat -A "$CHAIN_NAME" -p udp --dport "${CLIENT_PORT_BASE}:${CLIENT_PORT_END}" -j DNAT --to-destination "$BIND_IP"
  iptables_cmd -t nat -A "$CHAIN_NAME" -p udp --dport "${IGW_PORT_BASE}:${IGW_PORT_END}" -j DNAT --to-destination "$BIND_IP"
  iptables_cmd -t nat -A "$CHAIN_NAME" -p tcp --dport 31982 -j DNAT --to-destination "$BIND_IP"
}

main() {
  if ! is_ipv4 "$SERVER_IP" || ! is_ipv4 "$BIND_IP"; then
    echo "Skipping local loopback optimization: server or bind IP is not IPv4."
    return 0
  fi

  if [ "$SERVER_IP" = "$BIND_IP" ]; then
    echo "Skipping local loopback optimization: server IP already matches bind IP."
    return 0
  fi

  if is_private_ipv4 "$SERVER_IP"; then
    echo "Skipping local loopback optimization: server IP is already private/LAN."
    return 0
  fi

  if ! iptables_cmd -t nat -L >/dev/null 2>&1; then
    echo "Skipping local loopback optimization: iptables NAT is unavailable."
    return 0
  fi

  ensure_chain
  install_rules
  echo "Applied same-host public-IP loopback optimization: $SERVER_IP -> $BIND_IP"
}

main "$@"

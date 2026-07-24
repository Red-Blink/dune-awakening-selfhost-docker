#!/usr/bin/env bash

steamcmd_log_has_dns_failure() {
  local log_file="$1"

  grep -Eiq \
    'could not resolve host|failed to resolve|resolve[^[:space:]]*[[:space:]]+(failed|failure)|temporary failure in name resolution|name or service not known|no address associated with hostname|nodename nor servname provided|nxdomain|getaddrinfo[^[:space:]]*[[:space:]]+(failed|failure)|gethostbyname[^[:space:]]*[[:space:]]+(failed|failure)' \
    "$log_file"
}

steamcmd_log_has_content_host_failure() {
  local log_file="$1"

  steamcmd_log_has_dns_failure "$log_file" \
    || grep -Eiq \
      'received 0 \(invalid\) http response|failed downloading [0-9]+ manifests? \(no connection\)|openconnection.*(failed|failure)|connection (timed out|timeout)' \
      "$log_file"
}

steamcmd_dns_host_from_log() {
  local log_file="$1"

  grep -Eio '([[:alnum:]-]+\.)+(valve\.org|steampowered\.com|steamcontent\.com|akamaihd\.net)' "$log_file" \
    | tail -n 1 \
    | tr '[:upper:]' '[:lower:]' \
    || true
}

steamcmd_source_priority_from_log() {
  local log_file="$1"

  sed -n "s/.*Moving to source priority class '\([0-9][0-9]*\)'.*/\1/p" "$log_file" \
    | tail -n 1 \
    || true
}

steamcmd_download_interface_count() {
  local log_file="$1"

  grep -c "Created download interface of type" "$log_file" || true
}

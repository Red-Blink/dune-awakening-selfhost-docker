#!/bin/bash
set -euo pipefail

main() {
    if [ -r /run/secrets/dune-game-env ]; then
        while IFS='=' read -r secret_key secret_val; do
            [ -n "${secret_key:-}" ] || continue
            case "$secret_key" in
                \#*) continue ;;
                fls-apikey)
                    export "fls-apikey=$secret_val" 2>/dev/null || true
                    ;;
                *)
                    export "${secret_key}=${secret_val}"
                    ;;
            esac
        done < /run/secrets/dune-game-env
    fi

    install_cert

    mkdir -p /home/dune/server/DuneSandbox/Saved/UserSettings
    chown -R dune:nogroup /home/dune/server/DuneSandbox/Saved

    mkdir -p "/home/dune/.config/Epic/Unreal Engine/Engine"
    config_path="/home/dune/.config/Epic/Unreal Engine/Engine/Config"
    [ -d "$config_path" ] && [ ! -L "$config_path" ] && rm -rf "$config_path"
    ln -sfn /home/dune/server/DuneSandbox/Saved/UserSettings "$config_path"
    chown -R dune:nogroup /home/dune/.config

    echo "Trying to fetch external address"
    local external_address=""
    local -a server_args=()
    fetch_external_node_address external_address

    if [ -n "$external_address" ]; then
        echo "Fetched external node address: $external_address"
    else
        echo "Unable to fetch external address, using POD IP instead: $POD_IP"
    fi

    for arg in "$@"; do
        if [[ "$arg" == -MultiHome=* ]] || [[ "$arg" == '-MultiHome=$POD_IP' ]]; then
            server_args+=("-MultiHome=$POD_IP")
            if [ -n "$external_address" ]; then
                server_args+=("-ExternalAddress=$external_address")
            fi
        else
            server_args+=("$arg")
        fi
    done

    local igw_address_arg="-IGWBindAddress=$POD_IP"
    server_args+=("$igw_address_arg")

    echo "Starting server with argv:"
    printf '  %q\n' /home/dune/server/DuneSandboxServer.sh "${server_args[@]}"

    launch_script=/home/dune/server/DuneSandbox/Saved/dune-launch.sh
    {
        printf '#!/bin/bash\n'
        printf 'exec '
        printf '%q ' /home/dune/server/DuneSandboxServer.sh "${server_args[@]}"
        printf '\n'
    } > "$launch_script"
    chmod 755 "$launch_script"
    chown dune:nogroup "$launch_script"

    su -s /bin/bash dune -c "$launch_script" &

    bg_pid=$!

    while ! pid="$(find_game_pid)"; do
        check_process_existence "$bg_pid" "$bg_pid"
        sleep 1
    done

    echo "$pid" > /home/dune/server_pid

    local -a ports=()
    while :; do
        mapfile -t ports < <(list_game_udp_ports "$pid")
        if [ "${#ports[@]}" -ge 2 ]; then
            break
        fi
        check_process_existence "$pid" "$bg_pid"
        sleep 1
    done

    echo "${ports[0]}" > /home/dune/game_port
    echo "${ports[1]}" > /home/dune/igw_port

    ssh=$((${ports[0]}-1111))
    echo "$ssh" > /home/dune/ssh_port

    if [ "${DUNE_ENABLE_CONTAINER_SSH:-0}" = "1" ]; then
        sed -i "s/#Port 22/Port ${ssh}/g" /etc/ssh/sshd_config
        service ssh start >/dev/null
    fi

    amend_kubernetes_metadata "$pid" "${ports[0]}" "${ports[1]}" "$ssh"

    wait "$bg_pid"
    result=$?

    export BUILD_REVISION
    export BUILD_CONFIGURATION

    exit "$result"
}

find_game_pid() {
    ps -eo pid=,args= \
        | awk '/\/home\/dune\/server\/DuneSandbox\/Binaries\/Linux\/DuneSandboxServer[[:alpha:]-]* DuneSandbox/ { print $1; exit }'
}

list_game_udp_ports() {
    local pid="$1"

    su -s /bin/bash dune -c "lsof -Pan -p ${pid} -iUDP 2>/dev/null" \
        | awk '
            /UDP/ {
                split($9, addr, ":")
                port = addr[length(addr)]
                if (port ~ /^(7|8)[0-9]+$/) {
                    print port
                }
            }
        ' \
        | sort -n -u || true
}

install_cert() {
    service_account=/var/run/secrets/kubernetes.io/serviceaccount
    if [ -d "${service_account}" ]; then
        certificate=${service_account}/ca.crt
        echo "Installing certificate: $certificate"
        ln -sfn ${certificate} /usr/local/share/ca-certificates/kubernetes.crt
        update-ca-certificates
    fi
}

check_process_existence() {
    local probe_pid="${1:-}"
    local wait_pid="${2:-${bg_pid:-}}"

    if [ -z "$probe_pid" ]; then
        echo "Process probe pid was empty." >&2
        if [ -n "$wait_pid" ]; then
            wait "$wait_pid" || true
        fi
        exit 1
    fi

    if ! kill -0 "$probe_pid" 2>/dev/null; then
        if [ -n "$wait_pid" ]; then
            wait "$wait_pid"
            exit $?
        fi
        exit 1
    fi
}

amend_kubernetes_metadata() {
    service_account=/var/run/secrets/kubernetes.io/serviceaccount
    if [ -d "${service_account}" ]; then
        namespace=$(cat ${service_account}/namespace)
        token=$(cat ${service_account}/token)
        certificate=${service_account}/ca.crt

        curl \
            --silent \
            --cacert ${certificate} \
            -H "Authorization: Bearer ${token}" \
            -H "Content-Type: application/merge-patch+json" \
            -X PATCH \
            --max-time 120 \
            --connect-timeout 120 \
            https://${KUBERNETES_SERVICE_HOST:-}:${KUBERNETES_SERVICE_PORT_HTTPS:-}/api/v1/namespaces/${namespace}/pods/${POD_NAME}/status \
            -d "{ \"metadata\": { \"annotations\": { \"gamePid\": \"$1\", \"gamePort\": \"$2\", \"igwPort\": \"$3\", \"sshPort\": \"$4\" } } }" \
            > /home/dune/patch_result
    fi
}

fetch_external_node_address() {
    local -n address=$1

    if [ -n "${EXTERNAL_ADDRESS_OVERRIDE:-}" ]; then
        address="${EXTERNAL_ADDRESS_OVERRIDE}"
        echo "Using configured external address override: $address"
        return 0
    fi

    if [ -n "${NODE_NAME:-}" ] && [ -n "${KUBERNETES_SERVICE_HOST:-}" ] && [ -n "${KUBERNETES_SERVICE_PORT_HTTPS:-}" ]; then
        service_account=/var/run/secrets/kubernetes.io/serviceaccount
        if [ -d "${service_account}" ]; then
            namespace=$(cat ${service_account}/namespace)
            token=$(cat ${service_account}/token)
            certificate=${service_account}/ca.crt

            echo "Sending curl request to get node address"

            curl \
                --silent \
                --cacert ${certificate} \
                -H "Authorization: Bearer ${token}" \
                -H "Content-Type: application/json" \
                -X GET \
                --max-time 120 \
                --connect-timeout 120 \
                https://${KUBERNETES_SERVICE_HOST}:${KUBERNETES_SERVICE_PORT_HTTPS}/api/v1/nodes/${NODE_NAME} \
                > /tmp/node_spec

            address=$(jq --raw-output '.status.addresses[] | select(.type=="ExternalIP") | .address' /tmp/node_spec)
            echo "Got address of node $NODE_NAME: $address"
        fi
    fi
}

_term() {
    if [ -n "${pid:-}" ]; then
        kill -TERM "$pid"
        [ -n "${bg_pid:-}" ] && wait "$bg_pid"
        exit $?
    fi
}

set -m
trap _term SIGTERM

main "$@"

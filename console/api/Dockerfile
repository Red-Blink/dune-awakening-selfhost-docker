FROM node:20-trixie AS web-build
WORKDIR /app/web
COPY console/web/package.json ./
COPY console/web/package-lock.json ./
RUN npm ci
COPY runtime/data/augment-compatibility.json /runtime/data/augment-compatibility.json
COPY runtime/data/admin-skill-modules.json /runtime/data/admin-skill-modules.json
COPY console/web ./
RUN npm run build

FROM node:20-trixie
LABEL io.github.red-blink.dune-selfhost.component="console"
WORKDIR /app
ENV NODE_ENV=production

# Runtime tools required by RedBlink dune scripts when the web admin runs in a container.
# We install small OS tools through apt, then install Docker CLI + Compose plugin
# as standalone binaries to avoid pulling the heavy docker.io Debian package.
# The psql client is what decides how the console's publisher loops reach the
# database. runtime/scripts/lib/postgres.sh and runtime/scripts/dune_psql.py
# prefer a TCP connection to the port start-postgres.sh publishes on loopback
# and fall back to `docker exec dune-postgres psql` when no client is installed
# -- and this image had none, so every query from here took the fallback.
# publish-deepdesert-overrides.sh alone re-queries every ten seconds and fans
# out over every partition, and each exec spawns a conmon pair that lingers for
# the engine's exit delay. The container runs with network_mode: host (see
# docker-compose.web.yml), so 127.0.0.1 here really is the host's loopback and
# really does reach the published port.
# gnupg (gpg) is required by `dune db backup-system`'s authenticated
# (AEAD/OCB) archive encryption when the backup is triggered from the
# Web Console rather than a host shell. The VERSION is what matters, not
# just the package: --aead-algo landed in GnuPG 2.3, and bookworm caps at
# 2.2.40, which rejects the flag outright -- so this image could install
# gnupg and still fail every system backup, after dumping the whole
# database. bookworm-backports carries the same 2.2.40, so the base is
# trixie (Debian 13), whose gnupg 2.4.7 supports it. db.sh preflights the
# capability and refuses to downgrade to an unauthenticated cipher, so an
# older base fails loudly rather than silently weakening the archive.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        iproute2 \
        ca-certificates \
        curl \
        bash \
        unzip \
        procps \
        netcat-openbsd \
        gnupg \
        postgresql-client \
    && rm -rf /var/lib/apt/lists/* \
    && arch="$(dpkg --print-architecture)" \
    && case "$arch" in \
        amd64) \
          docker_arch="x86_64"; \
          compose_arch="x86_64"; \
          docker_sha256="4f798b3ee1e0140eab5bf30b0edc4e84f4cdb53255a429dc3bbae9524845d640"; \
          compose_sha256="383ce6698cd5d5bbf958d2c8489ed75094e34a77d340404d9f32c4ae9e12baf0" \
          ;; \
        arm64) \
          docker_arch="aarch64"; \
          compose_arch="aarch64"; \
          docker_sha256="e6b53725a73763ab3f988c73f8772eaed429754c1a579db5ff11f21990fd1817"; \
          compose_sha256="6e9fbd5daa20dca5d7d89145081ae8155d68ef2928b497d9f85b54fe0f9dbb2c" \
          ;; \
        *) echo "Unsupported architecture for Docker CLI: $arch" >&2; exit 1 ;; \
       esac \
    && curl -fsSL --proto '=https' "https://download.docker.com/linux/static/stable/${docker_arch}/docker-27.5.1.tgz" -o /tmp/docker.tgz \
    && echo "${docker_sha256}  /tmp/docker.tgz" | sha256sum -c - \
    && tar -xzf /tmp/docker.tgz -C /tmp \
    && mv /tmp/docker/docker /usr/local/bin/docker \
    && chmod +x /usr/local/bin/docker \
    && rm -rf /tmp/docker /tmp/docker.tgz \
    && mkdir -p /usr/local/lib/docker/cli-plugins \
    && curl -fsSL --proto '=https' "https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-${compose_arch}" \
        -o /usr/local/lib/docker/cli-plugins/docker-compose \
    && echo "${compose_sha256}  /usr/local/lib/docker/cli-plugins/docker-compose" | sha256sum -c - \
    && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose \
    && docker --version \
    && docker compose version

COPY console/api/package.json ./
COPY console/api/package-lock.json ./
RUN npm ci --omit=dev
COPY console/api/src ./src
COPY console/api/data/i18n-translations-db.json ./data/i18n-translations-db.json
COPY --from=web-build /app/web/dist /app/web-dist
COPY console/api/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && useradd -m -s /bin/bash dune \
    && mkdir -p /repo /app \
    && chmod 755 /app /repo
ENV HOME=/tmp/dune-console-home
ENV DOCKER_CONFIG=/tmp/dune-console-home/.docker
USER dune
WORKDIR /repo
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "/app/src/server.js"]

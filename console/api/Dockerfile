FROM node:20-bookworm AS web-build
WORKDIR /app/web
COPY console/web/package.json ./
COPY console/web/package-lock.json ./
RUN npm ci
COPY runtime/data/augment-compatibility.json /runtime/data/augment-compatibility.json
COPY console/web ./
RUN npm run build

FROM node:20-bookworm
WORKDIR /app
ENV NODE_ENV=production

# Runtime tools required by RedBlink dune scripts when the web admin runs in a container.
# We install small OS tools through apt, then install Docker CLI + Compose plugin
# as standalone binaries to avoid pulling the heavy docker.io Debian package.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        iproute2 \
        ca-certificates \
        curl \
        bash \
        unzip \
        procps \
        netcat-openbsd \
    && rm -rf /var/lib/apt/lists/* \
    && arch="$(dpkg --print-architecture)" \
    && case "$arch" in \
        amd64) docker_arch="x86_64"; compose_arch="x86_64" ;; \
        arm64) docker_arch="aarch64"; compose_arch="aarch64" ;; \
        *) echo "Unsupported architecture for Docker CLI: $arch" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://download.docker.com/linux/static/stable/${docker_arch}/docker-27.5.1.tgz" -o /tmp/docker.tgz \
    && tar -xzf /tmp/docker.tgz -C /tmp \
    && mv /tmp/docker/docker /usr/local/bin/docker \
    && chmod +x /usr/local/bin/docker \
    && rm -rf /tmp/docker /tmp/docker.tgz \
    && mkdir -p /usr/local/lib/docker/cli-plugins \
    && curl -fsSL "https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-${compose_arch}" \
        -o /usr/local/lib/docker/cli-plugins/docker-compose \
    && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose \
    && docker --version \
    && docker compose version

COPY console/api/package.json ./
COPY console/api/package-lock.json ./
RUN npm ci --omit=dev
COPY console/api/src ./src
COPY --from=web-build /app/web/dist /app/web-dist
WORKDIR /repo
CMD ["node", "/app/src/server.js"]

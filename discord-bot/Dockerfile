FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN apk upgrade --no-cache \
  && npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /root/.npm

COPY src ./src
COPY scripts ./scripts

RUN addgroup -S dune && adduser -S dune -G dune

USER dune

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "process.exit(0)"

CMD ["node", "scripts/discord-runtime.mjs"]

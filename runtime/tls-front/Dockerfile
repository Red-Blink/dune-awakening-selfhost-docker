# Encrypted front door for the Console API (HTTPS in front of the Console).
FROM golang:1.25-alpine AS build

WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 go vet ./... \
    && CGO_ENABLED=0 go test ./... \
    && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/dune-tls-front .

FROM alpine:3.22

# Runs as the host user chosen in docker-compose.tls-front.yml (DUNE_HOST_UID/GID).
COPY --from=build /out/dune-tls-front /usr/local/bin/dune-tls-front

HEALTHCHECK --interval=30s --timeout=8s --start-period=10s --retries=3 CMD ["/usr/local/bin/dune-tls-front", "-healthcheck"]
ENTRYPOINT ["/usr/local/bin/dune-tls-front"]

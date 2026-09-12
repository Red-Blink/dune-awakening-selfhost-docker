FROM golang:1.25-alpine AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN go test ./...
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/dune-public-probe .

FROM alpine:3.22

RUN apk add --no-cache ca-certificates \
    && addgroup -S -g 10001 probe \
    && adduser -S -D -H -u 10001 -G probe probe

COPY --from=build /out/dune-public-probe /usr/local/bin/dune-public-probe

USER probe
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["sh", "-c", "kill -0 1"]
ENTRYPOINT ["/usr/local/bin/dune-public-probe"]

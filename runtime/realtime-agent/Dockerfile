# Realtime Data position agent (mvagent) for this host, built here from the
# MapViewer3D sources. Started and stopped by runtime/scripts/realtime-agent.sh
# and Settings -> API Keys. See docs/console/realtime.md.
#
# The sources come from a release tag of MapViewer3D and the build stops unless
# the tag still points at MV_COMMIT (supply chain: a moved tag fails the build).
# Base images are pinned by digest. The final image has no shell.

ARG GO_IMAGE=golang:1.26-alpine@sha256:8ac98ca534ac3f51e1f420a1dd2c15e74c75cfa0f23f3ad27eb5d7236c349a0c
ARG RUN_IMAGE=gcr.io/distroless/static-debian12@sha256:d75cdd72874d4790092fcb1b058493ecf6bb5bf2b2b897045b00ff01d91843f2

FROM ${GO_IMAGE} AS build
RUN apk add --no-cache git
ARG MV_REPO=https://github.com/dev-prophet-code/MapViewer3D.git
ARG MV_REF=beta.15
ARG MV_COMMIT=7e1a73044023da89d42c9ea3ab3dba133904e8c1
RUN git clone --depth 1 --branch "${MV_REF}" "${MV_REPO}" /src \
 && test "$(git -C /src rev-parse HEAD)" = "${MV_COMMIT}" \
 || { echo "MV_REF ${MV_REF} is not commit ${MV_COMMIT}" >&2; exit 1; }
WORKDIR /src/backend
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/mvagent ./cmd/mvagent \
 && /out/mvagent -version

# mvagent must run as root: it reads /proc/<pid>/mem of the game servers.
FROM ${RUN_IMAGE} AS agent
COPY --from=build /out/mvagent /usr/local/bin/mvagent
ENTRYPOINT ["/usr/local/bin/mvagent"]
CMD ["-addr", "127.0.0.1:8796"]

ARG DIRECTOR_IMAGE=registry.funcom.com/funcom/self-hosting/seabass-server-bg-director:latest
FROM ${DIRECTOR_IMAGE} AS director

FROM mcr.microsoft.com/dotnet/sdk:8.0-bookworm-slim AS builder

WORKDIR /work
COPY --from=director /Tools/Battlegroups/Director/BattlegroupDirector/Director /work/Director
COPY . /src

RUN dotnet tool install ilspycmd --tool-path /tools --version 9.1.0.7988 \
 && /tools/ilspycmd --disable-updatecheck --dump-package --outputdir /work/director /work/Director \
 && dotnet run --project /src/director-compat-patcher.csproj -- \
      /work/director/Director.dll /work/Director.patched.dll \
 && mv /work/Director.patched.dll /work/director/Director.dll \
 && cp /src/Director.runtimeconfig.json /work/director/Director.runtimeconfig.json

FROM director

ARG DIRECTOR_IMAGE
ARG COMPAT_REVISION=1
LABEL io.github.red-blink.dune-selfhost.component="director-compat" \
      io.github.red-blink.dune-selfhost.source-image="${DIRECTOR_IMAGE}" \
      io.github.red-blink.dune-selfhost.compat-revision="${COMPAT_REVISION}"

COPY --from=builder /work/director /opt/dune-director-compat

ENTRYPOINT ["/usr/bin/dotnet", "/opt/dune-director-compat/Director.dll"]

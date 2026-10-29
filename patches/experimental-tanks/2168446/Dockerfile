ARG BASE_IMAGE=registry.funcom.com/funcom/self-hosting/seabass-server:2168446-0-shipping
FROM ${BASE_IMAGE}
COPY --chown=dune:nogroup DuneSandboxServer-Linux-Shipping /home/dune/server/DuneSandbox/Binaries/Linux/DuneSandboxServer-Linux-Shipping
COPY --chown=dune:nogroup assets/ /home/dune/server/DuneSandbox/Content/Paks/
RUN chmod 755 /home/dune/server/DuneSandbox/Binaries/Linux/DuneSandboxServer-Linux-Shipping
LABEL io.github.red-blink.dune-selfhost.component="experimental-tanks" io.github.red-blink.dune-selfhost.tank-build="2168446-0-shipping" io.github.red-blink.dune-selfhost.candidate="true"

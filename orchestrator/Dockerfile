FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN dpkg --add-architecture i386 \
 && apt-get update -y \
 && apt-get install -y \
    ca-certificates \
    curl \
    tar \
    gzip \
    unzip \
    jq \
    git \
    python3 \
    python3-yaml \
    procps \
    util-linux \
    lib32gcc-s1 \
    lib32stdc++6 \
    docker.io \
 && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash dune \
 && mkdir -p \
    /home/dune/.steam \
    /srv/dune/server \
    /srv/dune/steam \
    /srv/dune/generated \
    /srv/dune/cache \
 && chown -R dune:dune /home/dune /srv/dune

COPY dune_orchestrator.py /usr/local/bin/dune
RUN chmod +x /usr/local/bin/dune

USER dune

ENTRYPOINT ["/usr/local/bin/dune"]
CMD ["help"]

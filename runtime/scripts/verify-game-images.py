#!/usr/bin/env python3
"""Verify the complete downloaded Docker bundle before publishing its tags."""
import json
import hashlib
import io
import re
import subprocess
import sys
import tarfile
from pathlib import Path

PREFIX = "registry.funcom.com/funcom/self-hosting/"
WORLD = PREFIX + "seabass-server"
POSTGRES = PREFIX + "igw-postgres"
REQUIRED = [WORLD] + [WORLD + suffix for suffix in (
    "-db-utils", "-bg-director", "-gateway", "-rabbitmq", "-text-router"
)] + [POSTGRES]
MAX_METADATA_BYTES = 8 * 1024 * 1024


def metadata(archive, name):
    member = archive.getmember(name)
    if not member.isfile() or member.size > MAX_METADATA_BYTES:
        raise ValueError(f"Invalid image metadata: {name}")
    with archive.extractfile(member) as stream:
        return json.load(stream)


def bundle_images(directory):
    images = {}
    archives = sorted(path for path in directory.rglob("*") if path.is_file()
                      and path.name.endswith((".tar", ".tar.gz", ".tgz")))
    if not archives:
        raise ValueError("No downloaded image archives found; refusing to reuse old local images.")
    for path in archives:
        with tarfile.open(path) as archive:
            rows = metadata(archive, "manifest.json")
            if not isinstance(rows, list):
                raise ValueError(f"Invalid Docker manifest in {path.name}")
            for row in rows:
                for tag in row.get("RepoTags") or []:
                    repo, _, version = tag.rpartition(":")
                    if repo not in REQUIRED:
                        continue
                    if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}", version):
                        raise ValueError(f"Invalid image tag for {repo}")
                    config = metadata(archive, row["Config"])
                    layers = config.get("rootfs", {}).get("diff_ids")
                    if (not isinstance(layers, list) or not layers
                            or any(not isinstance(layer, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", layer) for layer in layers)
                            or any(not isinstance(config.get(key), str) or not config[key]
                                   for key in ("created", "architecture", "os"))):
                        raise ValueError(f"Invalid image configuration for {repo}")
                    candidate = (tag, config)
                    if repo in images and images[repo] != candidate:
                        raise ValueError(f"Conflicting downloaded images for {repo}")
                    images[repo] = candidate
    missing = set(REQUIRED) - images.keys()
    if missing:
        raise ValueError("Downloaded bundle is incomplete: " + ", ".join(sorted(missing)))
    world_tag = images[WORLD][0].rpartition(":")[2]
    for repo in REQUIRED:
        if repo != POSTGRES and images[repo][0].rpartition(":")[2] != world_tag:
            raise ValueError(f"Downloaded service version does not match the world server: {repo}")
    return images


def verify_loaded(images, inspect):
    for repo in REQUIRED:
        tag, expected = images[repo]
        actual = inspect(tag)
        # Docker's containerd store may expose an OCI manifest ID instead of
        # the archive's config digest. Compare the actual config/layer contract,
        # not those different kinds of digest.
        if (actual.get("RootFS", {}).get("Layers") != expected.get("rootfs", {}).get("diff_ids")
                or actual.get("Created") != expected.get("created")
                or actual.get("Architecture") != expected.get("architecture")
                or actual.get("Os") != expected.get("os")):
            raise ValueError(f"Loaded image does not match the downloaded bundle: {tag}")


def inspect_image(tag):
    result = subprocess.run(["docker", "image", "inspect", tag], capture_output=True,
                            text=True, timeout=30)
    if result.returncode:
        raise ValueError(f"Required image is not loaded locally: {tag}")
    rows = json.loads(result.stdout)
    if len(rows) != 1:
        raise ValueError(f"Cannot verify loaded image: {tag}")
    return rows[0]


def stage_world(directory):
    """Load the incoming world under a private tag, even for a same-tag republish."""
    images = bundle_images(directory)
    tag, _ = images[WORLD]
    with tarfile.open(directory / "battlegroup/server.tar") as archive:
        rows = metadata(archive, "manifest.json")
        index = metadata(archive, "index.json")
        if len(rows) != 1 or rows[0]["RepoTags"] != [tag] or len(index["manifests"]) != 1:
            raise ValueError("Cannot isolate the incoming world image.")
        descriptor = index["manifests"][0]
        digest = descriptor["digest"]
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
            raise ValueError("Invalid world image digest.")
        manifest_path = "blobs/sha256/" + digest[7:]
        config_digest = metadata(archive, manifest_path)["config"]["digest"]
        if "sha256:" + hashlib.sha256(archive.extractfile(manifest_path).read()).hexdigest() != digest:
            raise ValueError("World image manifest digest mismatch.")
        config_path = rows[0]["Config"]
        metadata(archive, config_path)
        if "sha256:" + hashlib.sha256(archive.extractfile(config_path).read()).hexdigest() != config_digest:
            raise ValueError("World image configuration digest mismatch.")
        reference = "redblink-dune-tank-stage:" + digest[7:]
        existing = subprocess.run(["docker", "image", "inspect", "--format", "{{.Id}}", digest],
                                  capture_output=True, text=True)
        if existing.returncode == 0 and existing.stdout.strip() == digest:
            reference = digest
        else:
            rows[0]["RepoTags"] = [reference]
            descriptor["annotations"] = {"io.containerd.image.name": "docker.io/library/" + reference,
                                         "org.opencontainers.image.ref.name": digest[7:]}
            replacements = {"manifest.json": rows, "index.json": index}
            with subprocess.Popen(["docker", "load"], stdin=subprocess.PIPE, stdout=sys.stderr) as load:
                with tarfile.open(fileobj=load.stdin, mode="w|") as output:
                    for entry in archive:
                        if entry.name in replacements:
                            data = json.dumps(replacements[entry.name]).encode()
                            entry.size = len(data)
                            output.addfile(entry, io.BytesIO(data))
                        elif entry.name != "repositories":
                            output.addfile(entry, archive.extractfile(entry) if entry.isfile() else None)
                load.stdin.close()
                if load.wait():
                    raise ValueError("Cannot load the isolated world image.")
        loaded = inspect_image(reference)
        identifier = loaded["Id"]
        if identifier not in (digest, config_digest) or loaded["RootFS"]["Layers"] != images[WORLD][1]["rootfs"]["diff_ids"]:
            raise ValueError("Staged world image identity mismatch.")
        return {"tag": tag.rpartition(":")[2], "image": identifier, "digest": digest, "config": config_digest,
                "temporaryTag": reference if reference != digest else ""}


def main():
    directory = Path(sys.argv[1] if len(sys.argv) > 1 else "/srv/dune/server/images")
    try:
        if sys.argv[1:2] == ["--stage-world"]:
            print(json.dumps(stage_world(Path(sys.argv[2]))))
            return 0
        images = bundle_images(directory)
        verify_loaded(images, inspect_image)
        print("DUNE_WORLD_IMAGE_TAG=" + images[WORLD][0].rpartition(":")[2])
        print("DUNE_POSTGRES_IMAGE_TAG=" + images[POSTGRES][0].rpartition(":")[2])
    except (ValueError, KeyError, TypeError, OSError, tarfile.TarError,
            subprocess.SubprocessError) as exc:
        print(f"Game image verification failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

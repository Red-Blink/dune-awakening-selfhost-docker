"""Build-locked, opt-in Tank image policy. No game data is edited here."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import fcntl
import re
import time
import signal
import sys
from dune_psql import query_tsv

ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / 'runtime/generated/experimental-tanks.json'
BINARY = '/home/dune/server/DuneSandbox/Binaries/Linux/DuneSandboxServer-Linux-Shipping'
PRESETS = ['T0', 'T6_CombatDart', 'T6_CombatFire', 'T6_DartInventory', 'T6_RocketInventory', 'T6_FireInventory']


def read_state():
    if not STATE.exists():
        return {'enabled': False}
    value = json.loads(STATE.read_text())
    if not isinstance(value, dict) or type(value.get('enabled')) is not bool:
        raise ValueError('Experimental Tanks settings are invalid. Restore the saved settings before starting Hagga.')
    return value


def manifest(tag):
    if not re.fullmatch(r'[0-9]+-0-shipping', tag):
        return None
    path = ROOT / 'patches/experimental-tanks' / tag.split('-', 1)[0] / 'manifest.json'
    if not path.is_file():
        return None
    spec = json.loads(path.read_text())
    if spec.get('worldTag') != tag or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*', spec.get('version', '')):
        raise ValueError('The Tank manifest does not match the requested game build.')
    return spec


INTERRUPTED_APPLY = 'The previous operation was interrupted. Apply Tank settings again to reconcile Hagga.'


def apply_state(*, recover=False):
    """Detect stale apply state under the same lock that owns every switch.

    Startup already holds this lock in its parent process. Trying to acquire
    it again would mistake that startup for a still-running Tank operation.
    Internal apply children must retain the flag throughout the switch.
    """
    state = read_state()
    if not state.get('applying') or os.environ.get('DUNE_TANK_APPLY') == '1':
        return state

    def interrupted_state():
        # Re-read after acquiring the lock; never overwrite a completed switch
        # using a snapshot read while that switch was still in flight.
        current = read_state()
        if current.get('applying'):
            current = {**current, 'applying': False, 'error': INTERRUPTED_APPLY}
            if recover:
                save(current)
        return current

    if os.environ.get('DUNE_BATTLEGROUP_LIFECYCLE_LOCK_HELD') == '1':
        return interrupted_state()
    lock_path = Path(os.environ.get('DUNE_BATTLEGROUP_LIFECYCLE_LOCK_FILE') or
                     ROOT / 'runtime/generated/battlegroup-lifecycle.lock')
    if not recover and not lock_path.exists():
        return interrupted_state()
    if recover:
        lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open('a' if recover else 'r') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return read_state()
        return interrupted_state()


def status(tag):
    state = apply_state()
    applying, error = state.get('applying', False), state.get('error', '')
    return {'enabled': state['enabled'], 'supported': manifest(tag) is not None,
            'build': tag, 'status': 'Unsupported Build' if state['enabled'] and not manifest(tag)
            else 'Enabled' if state['enabled'] else 'Disabled',
            'applying': applying, 'error': error}


def save(state):
    STATE.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=STATE.parent, prefix='.experimental-tanks-')
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(state, f)
            f.write('\n')
        os.chmod(name, 0o644)
        os.replace(name, STATE)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def run(*args, capture=False, diagnostics=False):
    return subprocess.run(args, check=True, text=True,
                          stdout=subprocess.PIPE if capture else sys.stderr if diagnostics else None).stdout


def hagga_is_ready(partition, name):
    # Share the Maps page contract rather than declaring the switch complete
    # from farm_state.ready, which the game publishes before accepting players.
    result = subprocess.run([
        'bash', '-c', 'source runtime/scripts/farm-readiness.sh; farm_partition_is_ready "$1" "$2" "$3"',
        'farm-readiness', name, str(partition), '3' if name == 'dune-server-survival-1' else '0',
    ], cwd=ROOT, capture_output=True, text=True, timeout=60)
    return result.returncode == 0


def restore_missing_image(tag):
    """Rebuild a pruned opt-in image from the pinned inputs, never fall back to stock."""
    def prepare():
        state = read_state()
        if not state['enabled'] or state.get('build') != tag:
            raise ValueError('Tank settings changed. Retry starting Hagga.')
        if state.get('applying') and os.environ.get('DUNE_TANK_APPLY') != '1':
            raise ValueError('Hagga image settings are being applied. Wait for this operation to finish.')
        image_id = build(tag)
        save({**state, 'imageId': image_id})
        return image_id

    if os.environ.get('DUNE_BATTLEGROUP_LIFECYCLE_LOCK_HELD') == '1':
        return prepare()
    lock_path = Path(os.environ.get('DUNE_BATTLEGROUP_LIFECYCLE_LOCK_FILE') or
                     ROOT / 'runtime/generated/battlegroup-lifecycle.lock')
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('Another Battlegroup operation is running. Try again when it finishes.')
        return prepare()


def image_for_map(tag, map_name):
    state = read_state()
    if map_name != 'Survival_1' or not state['enabled']:
        return None
    if os.environ.get('DUNE_GAME_SERVER_IMAGE'):
        raise ValueError('A custom global game image cannot be combined with Experimental Tanks.')
    if not manifest(tag) or state.get('build') != tag:
        raise ValueError('Experimental Tanks do not support this game build. Disable them before starting Hagga.')
    image_id = state.get('imageId', '')
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image_id):
        raise ValueError('The experimental Tank image has not been prepared.')
    try:
        run('docker', 'image', 'inspect', image_id, capture=True)
    except subprocess.CalledProcessError:
        # Startup may follow a Docker image prune while the stack was stopped.
        # Build performs the same base, executable and asset checks as Enable.
        image_id = restore_missing_image(tag)
    return image_id


def apply(tag, enabled):
    """Switch only running Hagga maps; keep the old policy for rollback."""
    lock_path = Path(os.environ.get('DUNE_BATTLEGROUP_LIFECYCLE_LOCK_FILE') or
                     ROOT / 'runtime/generated/battlegroup-lifecycle.lock')
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('Another Battlegroup operation is running. Try again when it finishes.')
        previous = read_state()
        image_id = build(tag) if enabled else ''
        desired = {'enabled': enabled, 'build': tag, 'imageId': image_id, 'applying': True}
        rows = query_tsv("select partition_id, coalesce(dimension_index,0) from dune.world_partition where map='Survival_1' and not coalesce(blocked,false) order by partition_id;")
        running = {
            row['Names'] for row in (json.loads(line) for line in run('docker', 'ps', '--format', '{{json .}}', capture=True).splitlines())}
        targets = []
        for row in rows.splitlines():
            partition, dimension = map(int, row.split('\t'))
            name = 'dune-server-survival-1' if dimension == 0 else f'dune-server-survival-1-{partition}'
            if name in running:
                targets.append((partition, name))
        if targets:
            print('Creating a database safety backup before switching Hagga images.', flush=True)
            run(str(ROOT / 'runtime/scripts/db.sh'), 'backup')
        backup = ROOT / 'runtime/backups/experimental-tanks' / time.strftime('%Y%m%d-%H%M%S')
        backup.mkdir(parents=True, exist_ok=False)
        backup.chmod(0o700)
        (backup / 'previous-settings.json').write_text(json.dumps(previous) + '\n')
        marker = ROOT / 'runtime/generated/sietch-topology-maintenance'
        env = {**os.environ, 'DUNE_BATTLEGROUP_LIFECYCLE_LOCK_HELD': '1', 'DUNE_TANK_APPLY': '1'}

        def sietch(action, partition):
            marker.touch()
            command = {'stop': 'stop-partition', 'start': 'start-partition'}.get(action, action)
            print(f'{command}: Hagga partition {partition}', flush=True)
            subprocess.run([str(ROOT / 'runtime/scripts/sietches.sh'), command, str(partition)], check=True, env=env, capture_output=True, text=True)

        def wait_ready(policy):
            expected = policy['imageId'] if policy.get('enabled') else run(
                'docker', 'image', 'inspect', '--format', '{{.Id}}',
                os.environ.get('DUNE_GAME_SERVER_IMAGE') or f'registry.funcom.com/funcom/self-hosting/seabass-server:{tag}', capture=True).strip()
            deadline = time.monotonic() + 900
            pending = list(targets)
            while pending and time.monotonic() < deadline:
                marker.touch()
                for partition, name in list(pending):
                    ready = hagga_is_ready(partition, name)
                    if ready and run('docker', 'inspect', '--format', '{{.Image}}', name, capture=True).strip() == expected:
                        pending.remove((partition, name))
                if pending:
                    time.sleep(3)
            if pending:
                raise ValueError('Hagga did not become ready in time. Check the affected map logs.')

        save(desired)
        try:
            for partition, name in targets:
                sietch('stop', partition)
                saved = ROOT / 'runtime/game' / name.removeprefix('dune-server-') / 'Saved'
                if saved.exists():
                    shutil.copytree(saved, backup / name / 'Saved')
            for partition, _ in targets:
                sietch('start', partition)
            wait_ready(desired)
            save({**desired, 'applying': False})
            print('Experimental Tanks enabled. All affected Hagga maps are ready.' if enabled else
                  'Experimental Tanks disabled. All affected Hagga maps use the original image.', flush=True)
        except Exception:
            print('Tank settings could not be applied. Restoring the previous image policy.', flush=True)
            save({**previous, 'applying': True})
            try:
                for partition, _ in targets:
                    sietch('restart', partition)
                wait_ready(previous)
                save({**previous, 'applying': False})
            except Exception:
                save({**previous, 'applying': False, 'error': 'Rollback needs attention. Check Hagga logs before retrying.'})
            raise
        finally:
            marker.touch()


def patch_binary(source, spec):
    data = bytearray(source)
    if hashlib.sha256(data).hexdigest() != spec['cleanSha256']:
        raise ValueError('The clean executable does not match the supported Tank build.')
    for offset, before, after in spec['sites']:
        before, after = bytes.fromhex(before), bytes.fromhex(after)
        if len(before) != len(after) or data[offset:offset + len(before)] != before:
            raise ValueError(f'Tank executable guard failed at {offset:#x}.')
        data[offset:offset + len(after)] = after
    if hashlib.sha256(data).hexdigest() != spec['patchedSha256']:
        raise ValueError('The patched executable hash does not match the verified reference.')
    return data


def base_image_id(spec, reference=None):
    reference = reference or f'registry.funcom.com/funcom/self-hosting/seabass-server:{spec["worldTag"]}'
    image_id = run('docker', 'image', 'inspect', '--format', '{{.Id}}', reference, capture=True).strip()
    # The containerd store exposes the manifest ID; Docker's classic store
    # exposes the archive's config ID. Pin both identities for each reviewed
    # variant, including official republishes that reuse the world tag.
    reviewed = {spec['baseImage'].split('@', 1)[1], spec['baseConfigId']}
    for base in spec.get('additionalBaseImages', []):
        reviewed.update((base['imageId'], base['configId']))
    if image_id not in reviewed:
        raise ValueError('The installed official image does not match the supported base.')
    return image_id


def build(tag, base_reference=None):
    spec = manifest(tag)
    if not spec:
        raise ValueError('This game build is not supported by Experimental Tanks.')
    if os.environ.get('DUNE_GAME_SERVER_IMAGE'):
        raise ValueError('Remove the custom global game image override before enabling Experimental Tanks.')
    build_number = tag.split('-', 1)[0]
    directory = ROOT / 'patches/experimental-tanks' / build_number
    assets = directory / 'assets'
    for name, expected in spec['assets'].items():
        if Path(name).name != name or name in ('', '.', '..'):
            raise ValueError('The Tank manifest contains an invalid asset filename.')
        if hashlib.sha256((assets / name).read_bytes()).hexdigest() != expected:
            raise ValueError(f'Tank asset checksum mismatch: {name}')
    # Do not pull a possibly different base or modify the official tag.
    base_id = base_image_id(spec, base_reference) if base_reference else base_image_id(spec)
    # Imported Funcom archives can lack registry metadata. Give the verified
    # local image its own build-only tag, without retagging the official image.
    base_tag = f'redblink-dune-tank-base:{build_number}-' + base_id[7:19]
    image_tag = f'redblink-dune-tanks:{build_number}-{spec["version"]}'
    run('docker', 'tag', base_id, base_tag)
    with tempfile.TemporaryDirectory(prefix='dune-tank-build-') as temp:
        context = Path(temp)
        container = run('docker', 'create', base_id, capture=True).strip()
        try:
            run('docker', 'cp', container + ':' + BINARY, str(context / 'clean'))
        finally:
            run('docker', 'rm', container, capture=True)
        patched = context / 'DuneSandboxServer-Linux-Shipping'
        patched.write_bytes(patch_binary((context / 'clean').read_bytes(), spec))
        patched.chmod(0o755)
        (context / 'clean').unlink()
        shutil.copytree(assets, context / 'assets')
        shutil.copy(directory / 'Dockerfile', context)
        run('docker', 'build', '--pull=false', '--network=none', '--build-arg',
            'BASE_IMAGE=' + base_tag, '-t', image_tag, str(context), diagnostics=True)
    image_id = run('docker', 'image', 'inspect', '--format', '{{.Id}}', image_tag, capture=True).strip()
    actual = run('docker', 'run', '--rm', '--network=none', '--entrypoint', 'sha256sum', image_id, BINARY, capture=True).split()[0]
    if actual != spec['patchedSha256']:
        raise ValueError('Built Tank image failed executable verification.')
    return image_id


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['status', 'resolve', 'prepare', 'apply', 'catalog', 'guard', 'update-guard', 'launch-guard'])
    parser.add_argument('args', nargs='*')
    a = parser.parse_args()
    tag = os.environ.get('DUNE_WORLD_IMAGE_TAG', '')
    if a.command == 'status':
        print(json.dumps(status(tag)))
    elif a.command == 'resolve':
        print(image_for_map(tag, a.args[0]) or '')
    elif a.command == 'prepare':
        if len(a.args) > 1:
            raise ValueError('Choose at most one reviewed base image reference.')
        print(build(tag, a.args[0]) if a.args else build(tag))
    elif a.command == 'apply':
        if a.args not in (['true'], ['false']):
            raise ValueError('Choose true or false for Experimental Tanks.')
        apply(tag, a.args == ['true'])
    elif a.command == 'launch-guard':
        if a.args[0] == 'Survival_1' and apply_state(recover=True).get('applying') and os.environ.get('DUNE_TANK_APPLY') != '1':
            raise ValueError('Hagga image settings are being applied. Wait for this operation to finish.')
    elif a.command == 'catalog':
        available = status(tag)
        rows = json.loads(Path(a.args[0]).read_text())
        for row in rows:
            if row['id'] == 'Tank':
                row['templates'] = PRESETS
        print(json.dumps([row for row in rows if row['id'] != 'Tank' or
                          (available['enabled'] and available['supported'] and not available['applying'] and not available['error'])]))
    elif a.command == 'guard':
        expected = image_for_map(tag, a.args[0])
        if a.args[0] != 'Survival_1' or not expected:
            raise ValueError('Tank spawning requires Experimental Tanks and a patched Hagga Sietch.')
        if read_state().get('applying') or read_state().get('error'):
            raise ValueError('Wait for Experimental Tanks to finish applying successfully.')
        if len(a.args) != 4 or not a.args[2].isdigit() or not re.fullmatch(r'[A-Za-z0-9+/=_-]+', a.args[3]):
            raise ValueError('The player server assignment is unavailable.')
        if query_tsv(f"select count(*) from dune.world_partition wp join dune.farm_state fs on fs.server_id=wp.server_id where wp.map='Survival_1' and wp.partition_id={int(a.args[2])} and wp.server_id='{a.args[3]}' and fs.ready and fs.alive;").strip() != '1':
            raise ValueError('The player must be in a ready Hagga Sietch before spawning a Tank.')
        actual = run('docker', 'inspect', '--format', '{{.Image}} {{.State.Running}}', a.args[1], capture=True).strip()
        if actual != expected + ' true':
            raise ValueError('This Hagga Sietch has not loaded the experimental Tank image yet.')
    elif a.command == 'update-guard':
        if read_state()['enabled']:
            raise ValueError('Disable Experimental Tanks in Settings before updating game-server files. The Tank patch must be verified for each new game build.')


if __name__ == '__main__':
    def interrupted(_signum, _frame):
        raise InterruptedError('The Tank operation was interrupted.')
    signal.signal(signal.SIGTERM, interrupted)
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error))

"""Install the preflighted Steam download inside the orchestrator's game volume."""
import ctypes
import os
from pathlib import Path
import sys


def install(stage, app_id):
    root = stage.parent.parent
    # Swap the entire official image set so removed/renamed tarballs cannot
    # shadow a new one. Both directories are on the same Linux volume.
    incoming = stage / 'images'
    installed = root / 'images'
    if installed.exists():
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.renameat2(-100, os.fsencode(incoming), -100, os.fsencode(installed), 2):
            raise OSError(ctypes.get_errno(), 'Could not publish staged game images')
    else:
        incoming.rename(installed)
    marker = stage / 'steamapps' / f'appmanifest_{app_id}.acf'
    for item in stage.iterdir():
        if item == incoming:
            continue
        if not item.is_dir():
            os.replace(item, root / item.name)
            continue
        for folder, _, names in os.walk(item):
            dest = root / Path(folder).relative_to(stage)
            dest.mkdir(parents=True, exist_ok=True)
            for name in names:
                source = Path(folder) / name
                if source != marker:
                    os.replace(source, dest / name)


if __name__ == '__main__':
    install(Path(sys.argv[1]), sys.argv[2])

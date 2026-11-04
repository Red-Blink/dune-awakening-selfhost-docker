"""Exact 2173753 contract for the tested Tank-only ID compatibility builder.

Native instructions, FName decoding, initialization branches and executable
padding are reviewed independently; older build contracts remain unchanged.
"""
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location('tank_scope_2173753',
    Path(__file__).resolve().parents[2] / '2141883/source/scoped_module_ids.py')
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)
engine.CLEAN_SHA = '7c2eb20335c74fa40c42d6210ac7e6a45275bec7bcb1f7b2375cdda05f0329f8'
engine.POOL = 0x16cecc40
engine.POOL_READY = 0x16cecc11
engine.CAVE = 0x14499819
engine.DECODER = 0xfa73784
engine.DECODER_BYTES = '4489f0c1e810488d0daf942707488b44c168410fb7ce0fb73c48'
engine.SITES = (
    (0xf398680, '4d8b4c24e8', '4531c99090', 'mov r10d, [r12 - 8]'),
    (0xf79261e, '488b8568ffffff', '31c09090909090', 'mov r10d, [r12]'),
    (0xf797f74, '488b4008488945b8', '31c09090488945b8', 'mov r10, r13'),
)
engine.BASE_SITES = (
    (0xd79566a, '488d3dbf92ffffe8ca812202', '909090909090909090909090'),
    (0xf3aa920, '0f8512010000', '90e912010000'),
    (0xf791fe1, '0f849d010000', 'e99e01000090'),
)
for name in ('CLEAN_SHA', 'POOL', 'POOL_READY', 'CAVE', 'DECODER',
             'DECODER_BYTES', 'SITES', 'BASE_SITES', 'assembly',
             'compile_payload', 'build'):
    globals()[name] = getattr(engine, name)

if __name__ == '__main__':
    import sys
    workspace = Path(sys.argv[1]).resolve()
    manifest = json.loads((Path(__file__).resolve().parents[1] / 'manifest.json').read_text())
    binary, manifest = build((workspace / 'server-2173753-clean').read_bytes(), manifest)
    (workspace / 'DuneSandboxServer-Linux-Shipping.2173753-scoped-candidate').write_bytes(binary)
    (workspace / 'scoped-binary-manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
    print(manifest['patchedSha256'])

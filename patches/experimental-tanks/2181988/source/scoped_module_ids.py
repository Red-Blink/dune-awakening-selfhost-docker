"""Exact 2181988 contract for the tested Tank-only ID compatibility builder.

Native instructions, FName decoding, initialization branches and executable
padding are reviewed independently; older build contracts remain unchanged.
"""
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location('tank_scope_2181988',
    Path(__file__).resolve().parents[2] / '2141883/source/scoped_module_ids.py')
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)
engine.CLEAN_SHA = '5dac1f8e3ab3972e471a981d39318cbbfdd5192078b6096635827d4bedd6189a'
engine.POOL = 0x16a74fc0
engine.POOL_READY = 0x16a74f91
engine.CAVE = 0x14228819
engine.DECODER = 0xf9c0ce4
engine.DECODER_BYTES = '4489f0c1e810488d0dcf420b07488b44c168410fb7ce0fb73c48'
engine.SITES = (
    (0xf2e32c0, '4d8b4c24e8', '4531c99090', 'mov r10d, [r12 - 8]'),
    (0xf6de02e, '488b8568ffffff', '31c09090909090', 'mov r10d, [r12]'),
    (0xf6e3984, '488b4008488945b8', '31c09090488945b8', 'mov r10, r13'),
)
engine.BASE_SITES = (
    (0xd6f0eba, '488d3dbf92ffffe8fa9d2102', '909090909090909090909090'),
    (0xf2f53f0, '0f8512010000', '90e912010000'),
    (0xf6dd9f1, '0f849d010000', 'e99e01000090'),
)
for name in ('CLEAN_SHA', 'POOL', 'POOL_READY', 'CAVE', 'DECODER',
             'DECODER_BYTES', 'SITES', 'BASE_SITES', 'assembly',
             'compile_payload', 'build'):
    globals()[name] = getattr(engine, name)

if __name__ == '__main__':
    import sys
    workspace = Path(sys.argv[1]).resolve()
    manifest = json.loads((Path(__file__).resolve().parents[1] / 'manifest.json').read_text())
    binary, manifest = build((workspace / 'server-2181988-clean').read_bytes(), manifest)
    (workspace / 'DuneSandboxServer-Linux-Shipping.2181988-scoped-candidate').write_bytes(binary)
    (workspace / 'scoped-binary-manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
    print(manifest['patchedSha256'])

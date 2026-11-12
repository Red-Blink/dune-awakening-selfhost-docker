# Regis Tanks: 2181988 Experimental Build

Rebases the r6.4 Tank-only compatibility patch onto the official 2181988 image
distributed in Steam build 26591491. The instruction generator is unchanged.
Ordinary vehicles retain their native IDs and backup/restoration paths.

The three module-ID sites, both initialization branches, overlay registration
and callback, FName decoder/globals and executable padding were independently
reviewed in the new executable. These locations retain their 2180427 addresses;
the executable and official image nevertheless have new checksums. The native
initialization field remains 0xed0. Exact clean/patched executable checksums,
image/config digests and overlay hashes are pinned; unknown inputs fail closed.
See `source/binary-site-review.json`.

The four affected stock packages were independently extracted from stock
2168446 and 2181988. All eight uasset/uexp files are byte-identical and match
the accepted 2180427 reference in `source/stock-asset-comparison.json`.
The reused overlay retains its original 2141883 filenames intentionally.

`source/scoped_module_ids.py <workspace>` consumes `server-2181988-clean` and
writes a candidate executable and generated manifest into that workspace.
Preparing an image does not enable Tanks or restart a running map. The manifest
retains `candidateOnly: true` and `gameplayVerified: false`: offline compatibility
checks do not establish in-game acceptance for every preset or persistence path.

Known pink Dart firing effects and missing firing audio remain unresolved.

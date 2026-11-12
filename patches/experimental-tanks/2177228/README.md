# Regis Tanks: 2177228 Experimental Build

Rebases the r6.4 Tank-only compatibility patch onto the official 2177228 image
distributed in Steam build 26442326. The instruction generator is unchanged.
Ordinary vehicles retain their native IDs and backup/restoration paths.

The three module-ID sites, both initialization branches, overlay registration
and callback, FName decoder/globals and executable padding were independently
located and reviewed in the new executable. Changes are not a uniform offset.
The initialization field remains 0xed0. Exact clean/patched executable checksums,
image/config digests and overlay hashes are pinned; unknown inputs fail closed.
See `source/binary-site-review.json`.

The four affected stock packages were independently extracted from stock 2168446
and 2177228. All eight uasset/uexp files are byte-identical and match the accepted
2173753 reference. `source/stock-asset-comparison.json` records their checksums.
The reused overlay retains its original 2141883 filenames intentionally.

`source/scoped_module_ids.py <workspace>` consumes `server-2177228-clean` and
writes a candidate executable and generated manifest into that workspace.
Preparing an image does not enable Tanks or restart a running map. The manifest
retains `candidateOnly: true` and `gameplayVerified: false`: offline compatibility
checks do not establish in-game acceptance for every preset or persistence path.

Known pink Dart firing effects and missing firing audio remain unresolved.

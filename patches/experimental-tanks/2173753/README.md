# Regis Tanks: 2173753 Experimental Build

Rebases the accepted 2168446 patch onto the exact official 2173753 image
distributed in Steam build 26332623. The tested r6.4 instruction generator
is unchanged: compatibility applies only to Tank module IDs. Ordinary vehicles
retain their native IDs, including the Ornithopter backup and restoration path.

The three module-ID sites, both initialization branches, overlay-loader
registration and callback, FName decoder and globals, and executable padding
were independently reviewed in the new native executable. Code sites moved
by 0x25f0, FName globals by 0x2180, and the 231-byte padding by 0x2000.
The initialization field remains 0xed0. Detours and helper references are
regenerated from the reviewed addresses. Exact clean/patched hashes and
official image/config digests are pinned; unknown builds fail closed.
See `source/binary-site-review.json`.

The four affected stock packages were independently extracted from both builds
using checksum-verified retoc 0.1.5. All eight uasset/uexp files are byte-identical
and match the accepted previous-build reference. The overlay is therefore reused
unchanged, including its original 2141883 filenames. File hashes are recorded in
`source/stock-asset-comparison.json`. No shared item registry, ordinary vehicle
backup tool, client file, or player data is modified.

`source/scoped_module_ids.py <workspace>` consumes `server-2173753-clean` and
writes the candidate executable and generated manifest into that workspace.
The manifest retains `candidateOnly: true` and `gameplayVerified: false`;
offline compatibility checks do not establish in-game acceptance for every
preset, weapon, persistence scenario, or Ornithopter backup/restoration.

Known pink Dart firing effects and missing firing audio remain unresolved.
Preparing this image does not enable Tanks or restart a running map.

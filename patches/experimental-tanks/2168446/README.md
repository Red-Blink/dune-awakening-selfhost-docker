# Regis Tanks: 2168446 Experimental Build

Rebases the accepted 2162777 patch onto the exact official 2168446 image.
The tested r6.4 instruction generator is unchanged: only Tank module IDs use
the compatibility path. Ordinary vehicles retain native IDs, including the
path used for Ornithopter backup and restoration.

All three module-ID sites, both initialization branches, the overlay-loader
registration/callback, and the native FName decoder were independently reviewed.
Module/initialization/decoder code moved back by 0x400; the loader registration
and callback moved forward by 0x60. The FName pool, ready flag and 231-byte
executable padding retain their previous addresses. The vehicle initialization
field remains at 0xed0. Detours and helper references are regenerated from these
reviewed addresses. Exact stock/patched hashes and official image/config digests
are pinned; older contracts remain unchanged and unknown builds fail closed.
See `source/binary-site-review.json`.

The four affected stock packages were independently extracted from both builds
using checksum-verified retoc 0.1.5. All eight uasset/uexp files are byte-identical,
so the overlay is reused unchanged. The comparison and file hashes are recorded
in `source/stock-asset-comparison.json`. Original 2141883 overlay filenames are
intentional. No shared item registry, vehicle backup tool, or client file is
modified.

`source/scoped_module_ids.py <workspace>` consumes `server-2168446-clean` and
writes the candidate executable and generated manifest into that workspace.
Local in-game acceptance confirmed that a Tank spawned and worked on 2168446.
This does not verify every preset, weapon, persistence scenario or Ornithopter
backup/restoration on this build. The manifest retains candidate status and
does not claim full gameplay verification.

Known pink Dart firing effects and missing firing audio remain unresolved.
No client patch is included.

Steam build 26324834 republishes the same world tag with a different image and
config digest. Both reviewed image variants are supported. The clean executable,
global metadata, and both pakchunk0 and pakchunk170 container pairs are byte-identical
to the previous build, so the instruction sites and accepted overlay are unchanged.
See `source/steam-26324834-review.json`. Unknown image digests still fail closed.
`experimental-tanks.sh prepare <reviewed-image-reference>` can prepare an isolated
staged image without changing the installed official tag or enabling Tanks.
The optional reference must resolve to one of the exact reviewed image/config IDs.

# Experimental Tanks

Opt-in, build-locked patch for **Survival_1 (all Hagga Sietches)** only.
The official image remains unchanged. Other maps use their existing image policy.

Each supported game build has its own directory here named by build number
(2134304, 2141883, 2147284, 2156652, 2160922, 2162777, 2168446), each with a
manifest that pins the official image digest and every asset hash. Only 2134304
is the original r5.8 patch; the later builds carry the r6.4 candidate patch
rebased onto each official image (`candidateOnly: true`, `gameplayVerified:
false` in their manifests). A game build with no matching manifest is treated as
unsupported: Tanks cannot be enabled until a compatible patch ships.

Settings → Experimental Features → Regis Tanks applies the image and
restarts only running Hagga maps. It creates a database safety backup and copies
their Saved folders after stopping them. Failed applications restore the previous
image policy. The apply tool does not rewrite or delete player or vehicle rows;
the unpatched game can delete unsupported Tank records when loading them.

If an apply is interrupted, the next Hagga launch clears the stale in-progress
flag under the Battlegroup lifecycle lock and uses the saved image policy.
The Settings card retains an interrupted-operation warning until Tank settings
are successfully applied again. An active apply is never cleared by a launch.
If Docker cleanup removed an unused Tank image, startup rebuilds it from the
same verified build and assets; it never silently substitutes the stock image.

The six native Tank templates are offered only when enabled. Spawning requires
an online player in a ready Hagga partition running the exact prepared image.
Every template uses Tier 6 parts: Booster or Inventory with Dart, Rocket or Flame.

Disable before a game-server update. Disabling restores the official image and
removes Tank from the spawn catalog. Existing Tanks can be deleted by the game
without the patch; do not expect them to return after re-enabling. Never reuse these binary offsets on a new
build. A new patch needs revalidated assets, clean/patched hashes and gameplay tests.

The cooked assets and six executable guards of the original 2134304 patch are from the
user-provided `tank-r5.8-docker-handoff.zip`. Each manifest pins the base digest and all asset hashes.
No old Tank proxy, generic permissions patch, shields or non-Hagga patch is applied.

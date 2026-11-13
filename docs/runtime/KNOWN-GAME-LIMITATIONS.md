# Known game limitations

## Empty buried treasure in Deep Desert

[Issue #241](https://github.com/Red-Blink/dune-awakening-selfhost-docker/issues/241)
tracks stock treasure inventories refusing loot operations. Changing
`LootRespawnSpeed` back to its default did not resolve the reporter's reproduction.

The earlier asset and native-code investigation on builds `2134304` and `2147284`
found a saving-policy conflict: `BP_LootContainer_Treasure` disables saving on its
loot inventory but does not set `m_bAllowManipulationWhenSavingDisabled`. The
inventory operation guard rejects that combination.

On November 13, 2026, the same asset was independently extracted from the official
`seabass-server:2181988-0-shipping` image with checksum-verified retoc 0.1.5 and
the previously verified Oodle decoder. Both exported files were byte-for-byte
identical to those earlier builds:

| File | SHA-256 |
| --- | --- |
| `BP_LootContainer_Treasure.uasset` | `6f5f52c820f9ef1361d26ad4942f351755cfffc4e1217e2f768a2140c862e4a8` |
| `BP_LootContainer_Treasure.uexp` | `e75a30a55aa8755ac491bf1a81df09e03fdf50f9e45dcf69ce5ae53671d3f4ad` |

This confirms that the stock asset configuration has not changed. It does not
prove that every surrounding native-code path is unchanged, or replace an
in-game test on that build. No end-to-end local storm/treasure reproduction or
safe project workaround has been verified.

Do not enable `dw.Inventory.AllowInventoryOpsIfNoPersistence=1` globally as a
project fix. It relaxes the persistence guard for other inventories as well,
including player-travel states. The narrower candidate is the existing
treasure-inventory exception, but it needs isolated testing before shipping:

1. Reproduce an empty buried chest after a storm on an affected build.
2. Change only the treasure component's exception in an isolated test asset.
3. Verify generated loot, collection, respawn, restart and save persistence.
4. Verify that normal player travel still rejects operations on stale inventories.

Until those checks pass or Funcom fixes the stock behavior, this remains an
upstream limitation rather than a completed Dune Docker fix.

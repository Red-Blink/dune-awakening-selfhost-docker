# Patch Notes v1.4.58

## Improved

- Redesigned Home around the Battlegroup state, with clearer service health, complete always-on map reporting, and status readings that refresh when the Battlegroup changes.
- Added 54 Console languages, an always-visible language selector, improved right-to-left layouts, and reliable handling of live values when switching languages.
- Added community translation suggestions with tracking IDs and context for review. Reviewed corrections are included in future Console updates.
- Restored native Halloween event settings for one party of up to four players.
- Improved Console responsiveness, log viewing, session security, and runtime credential handling while preserving existing server settings.
- Improved installation checks and Console health reporting. Fixed fresh installations using BusyBox wget, while preserving normal downloads, checksum checks, and existing-installation protection.
- Restored Web UI port selection during one-line installations. Existing Console ports and unattended installation behavior are preserved.
- Clarified Docker group instructions: setup can finish without logging out, with reconnection needed afterward to activate the new group membership.
- Updated the feature overview and added README editions in 23 languages.

## After Updating

- Restart the Battlegroup once to apply the restored Halloween event settings and runtime improvements.
- No DeepL account is needed to use the included translations or suggest corrections. Optional automatic translation requires your own provider key.

## Community Contributions

- Thanks to **@drkshrk** for the Home dashboard and complete always-on map reporting in [#273](https://github.com/Red-Blink/dune-awakening-selfhost-docker/pull/273).
- Thanks to **@dev-prophet-code** for the performance and security improvements in [#265](https://github.com/Red-Blink/dune-awakening-selfhost-docker/pull/265) and multilingual Console foundation in [#266](https://github.com/Red-Blink/dune-awakening-selfhost-docker/pull/266).

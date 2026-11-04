# Server Custom Settings

**Status:** Current | **Last Updated:** November 2026

Patch 1.5 moved the official dedicated-server difficulty controls to:

```text
runtime/game/<server>/Saved/Config/LinuxServer/ServerCustomSettings.ini
```

The game writes these files separately for each running map server. To change
one manually, stop the Battlegroup first, edit the file through the Console's
File Browser, set `DifficultyLevel=Custom`, save, and then start the
Battlegroup. Editing a running server's copy is unsafe because the game can
overwrite it while shutting down.

The Console's **Maps → Interactive Modifiers → Custom Settings** tab edits these
keys for Global, a map or a partition (chosen with its Target selector). When it
writes a map's `ServerCustomSettings.ini` it sets `DifficultyLevel=Custom`
itself, so the manual steps above apply only to hand edits.

The Console's **Building Restriction Limits** control remains supported. It
now materializes the patch-1.5 `bIsBuildingRestrictionsEnabled` key in
`ServerCustomSettings.ini` as well as retaining the legacy profile value for
older server builds. Dune Docker writes the native file after the old game
container has stopped, so the saved value survives shutdown and applies on
the next start.

Other settings already present in `ServerCustomSettings.ini` are preserved
when Dune Docker updates the managed keys.

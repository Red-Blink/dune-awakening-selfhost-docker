import test from "node:test";
import assert from "node:assert/strict";
import { unlockPlayerCustomization, playerCustomizationGrantState, giveItemToPlayer } from "../src/duneDb.js";
import { pgTransactionalDb, withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";

test("real PostgreSQL: event cosmetics unlock idempotently without inventory tokens or collateral edits", async (t) => {
  await withIsolatedDatabase(t, { namePrefix: "dune_event_cosmetics", unavailableLabel: "event cosmetic regression" }, async (pool) => {
    await pool.query(`
      create schema dune;
      create table dune.actors(id bigint primary key, class text, owner_account_id bigint, properties jsonb);
      create table dune.player_state(id bigint, player_pawn_id bigint, account_id bigint, player_controller_id bigint, online_status text);
      insert into dune.player_state values (5,123,44,55,'Offline');
    `);
    const original = {
      OtherComponent: { sentinel: true },
      CustomizationLibraryActorComponent: {
        m_UnlockedCustomizationSerializableList: { sentinel: 42, m_UnlockedCustomizationIds: [{ m_CustomizationId: "Existing", extra: true }] }
      }
    };
    await pool.query("insert into dune.actors values (123,'PlayerCharacter',44,$1)", [original]);
    const db = pgTransactionalDb(pool);
    const itemId = "Halloween2026_Radsuit_Variant";
    const results = await Promise.all([
      unlockPlayerCustomization(db, 123, { itemId }),
      unlockPlayerCustomization(db, 123, { itemId })
    ]);
    assert.deepEqual(results.map((r) => r.alreadyUnlocked).sort(), [false, true]);
    const after = (await pool.query("select properties from dune.actors where id=123")).rows[0].properties;
    assert.deepEqual(after, {
      ...original,
      CustomizationLibraryActorComponent: { m_UnlockedCustomizationSerializableList: {
        sentinel: 42, m_UnlockedCustomizationIds: [{ m_CustomizationId: "Existing", extra: true }, { m_CustomizationId: itemId }]
      } }
    });
    assert.deepEqual((await playerCustomizationGrantState(db, 123)).owned, [itemId]);
    await assert.rejects(giveItemToPlayer(db, 123, { templateId: itemId }), /Customizations/);
    await assert.rejects(unlockPlayerCustomization(db, 123, { itemId: "MTX_Unreviewed" }), /verified/);
    await pool.query("update dune.player_state set online_status='Online'");
    await assert.rejects(unlockPlayerCustomization(db, 123, { itemId: "Swatch_Halloween2026" }), /offline/);
    await pool.query("update dune.player_state set online_status='Offline'");
    for (const shape of [{}, { CustomizationLibraryActorComponent: { m_UnlockedCustomizationSerializableList: { m_UnlockedCustomizationIds: {} } } }]) {
      await pool.query("update dune.actors set properties=$1", [shape]);
      await assert.rejects(unlockPlayerCustomization(db, 123, { itemId }), /supported customization/);
      assert.deepEqual((await pool.query("select properties from dune.actors where id=123")).rows[0].properties, shape);
    }
    await pool.query("delete from dune.player_state");
    await assert.rejects(unlockPlayerCustomization(db, 123, { itemId }), /Player not found/);
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { discordPlayerLink, linkAdditionalAccount } from "../src/duneDb.js";

// FINDING-LINK-6 self-review finding: the single-link flow
// (dune.discord_player_links) and the multi-account flow
// (dune.discord_account_links) each only enforced "one Discord user per
// character" WITHIN their own table. Before otherTableLinkConflict() was
// added, a character already linked to one Discord user via one flow
// could be silently claimed by a DIFFERENT Discord user via the other
// flow, breaking the invariant both flows' documentation claims to
// enforce ("a character still belongs to exactly one Discord user, never
// shared"). Directly reproduced both directions of this gap before fixing
// it. These tests exercise the real duneDb.js functions (not the provider
// layer) against a single mock db that models BOTH tables together,
// proving the cross-table check now closes both directions.
function createCrossTableDb() {
  const state = { singleLink: null, accounts: [] };
  const player = { player_controller_id: "42", character_name: "Chani", player_pawn_id: "84", online_status: "Online" };
  const db = {
    state,
    transaction: (fn) => fn(db),
    async query(text, values = []) {
      // discordPlayerLink(): own-table conflict check
      if (text.includes("from dune.discord_player_links") && text.includes("for update")) {
        const conflict = state.singleLink && state.singleLink.playerControllerId === values[0] && state.singleLink.discordUserId !== values[1];
        return { rows: conflict ? [{ discord_user_id: state.singleLink.discordUserId }] : [], rowCount: conflict ? 1 : 0 };
      }
      if (text.includes("insert into dune.discord_player_links")) {
        state.singleLink = { discordUserId: values[0], playerControllerId: values[1] };
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("from dune.discord_player_links dpl")) {
        if (!state.singleLink || state.singleLink.discordUserId !== values[0]) return { rows: [], rowCount: 0 };
        return {
          rows: [{
            discord_user_id: state.singleLink.discordUserId,
            player_controller_id: state.singleLink.playerControllerId,
            character_name: player.character_name,
            player_pawn_id: player.player_pawn_id,
            online_status: player.online_status
          }],
          rowCount: 1
        };
      }

      // listLinkedAccounts (used internally by linkAdditionalAccount's return)
      if (text.includes("from dune.discord_account_links dal")) {
        const rows = state.accounts.filter((a) => a.discordUserId === values[0]).map((a) => ({
          discord_user_id: a.discordUserId,
          player_controller_id: a.playerControllerId,
          is_default: a.isDefault,
          character_name: player.character_name,
          player_pawn_id: player.player_pawn_id,
          online_status: player.online_status
        }));
        return { rows, rowCount: rows.length };
      }

      // linkAdditionalAccount(): own-table conflict check
      if (text.includes("from dune.discord_account_links") && text.includes("for update")) {
        const conflict = state.accounts.find((a) => a.playerControllerId === values[0] && a.discordUserId !== values[1]);
        return { rows: conflict ? [{ discord_user_id: conflict.discordUserId }] : [], rowCount: conflict ? 1 : 0 };
      }
      if (text.includes("select 1 from dune.discord_account_links") && text.includes("player_controller_id = $2")) {
        const exists = state.accounts.some((a) => a.discordUserId === values[0] && a.playerControllerId === values[1]);
        return { rows: exists ? [{}] : [], rowCount: exists ? 1 : 0 };
      }
      if (text.includes("select 1 from dune.discord_account_links where discord_user_id = $1 limit 1")) {
        const exists = state.accounts.some((a) => a.discordUserId === values[0]);
        return { rows: exists ? [{}] : [], rowCount: exists ? 1 : 0 };
      }
      if (text.includes("insert into dune.discord_account_links")) {
        state.accounts.push({ discordUserId: values[0], playerControllerId: values[1], isDefault: Boolean(values[2]) });
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${text}`);
    }
  };
  return db;
}

test("a character linked via the single-link flow cannot be claimed by a different Discord user via the multi-account flow", async () => {
  const db = createCrossTableDb();
  await discordPlayerLink(db, "discord-A", "42");
  assert.deepEqual(db.state.singleLink, { discordUserId: "discord-A", playerControllerId: "42" });

  await assert.rejects(
    () => linkAdditionalAccount(db, "discord-B", "42"),
    (error) => error.code === "character_already_linked" && error.statusCode === 409
  );
  assert.equal(db.state.accounts.length, 0, "the multi-account table must not gain a row for a character already owned elsewhere");
});

test("a character linked via the multi-account flow cannot be claimed by a different Discord user via the single-link flow", async () => {
  const db = createCrossTableDb();
  await linkAdditionalAccount(db, "discord-A", "42");
  assert.equal(db.state.accounts.length, 1);

  await assert.rejects(
    () => discordPlayerLink(db, "discord-B", "42"),
    (error) => error.code === "character_already_linked" && error.statusCode === 409
  );
  assert.equal(db.state.singleLink, null, "the single-link table must not gain a row for a character already owned elsewhere");
});

test("the SAME Discord user linking the SAME character through both flows is not blocked by the cross-table check", async () => {
  // The cross-table check only rejects a DIFFERENT discordUserId; the same
  // user re-affirming ownership of their own character through the other
  // flow is not the scenario this fix targets and must keep working.
  const db = createCrossTableDb();
  await discordPlayerLink(db, "discord-A", "42");
  const accounts = await linkAdditionalAccount(db, "discord-A", "42");
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].player_controller_id, "42");
});

test("a different character (no conflict) can still be linked normally through either flow after a cross-table check", async () => {
  const db = createCrossTableDb();
  await discordPlayerLink(db, "discord-A", "42");

  // discord-B links a DIFFERENT character (43) via the multi-account flow —
  // must succeed, since there is no actual conflict for controller 43.
  const accounts = await linkAdditionalAccount(db, "discord-B", "43");
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].player_controller_id, "43");
});

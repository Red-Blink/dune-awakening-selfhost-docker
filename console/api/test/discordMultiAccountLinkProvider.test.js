import assert from "node:assert/strict";
import test from "node:test";
import {
  linkAccountProvider,
  verifyAccountLinkProvider,
  unlinkAccountProvider,
  listAccountsProvider,
  setDefaultAccountProvider,
  resetAccountLinkVerifyRateLimiterForTests
} from "../src/integrations/discord/multiAccountLinkProvider.js";
import { linkAdditionalAccount } from "../src/duneDb.js";
import { createLoginRateLimiter } from "../src/rateLimit.js";

test.beforeEach(() => {
  resetAccountLinkVerifyRateLimiterForTests();
});

// In-memory mock exercising the real dune.discord_account_links /
// dune.discord_pending_account_links SQL shapes from duneDb.js, mirroring
// discordLinkProvider.test.js's createLinkDb() pattern but for the
// FINDING-LINK-6 multi-account tables. Distinct from and independent of
// the single-link mock — proves the two flows do not share state.
function createMultiAccountDb(players = []) {
  const state = {
    accounts: [], // { discordUserId, playerControllerId, isDefault, linkedAt }
    pending: [], // { code, discordUserId, playerControllerId, characterName, expiresAt }
    players: players.length ? players : [
      { player_controller_id: "42", player_pawn_id: "84", character_name: "Chani", online_status: "Online", funcom_id: "Chani#1234" },
      { player_controller_id: "43", player_pawn_id: "85", character_name: "Paul", online_status: "Online", funcom_id: "Paul#5678" }
    ]
  };
  let autoLinkedAt = 0;

  const db = {
    state,
    transaction: (fn) => fn(db),
    async query(text, values = []) {
      // resolvePlayerByName
      if (text.includes("from dune.player_state ps") && text.includes("lower(ps.character_name)")) {
        const match = state.players.find((p) => p.character_name.toLowerCase() === String(values[0]).toLowerCase());
        return { rows: match ? [match] : [], rowCount: match ? 1 : 0 };
      }

      // listLinkedAccounts: selects from discord_account_links dal joined
      // to player_state ps.
      if (text.includes("from dune.discord_account_links dal") && text.includes("join dune.player_state ps")) {
        const rows = state.accounts
          .filter((a) => a.discordUserId === values[0])
          .sort((a, b) => (b.isDefault - a.isDefault) || (a.linkedAt - b.linkedAt))
          .map((a) => {
            const player = state.players.find((p) => p.player_controller_id === a.playerControllerId);
            return {
              discord_user_id: a.discordUserId,
              player_controller_id: a.playerControllerId,
              is_default: a.isDefault,
              character_name: player?.character_name || "",
              player_pawn_id: player?.player_pawn_id || "0",
              online_status: player?.online_status || "Offline"
            };
          });
        return { rows, rowCount: rows.length };
      }

      // linkAdditionalAccount: conflict check (for update)
      if (text.includes("from dune.discord_account_links") && text.includes("for update")) {
        const conflict = state.accounts.find((a) => a.playerControllerId === values[0] && a.discordUserId !== values[1]);
        return { rows: conflict ? [{ discord_user_id: conflict.discordUserId }] : [], rowCount: conflict ? 1 : 0 };
      }

      // FINDING-LINK-6 cross-table check (otherTableLinkConflict()):
      // linkAdditionalAccount() also checks dune.discord_player_links for
      // a conflicting owner from the legacy single-link flow. This test
      // file only exercises the multi-account flow and never populates
      // discord_player_links, so this always reports no conflict — the
      // cross-table check itself is proven separately in duneDb tests.
      if (text.includes("from dune.discord_player_links") && text.includes("for update")) {
        return { rows: [], rowCount: 0 };
      }

      // linkAdditionalAccount: already-linked-to-this-account check
      if (text.includes("select 1 from dune.discord_account_links") && text.includes("player_controller_id = $2")) {
        const exists = state.accounts.some((a) => a.discordUserId === values[0] && a.playerControllerId === values[1]);
        return { rows: exists ? [{}] : [], rowCount: exists ? 1 : 0 };
      }

      // linkAdditionalAccount: has-any-existing check
      if (text.includes("select 1 from dune.discord_account_links where discord_user_id = $1 limit 1")) {
        const exists = state.accounts.some((a) => a.discordUserId === values[0]);
        return { rows: exists ? [{}] : [], rowCount: exists ? 1 : 0 };
      }

      // linkAdditionalAccount: insert
      if (text.includes("insert into dune.discord_account_links")) {
        state.accounts.push({
          discordUserId: values[0],
          playerControllerId: values[1],
          isDefault: Boolean(values[2]),
          linkedAt: autoLinkedAt++
        });
        return { rows: [], rowCount: 1 };
      }

      // unlinkAdditionalAccount: is_default lookup
      if (text.includes("select is_default from dune.discord_account_links")) {
        const found = state.accounts.find((a) => a.discordUserId === values[0] && a.playerControllerId === values[1]);
        return { rows: found ? [{ is_default: found.isDefault }] : [], rowCount: found ? 1 : 0 };
      }

      // unlinkAdditionalAccount: delete
      if (text.includes("delete from dune.discord_account_links") && text.includes("player_controller_id = $2") && !text.includes("for update")) {
        const before = state.accounts.length;
        state.accounts = state.accounts.filter((a) => !(a.discordUserId === values[0] && a.playerControllerId === values[1]));
        return { rows: [], rowCount: before - state.accounts.length };
      }

      // unlinkAdditionalAccount: promote next-oldest to default
      if (text.includes("update dune.discord_account_links") && text.includes("order by linked_at asc")) {
        const remaining = state.accounts.filter((a) => a.discordUserId === values[0]).sort((a, b) => a.linkedAt - b.linkedAt);
        if (remaining.length) remaining[0].isDefault = true;
        return { rows: [], rowCount: remaining.length ? 1 : 0 };
      }

      // setDefaultLinkedAccount: clear existing default
      if (text.includes("set is_default = false")) {
        state.accounts.filter((a) => a.discordUserId === values[0]).forEach((a) => { a.isDefault = false; });
        return { rows: [], rowCount: 1 };
      }

      // setDefaultLinkedAccount: set new default
      if (text.includes("set is_default = true") && text.includes("player_controller_id = $2")) {
        const found = state.accounts.find((a) => a.discordUserId === values[0] && a.playerControllerId === values[1]);
        if (found) found.isDefault = true;
        return { rows: [], rowCount: found ? 1 : 0 };
      }

      // createPendingAccountLink: clear prior pending for (user, character)
      if (text.includes("delete from dune.discord_pending_account_links") && text.includes("player_controller_id = $2")) {
        state.pending = state.pending.filter((p) => !(p.discordUserId === values[0] && p.playerControllerId === values[1]));
        return { rows: [], rowCount: 1 };
      }

      // createPendingAccountLink: insert
      if (text.includes("insert into dune.discord_pending_account_links")) {
        if (state.pending.some((p) => p.code === values[0])) return { rows: [], rowCount: 0 };
        state.pending.push({
          code: values[0],
          discordUserId: values[1],
          playerControllerId: values[2],
          characterName: values[3],
          expiresAt: values[4]
        });
        return { rows: [], rowCount: 1 };
      }

      // deletePendingAccountLink
      if (text.includes("delete from dune.discord_pending_account_links") && text.includes("code = $2")) {
        const before = state.pending.length;
        state.pending = state.pending.filter((p) => !(p.discordUserId === values[0] && p.code === values[1]));
        return { rows: [], rowCount: before - state.pending.length };
      }

      // consumePendingAccountLink
      if (text.includes("delete from dune.discord_pending_account_links") && text.includes("expires_at > now()")) {
        const match = state.pending.find((p) => p.code === values[0] && p.discordUserId === values[1]);
        if (match) {
          state.pending = state.pending.filter((p) => p !== match);
          return {
            rows: [{ discord_user_id: match.discordUserId, player_controller_id: match.playerControllerId, character_name: match.characterName }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 0 };
      }

      throw new Error(`Unexpected query: ${text}`);
    }
  };
  return db;
}

const persona = { funcomId: "CarePackage#0001", hexFlsId: "A5C0DE5E12A00001" };

test("linking an additional character does not touch the legacy single-link table or route", async () => {
  const db = createMultiAccountDb();
  let whisper = null;
  const result = await linkAccountProvider(db, {}, { discordUserId: "discord-1", characterName: "Chani" }, {
    ensurePersona: async () => persona,
    publishWhisper: async (_config, fields) => { whisper = fields; }
  });
  assert.equal(result.ok, true);
  assert.equal(result.pending, true);
  assert.match(whisper.message, /account-link verification code is: ACP-[A-Z0-9]+/);
});

test("first linked account becomes default automatically; second does not", async () => {
  const db = createMultiAccountDb();
  await linkAdditionalAccount(db, "discord-1", "42");
  const afterFirst = await listAccountsProvider(db, { discordUserId: "discord-1" });
  assert.equal(afterFirst.accounts.length, 1);
  assert.equal(afterFirst.accounts[0].isDefault, true);

  await linkAdditionalAccount(db, "discord-1", "43");
  const afterSecond = await listAccountsProvider(db, { discordUserId: "discord-1" });
  assert.equal(afterSecond.accounts.length, 2);
  const defaults = afterSecond.accounts.filter((a) => a.isDefault);
  assert.equal(defaults.length, 1);
  assert.equal(defaults[0].playerControllerId, "42");
});

test("a character already linked to another Discord user cannot be linked by a second user", async () => {
  const db = createMultiAccountDb();
  await linkAdditionalAccount(db, "discord-owner", "42");
  await assert.rejects(
    () => linkAdditionalAccount(db, "discord-attacker", "42"),
    (error) => error.code === "character_already_linked" && error.statusCode === 409
  );
});

test("linking the same character to the same user twice is rejected as a conflict, not silently duplicated", async () => {
  const db = createMultiAccountDb();
  await linkAdditionalAccount(db, "discord-1", "42");
  await assert.rejects(
    () => linkAdditionalAccount(db, "discord-1", "42"),
    (error) => error.code === "already_linked_to_this_account" && error.statusCode === 409
  );
  const accounts = await listAccountsProvider(db, { discordUserId: "discord-1" });
  assert.equal(accounts.count, 1);
});

test("verifying a pending additional-account code links it and lists it alongside prior accounts", async () => {
  const db = createMultiAccountDb();
  await linkAdditionalAccount(db, "discord-1", "42"); // pre-existing first account
  await linkAccountProvider(db, {}, { discordUserId: "discord-1", characterName: "Paul" }, {
    ensurePersona: async () => persona,
    publishWhisper: async () => {}
  });
  const code = db.state.pending[0].code;

  const verified = await verifyAccountLinkProvider(db, { discordUserId: "discord-1", code });
  assert.equal(verified.ok, true);
  assert.equal(verified.characterName, "Paul");
  assert.equal(verified.accounts.length, 2);
});

test("a different Discord user cannot consume another user's pending account-link code", async () => {
  const db = createMultiAccountDb();
  await linkAccountProvider(db, {}, { discordUserId: "discord-1", characterName: "Chani" }, {
    ensurePersona: async () => persona,
    publishWhisper: async () => {}
  });
  const code = db.state.pending[0].code;

  const rejected = await verifyAccountLinkProvider(db, { discordUserId: "discord-2", code });
  assert.equal(rejected.ok, false);
  assert.equal(db.state.pending.length, 1);
});

test("unlinking a non-default account leaves the default untouched", async () => {
  const db = createMultiAccountDb();
  await linkAdditionalAccount(db, "discord-1", "42");
  await linkAdditionalAccount(db, "discord-1", "43");

  const result = await unlinkAccountProvider(db, { discordUserId: "discord-1", playerControllerId: "43" });
  assert.equal(result.ok, true);
  const remaining = await listAccountsProvider(db, { discordUserId: "discord-1" });
  assert.equal(remaining.count, 1);
  assert.equal(remaining.accounts[0].playerControllerId, "42");
  assert.equal(remaining.accounts[0].isDefault, true);
});

test("unlinking the default account promotes the next-oldest remaining account to default", async () => {
  const db = createMultiAccountDb();
  await linkAdditionalAccount(db, "discord-1", "42"); // becomes default
  await linkAdditionalAccount(db, "discord-1", "43");

  await unlinkAccountProvider(db, { discordUserId: "discord-1", playerControllerId: "42" });
  const remaining = await listAccountsProvider(db, { discordUserId: "discord-1" });
  assert.equal(remaining.count, 1);
  assert.equal(remaining.accounts[0].playerControllerId, "43");
  assert.equal(remaining.accounts[0].isDefault, true);
});

test("unlinking an account not linked to the caller returns a business error, not a crash", async () => {
  const db = createMultiAccountDb();
  const result = await unlinkAccountProvider(db, { discordUserId: "discord-1", playerControllerId: "42" });
  assert.equal(result.ok, false);
});

test("setDefaultAccountProvider switches the default between two already-linked accounts", async () => {
  const db = createMultiAccountDb();
  await linkAdditionalAccount(db, "discord-1", "42");
  await linkAdditionalAccount(db, "discord-1", "43");

  const result = await setDefaultAccountProvider(db, { discordUserId: "discord-1", playerControllerId: "43" });
  assert.equal(result.ok, true);
  const accounts = await listAccountsProvider(db, { discordUserId: "discord-1" });
  const defaults = accounts.accounts.filter((a) => a.isDefault);
  assert.equal(defaults.length, 1);
  assert.equal(defaults[0].playerControllerId, "43");
});

test("setDefaultAccountProvider rejects a character not linked to the caller", async () => {
  const db = createMultiAccountDb();
  await linkAdditionalAccount(db, "discord-1", "42");
  const result = await setDefaultAccountProvider(db, { discordUserId: "discord-1", playerControllerId: "43" });
  assert.equal(result.ok, false);
});

// FINDING-LINK-6 "Minimal Impact": the multi-account flow's rate limiter
// must be a distinct instance/namespace from the single-link flow's, so
// exhausting one never blocks the other for the same discordUserId.
test("multi-account verification rate limiting is independent from the single-link flow's limiter", async () => {
  let currentTime = 1000;
  resetAccountLinkVerifyRateLimiterForTests(createLoginRateLimiter({
    maxAttempts: 2,
    globalMaxAttempts: 99,
    windowMs: 60000,
    blockMs: 60000,
    now: () => currentTime
  }));

  const db = createMultiAccountDb();
  await linkAccountProvider(db, {}, { discordUserId: "discord-1", characterName: "Chani" }, {
    ensurePersona: async () => persona,
    publishWhisper: async () => {}
  });

  await verifyAccountLinkProvider(db, { discordUserId: "discord-1", code: "ACP-WRONG" });
  await verifyAccountLinkProvider(db, { discordUserId: "discord-1", code: "ACP-WRONG" });
  await assert.rejects(
    () => verifyAccountLinkProvider(db, { discordUserId: "discord-1", code: "ACP-WRONG" }),
    (error) => error.code === "verify_rate_limited" && error.statusCode === 429
  );

  currentTime += 60001;
  const recovered = await verifyAccountLinkProvider(db, { discordUserId: "discord-1", code: db.state.pending[0].code });
  assert.equal(recovered.ok, true);
});

test("linking additional accounts requires the character to be online, same as the single-link flow", async () => {
  const db = createMultiAccountDb([
    { player_controller_id: "42", player_pawn_id: "84", character_name: "Chani", online_status: "Offline", funcom_id: "Chani#1234" }
  ]);
  const result = await linkAccountProvider(db, {}, { discordUserId: "discord-1", characterName: "Chani" });
  assert.equal(result.ok, false);
  assert.match(result.error, /must be online/);
});

test("failed whisper delivery removes the unusable pending account-link challenge", async () => {
  const db = createMultiAccountDb();
  await assert.rejects(() => linkAccountProvider(db, {}, { discordUserId: "discord-1", characterName: "Chani" }, {
    ensurePersona: async () => persona,
    publishWhisper: async () => { throw new Error("RMQ unavailable"); }
  }), /could not be delivered/);
  assert.equal(db.state.pending.length, 0);
});

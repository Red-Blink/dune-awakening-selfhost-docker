import assert from "node:assert/strict";
import test from "node:test";
import { linkPlayerProvider, verifyPlayerLinkProvider, resetVerifyRateLimiterForTests } from "../src/integrations/discord/linkProvider.js";
import { discordPlayerLink } from "../src/duneDb.js";
import { createLoginRateLimiter } from "../src/rateLimit.js";

test.beforeEach(() => {
  resetVerifyRateLimiterForTests();
});

function createLinkDb(playerOverrides = {}) {
  const state = {
    pending: null,
    link: null,
    player: {
      player_controller_id: "42",
      player_pawn_id: "84",
      character_name: "Chani",
      online_status: "Online",
      funcom_id: "Chani#1234",
      fls_id: "A5C0DE5E12A00042",
      ...playerOverrides
    }
  };
  const db = {
    state,
    transaction: (fn) => fn(db),
    async query(text, values = []) {
      if (text.includes("from dune.player_state ps") && text.includes("lower(ps.character_name)")) {
        return { rows: [state.player], rowCount: 1 };
      }
      if (text.includes("delete from console.discord_pending_links") && text.includes("discord_user_id = $1 and code = $2")) {
        const matches = state.pending?.discordUserId === values[0] && state.pending?.code === values[1];
        if (matches) state.pending = null;
        return { rows: [], rowCount: matches ? 1 : 0 };
      }
      if (text.includes("delete from console.discord_pending_links") && text.includes("expires_at > now()")) {
        const matches = state.pending?.code === values[0] && state.pending?.discordUserId === values[1];
        const row = matches ? {
          discord_user_id: state.pending.discordUserId,
          player_controller_id: state.pending.playerControllerId,
          character_name: state.pending.characterName
        } : null;
        if (matches) state.pending = null;
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (text.includes("delete from console.discord_pending_links") && text.includes("discord_user_id = $1")) {
        if (state.pending?.discordUserId === values[0]) state.pending = null;
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("insert into console.discord_pending_links")) {
        state.pending = {
          code: values[0],
          discordUserId: values[1],
          playerControllerId: values[2],
          characterName: values[3]
        };
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("from console.discord_player_links") && text.includes("for update")) {
        const conflict = state.link && state.link.playerControllerId === values[0] && state.link.discordUserId !== values[1];
        return { rows: conflict ? [{ discord_user_id: state.link.discordUserId }] : [], rowCount: conflict ? 1 : 0 };
      }
      // FINDING-LINK-6 cross-table check (otherTableLinkConflict()):
      // discordPlayerLink() also checks console.discord_account_links for a
      // conflicting owner. This test file only exercises the single-link
      // flow and never populates discord_account_links, so this always
      // reports no conflict.
      if (text.includes("from console.discord_account_links") && text.includes("for update")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("insert into console.discord_player_links")) {
        state.link = { discordUserId: values[0], playerControllerId: values[1] };
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("from console.discord_player_links dpl")) {
        if (!state.link || state.link.discordUserId !== values[0]) return { rows: [], rowCount: 0 };
        return {
          rows: [{
            discord_user_id: state.link.discordUserId,
            player_controller_id: state.link.playerControllerId,
            character_name: state.player.character_name,
            player_pawn_id: state.player.player_pawn_id,
            online_status: state.player.online_status
          }],
          rowCount: 1
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    }
  };
  return db;
}

const persona = { funcomId: "CarePackage#0001", hexFlsId: "A5C0DE5E12A00001" };

test("link challenge is delivered only in game and is not exposed by the API", async () => {
  const db = createLinkDb();
  let whisper = null;
  const result = await linkPlayerProvider(db, {}, { discordUserId: "discord-1", characterName: "Chani" }, {
    ensurePersona: async () => persona,
    publishWhisper: async (_config, fields) => { whisper = fields; }
  });

  assert.equal(result.ok, true);
  assert.equal(result.pending, true);
  assert.equal("code" in result, false);
  assert.doesNotMatch(result.message, /ACP-[A-Z0-9]+/);
  assert.match(whisper.message, /Discord verification code is: ACP-[A-Z0-9]+/);
  assert.equal(whisper.recipientFuncomId, "Chani#1234");
});

test("a different Discord user cannot consume another user's challenge", async () => {
  const db = createLinkDb();
  await linkPlayerProvider(db, {}, { discordUserId: "discord-1", characterName: "Chani" }, {
    ensurePersona: async () => persona,
    publishWhisper: async () => {}
  });
  const code = db.state.pending.code;

  const rejected = await verifyPlayerLinkProvider(db, { discordUserId: "discord-2", code });
  assert.equal(rejected.ok, false);
  assert.equal(db.state.pending.code, code);

  const accepted = await verifyPlayerLinkProvider(db, { discordUserId: "discord-1", code });
  assert.equal(accepted.ok, true);
  assert.equal(db.state.pending, null);
  assert.deepEqual(db.state.link, { discordUserId: "discord-1", playerControllerId: "42" });
});

// FINDING-LINK-3 (docs/security/discord-player-link-hardening.md): repeated
// wrong-code guesses against one discordUserId must be throttled and
// eventually locked out, rather than allowed indefinitely.
test("repeated wrong-code verification attempts for one discordUserId are rate limited", async () => {
  let currentTime = 1000;
  resetVerifyRateLimiterForTests(createLoginRateLimiter({
    maxAttempts: 3,
    globalMaxAttempts: 99,
    windowMs: 60000,
    blockMs: 60000,
    now: () => currentTime
  }));

  const db = createLinkDb();
  await linkPlayerProvider(db, {}, { discordUserId: "discord-1", characterName: "Chani" }, {
    ensurePersona: async () => persona,
    publishWhisper: async () => {}
  });

  // Three wrong guesses consume the allowance...
  for (let i = 0; i < 3; i += 1) {
    const attempt = await verifyPlayerLinkProvider(db, { discordUserId: "discord-1", code: "ACP-WRONG" });
    assert.equal(attempt.ok, false);
  }

  // ...and the fourth is rejected before it ever reaches the database,
  // even though the real pending code is still valid and unexpired.
  const realCode = db.state.pending.code;
  await assert.rejects(
    () => verifyPlayerLinkProvider(db, { discordUserId: "discord-1", code: realCode }),
    (error) => error.code === "verify_rate_limited" && error.statusCode === 429
  );
  assert.ok(db.state.pending, "the real pending link must survive a rate-limited attempt, not be consumed");

  // After the block window elapses, a correct guess succeeds again.
  currentTime += 60001;
  const recovered = await verifyPlayerLinkProvider(db, { discordUserId: "discord-1", code: realCode });
  assert.equal(recovered.ok, true);
});

test("rate limiting is scoped per discordUserId — one user's lockout does not block another", async () => {
  let currentTime = 1000;
  resetVerifyRateLimiterForTests(createLoginRateLimiter({
    maxAttempts: 2,
    globalMaxAttempts: 99,
    windowMs: 60000,
    blockMs: 60000,
    now: () => currentTime
  }));

  const db = createLinkDb();
  await linkPlayerProvider(db, {}, { discordUserId: "discord-1", characterName: "Chani" }, {
    ensurePersona: async () => persona,
    publishWhisper: async () => {}
  });

  await verifyPlayerLinkProvider(db, { discordUserId: "discord-1", code: "ACP-WRONG" });
  await verifyPlayerLinkProvider(db, { discordUserId: "discord-1", code: "ACP-WRONG" });
  await assert.rejects(
    () => verifyPlayerLinkProvider(db, { discordUserId: "discord-1", code: "ACP-WRONG" }),
    (error) => error.code === "verify_rate_limited"
  );

  // A different discordUserId with no pending link of their own is still
  // allowed to attempt verification (and correctly gets a normal
  // "invalid or expired" business result, not a 429).
  const other = await verifyPlayerLinkProvider(db, { discordUserId: "discord-2", code: "ACP-WRONG" });
  assert.equal(other.ok, false);
  assert.match(other.error, /Invalid or expired/i);
});

test("a successful verification clears the rate-limit lockout for that discordUserId", async () => {
  resetVerifyRateLimiterForTests(createLoginRateLimiter({
    maxAttempts: 2,
    globalMaxAttempts: 99,
    windowMs: 60000,
    blockMs: 60000
  }));

  const db = createLinkDb();
  await linkPlayerProvider(db, {}, { discordUserId: "discord-1", characterName: "Chani" }, {
    ensurePersona: async () => persona,
    publishWhisper: async () => {}
  });
  const code = db.state.pending.code;

  await verifyPlayerLinkProvider(db, { discordUserId: "discord-1", code: "ACP-WRONG" });
  const accepted = await verifyPlayerLinkProvider(db, { discordUserId: "discord-1", code });
  assert.equal(accepted.ok, true);

  // Re-link and verify again immediately — the earlier successful
  // verification should have reset this discordUserId's failure count,
  // not left it one attempt away from lockout.
  await unlinkAndRelink(db);
  const secondCode = db.state.pending.code;
  const secondAttempt = await verifyPlayerLinkProvider(db, { discordUserId: "discord-1", code: secondCode });
  assert.equal(secondAttempt.ok, true);
});

async function unlinkAndRelink(db) {
  db.state.link = null;
  db.state.pending = null;
  await linkPlayerProvider(db, {}, { discordUserId: "discord-1", characterName: "Chani" }, {
    ensurePersona: async () => persona,
    publishWhisper: async () => {}
  });
}

test("failed whisper delivery removes the unusable pending challenge", async () => {
  const db = createLinkDb();
  await assert.rejects(() => linkPlayerProvider(db, {}, { discordUserId: "discord-1", characterName: "Chani" }, {
    ensurePersona: async () => persona,
    publishWhisper: async () => { throw new Error("RMQ unavailable"); }
  }), /could not be delivered/);
  assert.equal(db.state.pending, null);
});

test("offline characters cannot start ownership verification", async () => {
  const db = createLinkDb({ online_status: "Offline" });
  const result = await linkPlayerProvider(db, {}, { discordUserId: "discord-1", characterName: "Chani" });
  assert.equal(result.ok, false);
  assert.match(result.error, /must be online/);
  assert.equal(db.state.pending, null);
});

test("linking never removes a character's existing Discord owner", async () => {
  const db = createLinkDb();
  db.state.link = { discordUserId: "discord-owner", playerControllerId: "42" };
  await assert.rejects(
    () => discordPlayerLink(db, "discord-attacker", "42"),
    (error) => error.code === "character_already_linked" && error.statusCode === 409
  );
  assert.deepEqual(db.state.link, { discordUserId: "discord-owner", playerControllerId: "42" });
});

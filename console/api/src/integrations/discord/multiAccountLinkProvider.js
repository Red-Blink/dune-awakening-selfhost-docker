// Multi-account player linking — FINDING-LINK-6
// (docs/security/discord-player-link-hardening.md).
//
// Independent of linkProvider.js's single-link flow (dune.discord_player_links,
// unique on discord_user_id alone — one linked character per Discord user,
// globally, with silent overwrite on re-link). This module lets one Discord
// user link multiple accounts/characters via dune.discord_account_links
// (unique on (discord_user_id, player_controller_id), with
// player_controller_id still unique on its own so a character never belongs
// to more than one Discord user).
//
// Both flows coexist by design — see migrateDiscordAdapterSchema()'s
// comment in duneDb.js. This module does not replace or migrate data from
// the single-link table.
//
// Verification reuses the exact same whisper-based, online-character-only
// flow as linkProvider.js: each additional account still requires its own
// in-game verification code delivered to that specific character, so a
// Discord user cannot bulk-link accounts they don't actually control.

import { randomInt } from "node:crypto";
import {
  listLinkedAccounts,
  linkAdditionalAccount,
  unlinkAdditionalAccount,
  setDefaultLinkedAccount,
  resolvePlayerByName,
  createPendingAccountLink,
  deletePendingAccountLink,
  consumePendingAccountLink
} from "../../duneDb.js";
import { policyError } from "./policy.js";
import { publishCarePackageWhisper } from "../../rmq.js";
import { ensureCarePackageServerPersona } from "../../carePackage.js";
import { createLoginRateLimiter } from "../../rateLimit.js";

const CODE_LENGTH = 6;
const CODE_EXPIRY_MINUTES = 5;

function generateVerificationCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "ACP-";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += chars[randomInt(0, chars.length)];
  }
  return code;
}

function expiresAtMinutes(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

// Verification-attempt rate limiting, mirroring linkProvider.js's
// verifyRateLimiter — same shape, same defaults, but a SEPARATE limiter
// instance and SEPARATE env var namespace, so tuning/testing one flow's
// rate limits never affects the other's, and a lockout on the single-link
// flow doesn't accidentally exempt or block the multi-account flow for the
// same discordUserId.
const DEFAULT_VERIFY_MAX_ATTEMPTS = 5;
const DEFAULT_VERIFY_GLOBAL_MAX_ATTEMPTS = 50;
const DEFAULT_VERIFY_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_VERIFY_BLOCK_MS = 15 * 60 * 1000;

function envInt(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function createVerifyRateLimiter() {
  return createLoginRateLimiter({
    maxAttempts: envInt("DUNE_DISCORD_ACCOUNT_LINK_VERIFY_MAX_ATTEMPTS", DEFAULT_VERIFY_MAX_ATTEMPTS),
    globalMaxAttempts: envInt("DUNE_DISCORD_ACCOUNT_LINK_VERIFY_GLOBAL_MAX_ATTEMPTS", DEFAULT_VERIFY_GLOBAL_MAX_ATTEMPTS),
    windowMs: envInt("DUNE_DISCORD_ACCOUNT_LINK_VERIFY_WINDOW_MS", DEFAULT_VERIFY_WINDOW_MS),
    blockMs: envInt("DUNE_DISCORD_ACCOUNT_LINK_VERIFY_BLOCK_MS", DEFAULT_VERIFY_BLOCK_MS)
  });
}

let verifyRateLimiter = createVerifyRateLimiter();

export function resetAccountLinkVerifyRateLimiterForTests(customLimiter) {
  verifyRateLimiter = customLimiter || createVerifyRateLimiter();
}

export async function linkAccountProvider(db, config, { discordUserId, characterName }, dependencies = {}) {
  if (!characterName || !String(characterName).trim()) {
    throw policyError("invalid_request", "characterName is required.");
  }

  const trimmedName = String(characterName).trim();
  const matches = await resolvePlayerByName(db, trimmedName);

  if (matches.length === 0) {
    return { ok: false, error: `No player found matching "${trimmedName}".` };
  }
  if (matches.length > 1) {
    const names = matches.map((r) => r.character_name).join(", ");
    return { ok: false, error: `Multiple players found: ${names}. Be more specific.`, candidates: matches };
  }

  const player = matches[0];
  if (player.online_status !== "Online") {
    return { ok: false, error: `${player.character_name} must be online to receive the private verification code.` };
  }
  if (!player.funcom_id) {
    return { ok: false, error: `No active Funcom identity was found for ${player.character_name}. Reconnect in game and try again.` };
  }

  let code = "";
  const expires = expiresAtMinutes(CODE_EXPIRY_MINUTES);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = generateVerificationCode();
    if (await createPendingAccountLink(db, discordUserId, player.player_controller_id, player.character_name, candidate, expires)) {
      code = candidate;
      break;
    }
  }
  if (!code) {
    return { ok: false, error: `A verification request is already pending for ${player.character_name}. Wait five minutes and try again.` };
  }

  const publishWhisper = dependencies.publishWhisper || publishCarePackageWhisper;
  const ensurePersona = dependencies.ensurePersona || ensureCarePackageServerPersona;
  try {
    const persona = await ensurePersona(db);
    await publishWhisper(config, {
      recipientFuncomId: player.funcom_id,
      recipientCharacterName: player.character_name,
      senderFuncomId: persona.funcomId,
      senderHexFlsId: persona.hexFlsId,
      senderDisplayName: "Dune Docker Console",
      message: `Your Discord account-link verification code is: ${code}. Use /dune data link-verify followed by this code to add this character to your linked accounts.`
    });
  } catch (error) {
    await deletePendingAccountLink(db, discordUserId, code);
    throw policyError("verification_delivery_failed", "The in-game verification whisper could not be delivered. Try again while the character is online.", 503);
  }

  return {
    ok: true,
    pending: true,
    characterName: player.character_name,
    expiresInSeconds: CODE_EXPIRY_MINUTES * 60,
    message: "A private verification code was sent in game. Use /dune data link-verify followed by that code within five minutes."
  };
}

export async function verifyAccountLinkProvider(db, { discordUserId, code }) {
  if (!code || !String(code).trim()) {
    throw policyError("invalid_request", "code is required.");
  }

  const rateLimitKey = String(discordUserId || "");
  const rateLimit = verifyRateLimiter.check(rateLimitKey);
  if (!rateLimit.allowed) {
    throw policyError(
      "verify_rate_limited",
      `Too many verification attempts. Wait ${rateLimit.retryAfterSeconds}s, then try /dune data link <character> again for a new code.`,
      429
    );
  }

  const pending = await consumePendingAccountLink(db, discordUserId, String(code).trim().toUpperCase());

  if (!pending) {
    verifyRateLimiter.recordFailure(rateLimitKey);
    return { ok: false, error: "Invalid or expired verification code. Use /dune data link <character> to generate a new one." };
  }

  const accounts = await linkAdditionalAccount(db, discordUserId, pending.player_controller_id);
  verifyRateLimiter.recordSuccess(rateLimitKey);

  return {
    ok: true,
    linked: true,
    characterName: pending.character_name,
    accounts: accounts.map(publicAccountView),
    message: `Successfully linked ${pending.character_name} to your Discord account. Use /dune data accounts to see all linked characters.`
  };
}

export async function unlinkAccountProvider(db, { discordUserId, playerControllerId }) {
  if (!playerControllerId || !String(playerControllerId).trim()) {
    throw policyError("invalid_request", "playerControllerId is required.");
  }
  const removed = await unlinkAdditionalAccount(db, discordUserId, String(playerControllerId).trim());
  if (!removed) {
    return { ok: false, error: "No matching linked account was found for that character." };
  }
  return { ok: true, message: "Unlinked." };
}

export async function listAccountsProvider(db, { discordUserId }) {
  const accounts = await listLinkedAccounts(db, discordUserId);
  return {
    ok: true,
    accounts: accounts.map(publicAccountView),
    count: accounts.length
  };
}

export async function setDefaultAccountProvider(db, { discordUserId, playerControllerId }) {
  if (!playerControllerId || !String(playerControllerId).trim()) {
    throw policyError("invalid_request", "playerControllerId is required.");
  }
  const found = await setDefaultLinkedAccount(db, discordUserId, String(playerControllerId).trim());
  if (!found) {
    return { ok: false, error: "That character is not linked to your Discord account. Link it first with /dune data link." };
  }
  return { ok: true, message: "Default character updated." };
}

function publicAccountView(account) {
  return {
    playerControllerId: account.player_controller_id,
    characterName: account.character_name,
    isDefault: Boolean(account.is_default),
    onlineStatus: account.online_status
  };
}

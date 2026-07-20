import { randomInt } from "node:crypto";
import {
  getLinkedPlayer,
  discordPlayerLink,
  discordPlayerUnlink,
  resolvePlayerByName,
  createPendingLink,
  deletePendingLink,
  consumePendingLink
} from "../../duneDb.js";
import { policyError } from "./policy.js";
import { publishCarePackageWhisper } from "../../rmq.js";
import { ensureCarePackageServerPersona } from "../../carePackage.js";

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

export async function linkPlayerProvider(db, config, { discordUserId, characterName }, dependencies = {}) {
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
    if (await createPendingLink(db, discordUserId, player.player_controller_id, player.character_name, candidate, expires)) {
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
      message: `Your Discord verification code is: ${code}. Use /dune data verify followed by this code to link your character.`
    });
  } catch (error) {
    await deletePendingLink(db, discordUserId, code);
    throw policyError("verification_delivery_failed", "The in-game verification whisper could not be delivered. Try again while the character is online.", 503);
  }

  return {
    ok: true,
    pending: true,
    characterName: player.character_name,
    expiresInSeconds: CODE_EXPIRY_MINUTES * 60,
    message: "A private verification code was sent in game. Use /dune data verify followed by that code within five minutes."
  };
}

export async function verifyPlayerLinkProvider(db, { discordUserId, code }) {
  if (!code || !String(code).trim()) {
    throw policyError("invalid_request", "code is required.");
  }

  const pending = await consumePendingLink(db, discordUserId, String(code).trim().toUpperCase());

  if (!pending) {
    return { ok: false, error: "Invalid or expired verification code. Use /dune data link <character> to generate a new one." };
  }

  await discordPlayerLink(db, discordUserId, pending.player_controller_id);
  const linked = await getLinkedPlayer(db, discordUserId);

  return {
    ok: true,
    linked: true,
    characterName: linked.character_name,
    controllerId: pending.player_controller_id,
    pawnId: linked.player_pawn_id,
    message: `Successfully linked as ${linked.character_name}. Use /dune data inventory to view your inventory.`
  };
}

export async function unlinkProvider(db, { discordUserId }) {
  await discordPlayerUnlink(db, discordUserId);
  return { ok: true, message: "Unlinked." };
}

export async function whoamiProvider(db, { discordUserId }) {
  const linked = await getLinkedPlayer(db, discordUserId);
  if (!linked) {
    return { ok: true, linked: false, message: "Not linked. Use /dune data link <character-name>" };
  }
  return {
    ok: true,
    linked: true,
    characterName: linked.character_name,
    controllerId: linked.player_controller_id,
    pawnId: linked.player_pawn_id,
    onlineStatus: linked.online_status
  };
}

export async function requireLinkedPlayer(db, discordUserId) {
  const linked = await getLinkedPlayer(db, discordUserId);
  if (!linked) {
    throw policyError("not_linked", "Not linked to a game character. Use /dune data link <name> first.", 403);
  }
  return linked;
}

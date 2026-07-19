import { randomInt } from "node:crypto";
import {
  discordPlayerLinksTableCreate,
  discordPendingLinksTableCreate,
  getLinkedPlayer,
  discordPlayerLink,
  discordPlayerUnlink,
  resolvePlayerByName,
  createPendingLink,
  consumePendingLink
} from "../../duneDb.js";
import { policyError } from "./policy.js";
import { publishCarePackageWhisper } from "../../rmq.js";

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

export async function linkPlayerProvider(db, config, { discordUserId, characterName }) {
  await discordPlayerLinksTableCreate(db);
  await discordPendingLinksTableCreate(db);

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
  const code = generateVerificationCode();
  const expires = expiresAtMinutes(CODE_EXPIRY_MINUTES);

  await createPendingLink(
    db,
    discordUserId,
    player.player_controller_id,
    player.character_name,
    "",
    "",
    code,
    expires
  );

  if (player.funcom_id && player.fls_id) {
    try {
      await publishCarePackageWhisper(config, {
        recipientFuncomId: player.funcom_id,
        recipientCharacterName: player.character_name,
        senderFuncomId: "ACP#0001",
        senderDisplayName: "ACP",
        message: `Your ACP verification code is: ${code}. Use /dune data verify ${code} to link your character.`
      });
    } catch (err) {
      console.error("Failed to send verification whisper:", err.message);
    }
  }

  return {
    ok: true,
    pending: true,
    code,
    characterName: player.character_name,
    message: `Verification code generated. Check in-game whispers for your code, then use /dune data verify ${code} to complete linking.`
  };
}

export async function verifyPlayerLinkProvider(db, { discordUserId, code }) {
  await discordPlayerLinksTableCreate(db);
  await discordPendingLinksTableCreate(db);

  if (!code || !String(code).trim()) {
    throw policyError("invalid_request", "code is required.");
  }

  const pending = await consumePendingLink(db, String(code).trim().toUpperCase());

  if (!pending) {
    return { ok: false, error: "Invalid or expired verification code. Use /dune data link <character> to generate a new one." };
  }

  if (pending.discord_user_id !== discordUserId) {
    return { ok: false, error: "This verification code belongs to a different Discord user." };
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
  await discordPlayerLinksTableCreate(db);
  await discordPlayerUnlink(db, discordUserId);
  return { ok: true, message: "Unlinked." };
}

export async function whoamiProvider(db, { discordUserId }) {
  await discordPlayerLinksTableCreate(db);
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
  await discordPlayerLinksTableCreate(db);
  const linked = await getLinkedPlayer(db, discordUserId);
  if (!linked) {
    throw policyError("not_linked", "Not linked to a game character. Use /dune data link <name> first.", 403);
  }
  return linked;
}

import {
  discordPlayerLinksTableCreate,
  getLinkedPlayer,
  discordPlayerLink,
  discordPlayerUnlink,
  resolvePlayerByName
} from "../../duneDb.js";
import { policyError } from "./policy.js";

export async function linkPlayerProvider(db, { discordUserId, characterName }) {
  await discordPlayerLinksTableCreate(db);
  if (!characterName || !String(characterName).trim()) {
    throw policyError("invalid_request", "characterName is required to link a player.");
  }
  const player = await resolvePlayerByName(db, String(characterName).trim());
  if (!player) {
    throw policyError("not_found", `No player found with character name: ${characterName}`, 404);
  }
  const linked = await discordPlayerLink(db, discordUserId, player.player_controller_id);
  return { ok: true, player, linked };
}

export async function unlinkProvider(db, { discordUserId }) {
  await discordPlayerLinksTableCreate(db);
  const removed = await discordPlayerUnlink(db, discordUserId);
  return { ok: true, unlinked: removed };
}

export async function whoamiProvider(db, { discordUserId }) {
  await discordPlayerLinksTableCreate(db);
  const player = await getLinkedPlayer(db, discordUserId);
  if (!player) {
    return { ok: true, linked: false, player: null };
  }
  return { ok: true, linked: true, player };
}

export async function requireLinkedPlayer(db, discordUserId) {
  await discordPlayerLinksTableCreate(db);
  const player = await getLinkedPlayer(db, discordUserId);
  if (!player) {
    throw policyError("not_linked", "Your Discord account is not linked to a game character. Use /dune link <characterName> first.", 403);
  }
  return player;
}

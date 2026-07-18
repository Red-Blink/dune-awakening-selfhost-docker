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
    throw policyError("invalid_request", "characterName is required.");
  }
  const matches = await resolvePlayerByName(db, String(characterName).trim());
  if (matches.length === 0) {
    return { ok: false, error: `No player found matching "${characterName}".` };
  }
  if (matches.length > 1) {
    const names = matches.map((r) => r.character_name).join(", ");
    return { ok: false, error: `Multiple players found: ${names}. Be more specific.`, candidates: matches };
  }
  const match = matches[0];
  await discordPlayerLink(db, discordUserId, match.player_controller_id);
  const linked = await getLinkedPlayer(db, discordUserId);
  return {
    ok: true,
    linked: linked.character_name,
    controllerId: match.player_controller_id,
    characterName: linked.character_name,
    pawnId: linked.player_pawn_id,
    message: `Linked as ${linked.character_name}. Use /dune data inventory to view your inventory.`
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

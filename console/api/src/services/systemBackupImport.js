import { closeSync, openSync, readSync } from "node:fs";

// Reading an uploaded system backup: what it is, what it should be called, and
// what its sidecar should say. Kept apart from systemBackups.js, which answers
// "what is already on this host".

// A gpg --symmetric stream opens with a symmetric-key-encrypted-session-key
// packet. Measured against real backup_system output (gpg 2.4.7), the first six
// bytes are 8c 4d 05 09 02 03 across every size and passphrase:
//
//   8c  old-format CTB, tag 3      4d  packet length
//   05  SKESK version 5            09  cipher 9 = AES256
//   02  aead 2 = OCB               03  s2k mode 3
//
// 0x8c is OLD-format framing, not the new-format 0xc3 one might assume from the
// spec, so the tag is parsed out of the CTB rather than compared to a magic
// byte. Accepting any version >= 5 with a non-zero aead keeps a future v6 SKESK
// working instead of pinning today's exact bytes.
export function readEncryptedArchiveHeader(head) {
  if (!head || head.length < 6) return { ok: false, reason: "The file is too short to be an encrypted archive." };

  const ctb = head[0];
  if ((ctb & 0x80) === 0) return { ok: false, reason: "That file is not an OpenPGP message." };

  let tag;
  let headerLength;
  if (ctb & 0x40) {
    tag = ctb & 0x3f;
    const first = head[1];
    headerLength = first < 192 ? 2 : first < 224 ? 3 : first === 255 ? 6 : 2;
  } else {
    tag = (ctb >> 2) & 0x0f;
    headerLength = [2, 3, 5, 1][ctb & 0x03];
  }
  if (tag !== 3) return { ok: false, reason: "That file is not a passphrase-encrypted OpenPGP message." };

  const version = head[headerLength];
  const cipher = head[headerLength + 1];
  // AEAD only exists from SKESK v5 on; v4 has s2k where v5 has the aead byte.
  const aead = version >= 5 ? head[headerLength + 2] : 0;
  if (version < 5 || aead === 0) {
    return { ok: false, reason: "That archive is not authenticated (AEAD). System backups are always AES-256-OCB." };
  }
  return {
    ok: true,
    version,
    cipher,
    aead,
    encryption: cipher === 9 && aead === 2 ? "aes-256-ocb-gpg-aead" : `cipher-${cipher}-aead-${aead}`
  };
}

export function looksLikeTar(head) {
  return Boolean(head) && head.length >= 263 && head.subarray(257, 262).toString("binary") === "ustar";
}

function tarField(block, offset, length) {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
}

// Indexes members without reading their content: an entry is a 512-byte header
// followed by its bytes padded to the next block, so each member's offset and
// size are enough to stream it out later. A multi-gigabyte archive is never held
// in memory, here or anywhere else on this path.
export function readTarMemberIndex(filePath) {
  const fd = openSync(filePath, "r");
  const members = [];
  try {
    const block = Buffer.alloc(512);
    let offset = 0;
    for (;;) {
      if (readSync(fd, block, 0, 512, offset) < 512) break;
      if (block.every((byte) => byte === 0)) break;
      const name = tarField(block, 0, 100);
      const prefix = tarField(block, 345, 155);
      const size = Number.parseInt(tarField(block, 124, 12).trim(), 8);
      if (!name || !Number.isInteger(size) || size < 0) break;
      members.push({ name: prefix ? `${prefix}/${name}` : name, size, start: offset + 512 });
      offset += 512 + size + ((512 - (size % 512)) % 512);
    }
  } finally {
    closeSync(fd);
  }
  return members;
}

export function mintSystemBackupName(now = new Date(), pid = process.pid) {
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  // Same shape db.sh mints, so everything that validates the name keeps working.
  return `dune-system-${stamp}-${pid}-${Math.floor(Math.random() * 32768)}.tar.gz.enc`;
}

const SCALAR_LINE = /^([A-Za-z0-9_.-]+):(.*)$/;

// Rewrites only the keys this cares about and passes every other line through
// untouched. It deliberately does NOT round-trip through a parse/stringify pair
// the way normalizeImportedBackupMetadata does: the system sidecar carries
// `decrypt_note: >-` and `decrypt_command: |-` block scalars whose indented
// continuation lines are not `key: value`, and a rebuild from parsed keys drops
// them -- taking the decrypt instructions with them, which are the most useful
// thing in the file on a host that has no console yet.
export function normalizeImportedSystemMetadata(content, { importedFrom = "", now = new Date() } = {}) {
  const lines = String(content || "").split(/\r?\n/);
  const kept = [];
  let sawOrigin = false;
  for (const line of lines) {
    const match = line.match(SCALAR_LINE);
    const key = match?.[1];
    if (key === "backup_origin") {
      kept.push("backup_origin: external");
      sawOrigin = true;
      continue;
    }
    if (key === "imported_at" || key === "imported_from") continue;
    kept.push(line);
  }
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  if (!sawOrigin) kept.push("backup_origin: external");
  kept.push(`imported_at: ${now.toISOString()}`);
  if (importedFrom) kept.push(`imported_from: ${importedFrom}`);
  return `${kept.join("\n")}\n`;
}

// Used when an archive arrives without its sidecar. Every field is either known
// or omitted: encryption is read from the archive's own SKESK packet rather than
// copied from the writer's template, and nothing is invented to fill a column.
export function synthesizeSystemMetadata({ archiveName, importedFrom = "", encryption = "", now = new Date() }) {
  const lines = [
    `artifact_id: ${archiveName.replace(/\.tar\.gz\.enc$/, "")}`,
    `backup_file: ${archiveName}`,
    "backup_origin: external",
    `imported_at: ${now.toISOString()}`
  ];
  if (encryption) lines.push(`encryption: ${encryption}`);
  if (importedFrom) lines.push(`imported_from: ${importedFrom}`);
  lines.push("includes_secrets: true");
  // Deliberately absent: created_at, server_title, battlegroup_id. They live in
  // the sidecar this upload did not have, and guessing them would put invented
  // values in columns an operator reads as fact.
  return `${lines.join("\n")}\n`;
}

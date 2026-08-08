export type SietchRow = {
  partitionId: string;
  // False when the `--ids` output ran out and partitionId fell back to the
  // dimension index. A dimension index is only unique *within one map*, so a
  // caller pooling rows from several maps (BasesPanel) must drop these rather
  // than key on them -- otherwise DeepDesert_1's dimension 1 answers to the
  // lookup for Survival_1's partition 1 and labels a Hagga Basin base
  // "Deep Desert PvE".
  partitionIdFromIds: boolean;
  dimension: string;
  displayName: string;
  password: string;
  passwordSet: boolean;
  active: boolean;
};

// Whether a row may be used as the target of a write (rename, set password,
// save settings, restart). Only rows whose partition id really came from the
// `--ids` output qualify: a row that fell back to its dimension index would
// send that index as a partition id and land on whichever partition happens to
// carry the same number, so renaming dimension 1 would rename partition 1.
// Reads are unaffected -- a fallback row still renders, it just cannot be
// written to.
export function isSietchWriteTarget(row: SietchRow) {
  return row.partitionIdFromIds;
}

// Parses the fixed-width table `dune sietches dimensions <map>` prints, pairing
// each row with the partition id at the same index from the `--ids` output:
//
//   DIMENSION  DISPLAY NAME      PASSWORD        ids
//   0          Deep Desert PvP   (unset)         8
//   1          Deep Desert PvE   (unset)         59
//
// Display names are operator-chosen and arbitrary -- "Awesome Map" and
// "The Kulon Show" are real -- so nothing here may assume a "Sietch " prefix.
// Lives in its own module rather than in MapsPanel so the Bases panel can label
// map instances without pulling that whole lazily-loaded chunk in with it.
export function parseSietchRows(text: string, idsText = ""): SietchRow[] {
  const rows: SietchRow[] = [];
  const ids = idsText.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\d+$/.test(line));
  let dimensionIndex = 0;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*DIMENSION\b/i.test(line)) continue;
    const tableMatch = line.match(/^\s*(\d+)\s+(.+?)\s+(\((?:un)?set\))\s*$/i);
    if (tableMatch) {
      const dimension = tableMatch[1];
      const partitionId = ids[dimensionIndex] || dimension;
      const displayName = tableMatch[2].trim();
      const passwordSet = /^\(set\)$/i.test(tableMatch[3]);
      rows.push({
        partitionId,
        partitionIdFromIds: Boolean(ids[dimensionIndex]),
        dimension,
        displayName,
        password: "",
        passwordSet,
        active: true
      });
      dimensionIndex += 1;
      continue;
    }
    const partitionMatch = line.match(/\b(?:partition|id)\s*[:=]?\s*(\d+)\b/i) || line.match(/^\s*(\d+)\s+/);
    if (!partitionMatch) continue;
    const dimension = partitionMatch[1];
    const partitionId = ids[dimensionIndex] || partitionMatch[1];
    const displayName = (line.match(/\b(?:display|name)\s*[:=]\s*([^|,\t]+)/i)?.[1] || line.match(/\bSietch\s+([A-Za-z0-9 _-]+)/i)?.[0] || `Sietch ${partitionId}`).trim();
    const passwordValue = (line.match(/\bpassword\s*[:=]\s*([^|,\t]+)/i)?.[1] || line.match(/\((?:un)?set\)\s*$/i)?.[0] || "").trim();
    const passwordSet = /\(set\)|\bset\b|true|yes/i.test(passwordValue) || /\(set\)\s*$/i.test(line);
    const password = /\(set\)|\(unset\)|\bset\b|\bunset\b/i.test(passwordValue) ? "" : passwordValue;
    const active = !/\binactive|disabled|stopped\b/i.test(line);
    rows.push({
      partitionId,
      partitionIdFromIds: Boolean(ids[dimensionIndex]),
      dimension,
      displayName,
      password,
      passwordSet: passwordSet || Boolean(password),
      active
    });
    dimensionIndex += 1;
  }
  const unique = new globalThis.Map<string, SietchRow>();
  for (const row of rows) unique.set(row.partitionId, row);
  return [...unique.values()].sort((a, b) => Number(a.dimension) - Number(b.dimension));
}

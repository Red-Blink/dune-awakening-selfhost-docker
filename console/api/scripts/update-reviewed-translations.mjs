// Explicit maintenance operation: never called by the server or CI. Only
// immutable, repository-reviewed UI phrases can leave this process.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callNeuralFallbackBatch, getReviewedSourcePhrases, isSafeReviewedTranslation, SUPPORTED_LANGUAGES } from "../src/services/i18nService.js";

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/i18n-translations-db.json");
const brands = new Set(["Dune Docker Console", "Dune-Docker Peer Mesh", "Dune: Awakening", "BattlEye Anti-Cheat", "FluffyFox Ascension", "Regis Tanks", "Hagga Basin", "Deep Desert"]);
export function needsTranslation(source, translated) {
  return !translated || (source === translated && source.length > 15 && source.includes(" ") && !brands.has(source));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes("--apply")) throw new Error("Pass --apply to explicitly translate reviewed static UI phrases and update the bundled catalog.");
  const db = JSON.parse(fs.readFileSync(file, "utf8"));
  const reviewed = getReviewedSourcePhrases();
  const selected = process.argv.find(arg => arg.startsWith("--language="))?.split("=")[1]?.toUpperCase();
  const languages = SUPPORTED_LANGUAGES.filter(lang => lang.code !== "EN" && (!selected || lang.code === selected));
  if (!languages.length) throw new Error("Choose a supported non-English --language=CODE.");
  const save = () => {
    db.updatedAt = new Date().toISOString();
    const temp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(db, null, 2) + "\n");
    fs.renameSync(temp, file);
  };
  let next = 0;
  let completed = 0;
  let stopped = false;
  const fetchReviewed = async (url, options) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      let response;
      try {
        response = await fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
      } catch (error) {
        if (attempt === 3) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      if (response.status !== 429 && response.status < 500) return response;
      if (attempt === 3) return response;
      const seconds = Math.min(60, Math.max(5, Number(response.headers.get("retry-after")) || 10 * (attempt + 1)));
      await response.body?.cancel();
      await new Promise(resolve => setTimeout(resolve, seconds * 1000));
    }
  };
  async function worker() {
    while (!stopped && next < languages.length) {
      const lang = languages[next++];
      const dict = db.translations[lang.code] ||= {};
      const missing = reviewed.filter(source => needsTranslation(source, dict[source]));
      let changed = 0;
      for (let offset = 0; offset < missing.length && !stopped; offset += 25) {
        const texts = missing.slice(offset, offset + 25);
        const results = await callNeuralFallbackBatch(texts, lang.code, { fetchImpl: fetchReviewed });
        for (const source of texts) {
          let translation = results[source];
          // Some successful batch responses omit individual entries. Retry
          // only the missing phrase rather than caching English or the batch.
          for (let attempt = 0; !isSafeReviewedTranslation(source, translation) && attempt < 3; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
            translation = (await callNeuralFallbackBatch([source], lang.code, { fetchImpl: fetchReviewed }))[source];
          }
          if (!isSafeReviewedTranslation(source, translation)) {
            save();
            throw new Error(`Incomplete provider response for ${lang.code} at ${JSON.stringify(source)}; ${offset} of ${missing.length} phrases processed. No English fallback was stored.`);
          }
          dict[source] = translation;
          changed++;
        }
      }
      save();
      console.log(`${lang.code}: ${changed} reviewed phrases refreshed (${++completed}/${languages.length} languages)`);
    }
  }
  try { await Promise.all([worker(), worker(), worker()]); }
  catch (error) { stopped = true; save(); throw error; }
  console.log("Reviewed translation catalog updated. No runtime screen text or paid provider credentials were used.");
}

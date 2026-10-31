#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
console_image="${1:-dune-console:ci}"
seed_sha="$(sha256sum console/api/data/i18n-translations-db.json | cut -d ' ' -f 1)"

# Exercise the shipped dictionary endpoint without host mounts, writable state,
# provider access, or the entrypoint that manages local runtime services.
docker run --rm -i --network=none --read-only \
  --env "DUNE_TEST_SEED_SHA=$seed_sha" \
  --entrypoint node "$console_image" --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { SEED_DB_PATH, getReviewedSourcePhrases, handleI18nRoute } from "/app/src/services/i18nService.js";

const bytes = readFileSync(SEED_DB_PATH);
assert.equal(createHash("sha256").update(bytes).digest("hex"), process.env.DUNE_TEST_SEED_SHA);
const seed = JSON.parse(bytes);
assert.ok(seed.sourceStrings.length > 0, "The image must ship the reviewed source catalog");
assert.equal(getReviewedSourcePhrases().length, new Set(seed.sourceStrings.map(text => text.trim())).size);
assert.ok(seed.translations.DE.Home, "The image must ship cached translations");
let reply;
await handleI18nRoute({
  req: { method: "GET" },
  res: {},
  path: "/api/i18n/translations",
  url: new URL("http://console.test/api/i18n/translations?lang=DE"),
  config: { generatedDir: "/tmp/console-image-i18n-test" },
  json(_res, status, body) { reply = { status, body }; },
  fetchImpl() { throw new Error("Cached dictionary reads must not contact a provider"); }
});
assert.equal(reply.status, 200);
assert.equal(reply.body.totalSourceStrings, getReviewedSourcePhrases().length);
assert.equal(reply.body.translations.Home, seed.translations.DE.Home);
console.log(`Console image serves ${reply.body.totalSourceStrings} reviewed phrases and cached German translations.`);
NODE

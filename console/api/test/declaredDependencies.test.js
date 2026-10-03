// Every third-party module the server imports must be declared in
// package.json.
//
// This exists because a missing declaration is invisible locally: a developer's
// node_modules is populated from whatever was installed at any point, so an
// undeclared import resolves fine on their machine and fails only on a clean
// `npm ci` -- i.e. in CI, and on every operator's first install. The symptom is
// also badly misleading: the server dies at import time, so the failures land
// in whichever unrelated integration tests happen to boot a server, not in the
// file that introduced the import.
//
// Node builtins (node:*) and relative paths are not dependencies. Subpath
// imports ("pkg/sub") are checked against their package name.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".js")) out.push(full);
  }
  return out;
}

function packageNameOf(specifier) {
  // "@scope/name/sub" -> "@scope/name"; "name/sub" -> "name"
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

test("every third-party import in src/ is declared in package.json", () => {
  const pkg = JSON.parse(readFileSync(join(apiRoot, "package.json"), "utf8"));
  const declared = new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
    ...Object.keys(pkg.optionalDependencies || {}),
  ]);

  const undeclared = new Map();
  for (const file of sourceFiles(join(apiRoot, "src"))) {
    const source = readFileSync(file, "utf8");
    // Deliberately anchored to real import statements at line start. An
    // unanchored /from ["'].../ also matches the words "from" and quotes inside
    // comments and string literals, which this file's first draft did -- it
    // reported prose fragments as missing packages.
    const specifiers = [
      ...source.matchAll(/^\s*import\s[^"';]*from\s*["']([^"']+)["']/gm),
      ...source.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
      ...source.matchAll(/^\s*(?:export\s[^"';]*from|export\s*\*\s*from)\s*["']([^"']+)["']/gm),
      ...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
    ].map((match) => match[1]);

    for (const specifier of specifiers) {
      if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) continue;
      const name = packageNameOf(specifier);
      if (declared.has(name)) continue;
      if (!undeclared.has(name)) undeclared.set(name, new Set());
      undeclared.get(name).add(file.slice(apiRoot.length + 1));
    }
  }

  if (undeclared.size) {
    const detail = [...undeclared.entries()]
      .map(([name, files]) => `  ${name}  (imported by ${[...files].join(", ")})`)
      .join("\n");
    assert.fail(
      `${undeclared.size} third-party import(s) are not declared in console/api/package.json:\n${detail}\n\n` +
      "These resolve on a machine whose node_modules already happens to contain them, and fail on a clean\n" +
      "`npm ci` -- so on every operator's first install. Add them to dependencies and commit the lockfile."
    );
  }
});

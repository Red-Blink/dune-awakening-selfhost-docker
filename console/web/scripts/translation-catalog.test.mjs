import test from "node:test";
import assert from "node:assert/strict";
import { extractUiPhrases, missingUiPhrases, collectUiContexts } from "./translation-catalog.mjs";
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test("extracts rendered text, conditional labels, accessible names and UI metadata", () => {
  const source = `const rows = [{ label: "Battlegroup Services" }];
    const view = <section><h3>Readiness &amp; Health</h3><button title={busy ? "Wait" : "Refresh Status"}>{busy ? "Refreshing" : "Refresh Status"}</button><input placeholder="Find Players" /></section>;`;
  const phrases = extractUiPhrases(source);
  for (const value of ["Battlegroup Services", "Readiness & Health", "Wait", "Refresh Status", "Refreshing", "Find Players"]) assert.ok(phrases.includes(value), value);
});

test("does not harvest runtime values, code, identifiers, paths or opted-out content", () => {
  const phrases = extractUiPhrases(`const view = <main><span>{player.name}</span><code>PRIVATE_CODE</code><span data-no-translate>Native Identifier</span><div className="some-css-class">Hello</div><a href="https://example.test">Help</a></main>`);
  assert.deepEqual(phrases, ["Hello", "Help"]);
});

test("numeric UI templates keep values separate from reviewed phrases", () => {
  const phrases = extractUiPhrases('function count(ready, rows) { return `${ready} of ${rows.length}`; } function privateMessage(name) { return `Hello ${name}`; }');
  assert.deepEqual(phrases, ["{count0} of {count1}"]);
});

test("existing capitalization aliases do not create duplicate translation entries", () => {
  const missing = missingUiPhrases(new Map([["Game Servers", ["Home.tsx"]], ["Refresh Status", ["Home.tsx"]]]), ["Game servers"]);
  assert.deepEqual(missing, [{ text: "Refresh Status", files: ["Home.tsx"] }]);
});

test('source context preserves exact locations and static nearby labels without harvesting runtime expressions',t=>{
  const dir=mkdtempSync(join(tmpdir(),'ui-context-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  writeFileSync(join(dir,'Settings.tsx'),'<section>\n<h2>Security</h2>\n<label>Admin Password</label>\n<span>{player.privateName}</span>\n<button>Save</button>\n</section>');
  const contexts=collectUiContexts(dir);
  assert.deepEqual(contexts['Admin Password'],[{file:'console/web/src/Settings.tsx',line:3,nearby:['Security','Save']}]);
  assert.ok(!JSON.stringify(contexts).includes('privateName'));
});

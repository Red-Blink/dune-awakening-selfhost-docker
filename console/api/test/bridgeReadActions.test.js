import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { READ_ONLY_BRIDGE_ACTIONS } from "../src/bridgeReadActions.js";

const serverSource = readFileSync(fileURLToPath(new URL("../src/server.js", import.meta.url)), "utf8");

test("the read-only bridge action list contains no action that can change state", () => {
  const mutating = [
    "rewards.deliver", "players.message.send", "admin.items.grant", "database.execute", "database.query",
    "addon.storage.put", "addon.storage.delete"
  ];
  for (const action of mutating) assert.equal(READ_ONLY_BRIDGE_ACTIONS.has(action), false, action);
  for (const action of READ_ONLY_BRIDGE_ACTIONS) {
    assert.doesNotMatch(action, /^(scheduler|admin|database)\./, action);
    assert.doesNotMatch(action, /\.(send|deliver|put|delete|grant|execute|reset|set|create|update|run)\b/, action);
  }
});

test("every listed read-only action is dispatched by the bridge route", () => {
  const code = serverSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const action of READ_ONLY_BRIDGE_ACTIONS) {
    assert.match(code, new RegExp(`action === "${action.replaceAll(".", "\\.")}"`), `${action} is not handled in server.js`);
  }
});

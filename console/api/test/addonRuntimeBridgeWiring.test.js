import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dirname, "../src/server.js"), "utf8");

function actionBlock(action, length = 1500) {
  const start = source.indexOf(`if (action === "${action}"`);
  assert.ok(start > 0, `${action} bridge action is not registered`);
  return source.slice(start, start + length);
}

test("typed addon player reads require players:read before querying", () => {
  for (const action of ["players.summary.list", "players.progression.get"]) {
    const block = actionBlock(action);
    const permissionAt = block.indexOf('assertInstalledAddonPermission(config, id, "players:read")');
    assert.ok(permissionAt >= 0, `${action} is not protected by players:read`);
    assert.ok(permissionAt < block.indexOf("duneDb."), `${action} reads data before checking permission`);
  }
});

test("addon storage is isolated behind files:addon-data", () => {
  const block = actionBlock("addon.storage.get", 2200);
  assert.match(block, /assertInstalledAddonPermission\(config, id, "files:addon-data"\)/);
  assert.match(block, /readAddonData\(config, addon\.id/);
  assert.match(block, /writeAddonData\(config, addon\.id/);
});

test("reward and message delivery use separate explicit permissions", () => {
  const rewards = actionBlock("rewards.deliver", 1800);
  assert.match(rewards, /assertInstalledAddonPermission\(config, id, "rewards:grant"\)/);
  const messages = actionBlock("players.message.send", 1800);
  assert.match(messages, /assertInstalledAddonPermission\(config, id, "players:message"\)/);
});

test("queued addon deliveries are processed by the existing background tick", () => {
  assert.match(source, /runBackgroundTick\("Addon queued deliveries", \(\) => addonDeliveryService\.tick\(\)\)/);
});

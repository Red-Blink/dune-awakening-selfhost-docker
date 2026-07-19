import test from "node:test";
import assert from "node:assert/strict";
import { CHOAM_TRADE_CENTERS, choamTerminalInternals } from "../src/services/choamTerminals.js";

test("CHOAM trade-center catalog contains the four Hagga Basin trade centers", () => {
  assert.deepEqual(CHOAM_TRADE_CENTERS.map((entry) => entry.key), ["griffins-reach", "the-crossroads", "pinnacle-station", "the-anvil"]);
});

test("every CHOAM trade center has a complete verified transform", () => {
  for (const center of CHOAM_TRADE_CENTERS) {
    assert.deepEqual(Object.keys(center.transform), ["x", "y", "z", "qx", "qy", "qz", "qw"]);
    assert.ok(Object.values(center.transform).every(Number.isFinite));
  }
});

test("terminal configuration uses the real game class and exchange access point", () => {
  assert.equal(choamTerminalInternals.terminalClass, "/Game/Dune/Systems/DuneExchange/BP_DuneChoamExchangeTerminal.BP_DuneChoamExchangeTerminal_C");
  assert.equal(choamTerminalInternals.terminalProperties.DEAccessPointComponent.m_ExchangeName.Name, "HarkoVillage_EX");
  assert.equal(choamTerminalInternals.terminalProperties.DEAccessPointComponent.m_AccessPointName.Name, "HarkoVillage_AP");
});

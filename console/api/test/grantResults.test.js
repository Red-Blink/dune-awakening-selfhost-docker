import test from "node:test";
import assert from "node:assert/strict";
import { liveItemGrantOk, liveItemGrantWarning } from "../src/grantResults.js";

test("live item grants fail verification when inventory did not change", () => {
  const result = {
    code: 0,
    stdout: "Grant item command published.\n",
    stderr: "WARNING: publish succeeded, but the player's inventory stack did not increase for Cold Survival Exploration Suit.\n"
  };
  assert.equal(liveItemGrantOk(result), false);
  assert.match(liveItemGrantWarning(result), /inventory did not change/i);
});

test("live item grants pass when command succeeds without verifier warning", () => {
  const result = {
    code: 0,
    stdout: "Grant item command published.\nVerified inventory stack increased: Cup of Water (0 -> 10).\n",
    stderr: ""
  };
  assert.equal(liveItemGrantOk(result), true);
  assert.equal(liveItemGrantWarning(result), "");
});

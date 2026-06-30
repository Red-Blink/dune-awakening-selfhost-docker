import test from "node:test";
import assert from "node:assert/strict";
import { addonContentSecurityPolicy, addonHtmlWithScriptNonce } from "../src/addonContentSecurity.js";

test("adds nonce attributes to addon script tags without replacing existing nonces", () => {
  const html = `<script src="./bridge.js"></script><script>window.loaded = true;</script><script nonce="kept">safe();</script>`;
  const result = addonHtmlWithScriptNonce(html, "abc123");

  assert.match(result, /<script nonce="abc123" src="\.\/bridge\.js"><\/script>/);
  assert.match(result, /<script nonce="abc123">window\.loaded = true;<\/script>/);
  assert.match(result, /<script nonce="kept">safe\(\);<\/script>/);
});

test("addon content security policy allows only nonce-backed inline scripts", () => {
  const policy = addonContentSecurityPolicy("abc123");

  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /script-src 'self' 'nonce-abc123'/);
  assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/);
  assert.match(policy, /frame-ancestors 'self'/);
});

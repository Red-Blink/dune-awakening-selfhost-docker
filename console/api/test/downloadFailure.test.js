import test from "node:test";
import assert from "node:assert/strict";
import { downloadFailureMessage } from "../src/services/downloadFailure.js";

const now = Date.parse("2026-10-02T12:00:00Z");
test("registry failures identify the actual provider", () => {
  assert.match(downloadFailureMessage('Error response from daemon: toomanyrequests: You have reached your unauthenticated pull rate limit.'), /^Docker Hub request limit reached/);
  assert.match(downloadFailureMessage("Image: registry.funcom.com/funcom/self-hosting/db-utils:123\nError response from daemon: toomanyrequests"), /^Funcom registry request limit reached/);
  assert.match(downloadFailureMessage("docker: Error response from daemon: toomanyrequests"), /^Container registry request limit reached/);
});
test("confirmed limits preserve real retry times, not invented delays", () => {
  assert.equal(downloadFailureMessage("GitHub request limit reached. Try again after 2026-10-02 12:10:00 UTC."), "GitHub request limit reached. Try again after 2026-10-02 12:10:00 UTC.");
  assert.match(downloadFailureMessage("GitHub HTTP response 429\nRetry-After: 600", now), /12:10:00 UTC/);
  assert.match(downloadFailureMessage("GitHub HTTP response 429\nRetry-After: Fri, 02 Oct 2026 12:10:00 GMT", now), /12:10:00 UTC/);
  assert.match(downloadFailureMessage("GitHub HTTP response 429\nRetry-After: invalid", now), /no retry time was provided/);
});
test("ordinary auth, DNS, timeout and documentation messages are not limits", () => {
  for (const text of ["registry.funcom.com HTTP response 403 Forbidden", "HTTP response 401 Unauthorized", "Could not resolve github.com", "SteamCMD timed out", "If GitHub rate limiting is the issue, set a token", "Checking Docker Hub pull rate limit", "requests: 429 total"]) assert.equal(downloadFailureMessage(text), "", text);
});
test("provider response secrets are not exposed in the summary", () => {
  assert.equal(downloadFailureMessage('GitHub HTTP response 429 private-token https://user:secret@github.com/path'), "GitHub request limit reached. Try again later; no retry time was provided.");
  assert.equal(downloadFailureMessage("GitHub request limit reached. private-token"), "");
});

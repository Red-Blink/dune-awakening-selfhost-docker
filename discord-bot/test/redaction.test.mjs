import assert from "node:assert/strict";
import test from "node:test";

const REDACTION = "<redacted>";

function redactString(value) {
  return value
    .replace(/Bot\s+[A-Za-z0-9._=-]{20,}/gi, REDACTION)
    .replace(/Bearer\s+[A-Za-z0-9._=-]{20,}/gi, REDACTION)
    .replace(/(?:mfa\.)[A-Za-z0-9._=-]{20,}/gi, REDACTION)
    .replace(/[A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}/g, REDACTION)
    .replace(/(postgres(?:ql)?:\/\/[^\s"']+)/gi, REDACTION);
}

test("redacts Discord bot token shape", () => {
  const token = ["MzI1NjY2Nzc4ODg5OTAwMTEy", "Gabc12", "someLongDiscordTokenValue"].join(".");
  const value = `token=${token}`;
  assert.equal(redactString(value), `token=${REDACTION}`);
});

test("redacts bearer token", () => {
  const bearer = ["Bear", "er"].join("");
  const token = ["abcdefghijkl", "mnopqrstuvwxyz", "123456"].join("");
  const value = `Authorization: ${bearer} ${token}`;
  assert.equal(redactString(value), `Authorization: ${REDACTION}`);
});

test("redacts postgres URLs", () => {
  const scheme = ["postgres", "ql"].join("");
  const value = `${scheme}://dune:sample-value@localhost:15432/dune`;
  assert.equal(redactString(value), REDACTION);
});

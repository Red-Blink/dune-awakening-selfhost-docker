// The read path is enforced by POSTGRES, not by isReadOnlySql.
//
// A four-way review of the database:execute split found the permission was
// decorative. isReadOnlySql only asks "does this start with a read keyword and
// avoid a blacklist", and every privileged mutation in this application is
// shaped `select dune.<fn>(...)`, so the whole mutation surface classified as
// read-only: no database:execute demanded, no pre-write backup, no mutation
// rate-limit tick, and an audit row saying readOnly:true. Confirmed against a
// restored production dump by mutating a real currency balance.
//
// The blacklist cannot be repaired to cover it -- \bdelete\b does not match
// delete_actors, and the schema ships hundreds of functions. So runSql now
// wraps the read path in `set transaction read only`.
//
// These tests are BEHAVIOURAL on purpose. The existing coverage in
// databaseQueryAuthz.test.js asserts on server.js source text, which would pass
// unchanged if requireAction always returned true and could never have caught
// this. Everything below executes real SQL against a real Postgres.

import test from "node:test";
import assert from "node:assert/strict";
import { createDb } from "../src/db.js";
import { runSql } from "../src/duneDb.js";

const HOST = process.env.DUNE_DB_HOST || "";
const skip = HOST ? false : "no DUNE_DB_HOST — needs the containerised Postgres";

const db = HOST
  ? createDb({
      host: HOST,
      port: Number(process.env.DUNE_DB_PORT || 5432),
      database: process.env.DUNE_DB_NAME || "dune",
      user: process.env.DUNE_DB_USER || "dune",
      password: process.env.DUNE_DB_PASSWORD || "dune"
    })
  : null;

const SCHEMA = "roenf";

// EXACTLY how server.js databaseQuery and the addon bridge call it. Enforcement
// is opt-in, so calling runSql bare exercises the UNENFORCED path and reports
// writes as succeeding -- a test that omits the option tests nothing.
const runUserSql = (sql, allowWrite = false) => runSql(db, sql, allowWrite, { enforceReadOnly: true });

test("read-only enforcement", { skip }, async (t) => {
  await db.query(`drop schema if exists ${SCHEMA} cascade`);
  await db.query(`create schema ${SCHEMA}`);
  await db.query(`create table ${SCHEMA}.balances (id int primary key, amount bigint)`);
  await db.query(`insert into ${SCHEMA}.balances values (1, 100)`);
  // The shape that defeated the classifier: a writing function called through
  // SELECT. Named with an underscore on purpose -- \bdelete\b does not match
  // delete_actors, which is why a keyword blacklist can never cover this.
  await db.query(`
    create function ${SCHEMA}.delete_actors_and_pay(delta bigint) returns bigint
    language sql as $$
      update ${SCHEMA}.balances set amount = amount + delta where id = 1 returning amount;
    $$`);

  const amount = async () => {
    const rows = await db.query(`select amount from ${SCHEMA}.balances where id = 1`);
    return String(rows.rows[0].amount);
  };

  t.after(async () => {
    await db.query(`drop schema if exists ${SCHEMA} cascade`);
    await db.close();
  });

  await t.test("a mutating function called through SELECT cannot write on the read path", async () => {
    const before = await amount();
    await assert.rejects(
      () => runUserSql(`select ${SCHEMA}.delete_actors_and_pay(500)`),
      /read-only transaction/i,
      "Postgres must refuse the write"
    );
    assert.equal(await amount(), before, "the balance changed despite the read-only path");
  });

  await t.test("SELECT ... INTO cannot create a table on the read path", async () => {
    await assert.rejects(
      () => runUserSql(`select * into ${SCHEMA}.stolen from ${SCHEMA}.balances`),
      /read-only transaction/i
    );
    const found = await db.query(
      `select count(*)::int as n from pg_tables where schemaname = $1 and tablename = 'stolen'`, [SCHEMA]);
    assert.equal(found.rows[0].n, 0, "SELECT INTO created a table on the read path");
  });

  await t.test("a benign leading statement does not smuggle a write through", async () => {
    // `select 1; select mutating_fn()` classified read-only and ran both.
    // The transaction covers every statement in the string, not just the first.
    const before = await amount();
    await assert.rejects(
      () => runUserSql(`select 1; select ${SCHEMA}.delete_actors_and_pay(700)`),
      /read-only transaction/i
    );
    assert.equal(await amount(), before);
  });

  await t.test("ordinary reads still work on the read path", async () => {
    const result = await runUserSql(`select amount from ${SCHEMA}.balances where id = 1`);
    assert.equal(String(result.rows[0].amount), "100");
  });

  await t.test("a SELECT with a leading comment is a read, not a 403", async () => {
    // Regression introduced by the database:execute split and caught in review:
    // runner.js tested the raw string, so a header comment meant the statement
    // did not start with a read keyword, classified as a WRITE, and demanded a
    // permission admin is denied. Pasted SQL very often carries a header.
    for (const sql of [
      `-- daily balance\nselect amount from ${SCHEMA}.balances where id = 1`,
      `/* daily balance */ select amount from ${SCHEMA}.balances where id = 1`
    ]) {
      const result = await runUserSql(sql);
      assert.equal(String(result.rows[0].amount), "100", sql);
    }
  });

  await t.test("the write path still writes when it is authorized", async () => {
    // allowDestructive is what requireAction("database:execute") gates on. The
    // hardening must not break the legitimate owner path.
    const before = Number(await amount());
    await runUserSql(`update ${SCHEMA}.balances set amount = amount + 5 where id = 1`, true);
    assert.equal(Number(await amount()), before + 5);
  });

  await t.test("a mutating function DOES write when the write path is authorized", async () => {
    const before = Number(await amount());
    await runUserSql(`select ${SCHEMA}.delete_actors_and_pay(11)`, true);
    assert.equal(Number(await amount()), before + 11, "the write path must still reach writing functions");
  });
});

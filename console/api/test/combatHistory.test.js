import test from 'node:test';
import assert from 'node:assert/strict';
import { createCombatHistory, combatScope, combatRowLimit } from '../src/services/combatHistory.js';
import { withIsolatedDatabase, pgTransactionalDb } from '../test-support/pgIntegrationDb.js';
import { actionForRoute } from '../src/actions.js';
import { randomBytes } from 'node:crypto';

test('combat row choices accept only the supported sizes and preserve omitted defaults', () => {
  assert.equal(combatRowLimit(undefined,100),100);
  assert.equal(combatRowLimit(null,50),50);
  for (const size of [10,20,50]) assert.equal(combatRowLimit(String(size),100),size);
  assert.equal(combatRowLimit('all',100),null);
  for (const size of ['0','-1','100','51','10.5','ALL','10; DROP TABLE dune.player_state']) {
    assert.throws(() => combatRowLimit(size,100), e => e.statusCode === 400);
  }
});

test('row selections are independent and All includes history beyond legacy caps', async t => {
  await withIsolatedDatabase(t, { namePrefix: 'combat_row_choices', unavailableLabel: 'combat row choices' }, async pool => {
    const db = pgTransactionalDb(pool);
    await db.query(`CREATE SCHEMA dune;
      CREATE TABLE dune.player_state(id bigint,player_controller_id bigint,character_name text);
      CREATE TABLE dune.game_events(actor_id bigint,universe_time timestamptz,map text,partition_id bigint,event_type integer,custom_data jsonb);
      INSERT INTO dune.player_state SELECT n,n,'Synthetic Player '||n FROM generate_series(1,125) n;
      INSERT INTO dune.game_events SELECT n,now()-n*interval '1 minute','Survival_1',1,0,
        jsonb_build_object('m_KillerType','Player','m_KillerPlayerId','!!act#'||(n%125+1)) FROM generate_series(1,125) n;`);
    const history = createCombatHistory(db);
    await history.tick();
    const defaults = await history.read();
    assert.equal(defaults.leaderboard.length,100); assert.equal(defaults.recentKills.length,50);
    for (const size of [10,20,50]) {
      const result = await history.read({ leaderboardLimit:String(size),killsLimit:'20' });
      assert.equal(result.leaderboard.length,size); assert.equal(result.recentKills.length,20);
      assert.equal(result.recentKills[0].victimId,'1');
    }
    const all = await history.read({ leaderboardLimit:'all',killsLimit:'all' });
    assert.equal(all.leaderboard.length,125); assert.equal(all.recentKills.length,125);
    const scoped = await history.read({ controllerId:'1',selfOnly:true,leaderboardLimit:'all',killsLimit:'all' });
    assert.equal(scoped.leaderboard.length,1); assert.equal(scoped.recentKills.length,2);
    assert.ok(scoped.recentKills.every(row => row.killerId==='1' || row.victimId==='1'));
    assert.equal(Number((await db.query('SELECT count(*) AS n FROM dune_console_combat.combat_events')).rows[0].n),125);
  });
});

test('normal Console role can record without access to the administrator-owned runtime schema', async t => {
  await withIsolatedDatabase(t, { namePrefix: 'combat_permissions', unavailableLabel: 'combat permissions' }, async pool => {
    const admin = pgTransactionalDb(pool);
    const role = 'combat_recorder_' + randomBytes(6).toString('hex');
    const database = (await admin.query('SELECT current_database() AS name')).rows[0].name;
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER`);
    try {
      await admin.query(`CREATE SCHEMA dune_runtime;
        REVOKE ALL ON SCHEMA dune_runtime FROM PUBLIC;
        CREATE SCHEMA dune;
        CREATE TABLE dune.player_state(id bigint,player_controller_id bigint,character_name text);
        CREATE TABLE dune.game_events(actor_id bigint,universe_time timestamptz,map text,partition_id bigint,event_type integer,custom_data jsonb);
        INSERT INTO dune.player_state VALUES(1,101,'Attacker'),(2,102,'Victim');
        INSERT INTO dune.game_events VALUES(102,now(),'Survival_1',1,0,'{"m_KillerType":"Player","m_KillerPlayerId":"!!act#101"}');
        GRANT CREATE ON DATABASE "${database}" TO ${role};
        GRANT USAGE ON SCHEMA dune TO ${role};
        GRANT SELECT ON ALL TABLES IN SCHEMA dune TO ${role};`);
      const db = { transaction: fn => admin.transaction(async tx => {
        await tx.query(`SET LOCAL ROLE ${role}`);
        return fn(tx);
      }) };
      const history = createCombatHistory(db);
      await history.tick();
      const result = await history.read();
      assert.equal(result.status,'recording');
      assert.equal(result.recentKills.length,1);
      assert.equal(result.leaderboard.find(row=>row.controllerId==='101').kills,1);
      assert.equal((await admin.query(`SELECT has_schema_privilege('${role}','dune_runtime','USAGE') AS allowed`)).rows[0].allowed,false);
    } finally {
      await admin.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
    }
  });
});

test('combat scope validates IDs and restricts player-tier access to the linked controller', () => {
  assert.equal(combatScope(null), null);
  assert.equal(combatScope('102'), '102');
  assert.equal(combatScope(null, '101', true), '101');
  assert.equal(combatScope('101', '101', true), '101');
  for (const id of ['0','-1','x','1 OR true','9223372036854775808','1.1']) {
    assert.throws(() => combatScope(id), e => e.statusCode === 400);
  }
  assert.throws(() => combatScope('102', '101', true), e => e.statusCode === 403);
  assert.throws(() => combatScope(null, null, true), e => e.statusCode === 403);
  assert.equal(actionForRoute('/api/players/combat', 'GET'), 'players:read');
});

test('mock mode never queries or mutates a database', async () => {
  const history = createCombatHistory({ transaction() { throw new Error('must not run'); } }, { mockMode: true });
  await history.tick();
  const result = await history.read();
  assert.equal(result.supported, false); assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.leaderboard, []);
  await assert.rejects(history.read({ selfOnly: true }), e => e.statusCode === 403);
});

test('native combat collection and durable statistics in PostgreSQL', async t => {
  await withIsolatedDatabase(t, { namePrefix: 'combat_history', unavailableLabel: 'combat history' }, async pool => {
    const db = pgTransactionalDb(pool);
    await db.query(`CREATE SCHEMA dune;
      CREATE TABLE dune.actors(id bigint PRIMARY KEY);
      CREATE TABLE dune.player_state(id bigint PRIMARY KEY,player_controller_id bigint,character_name text);
      CREATE TABLE dune.game_events(actor_id bigint REFERENCES dune.actors(id) ON DELETE CASCADE,
        universe_time timestamptz,map text,partition_id bigint,event_type integer,
        custom_data jsonb,x double precision,y double precision,z double precision);
      INSERT INTO dune.actors VALUES(101),(102),(103);
      INSERT INTO dune.player_state VALUES(1,101,'Same Name'),(2,102,'Same Name'),(3,103,'Third Player');`);
    let clock = 1000;
    const history = createCombatHistory(db, { now: () => clock });
    const event = (victim, type, payload, time = '2026-11-02T00:00:00Z') => db.query(
      `INSERT INTO dune.game_events VALUES($1,$2,'Survival_1',1,$3,$4,99,88,77)`, [victim,time,type,payload]);
    const byId = (r,id) => r.leaderboard.find(row => row.controllerId === id);

    await t.test('capture one finished kill once, ignore paired type 5, preserve equal names', async () => {
      await event(102,0,{m_KillerType:'Player',m_KillerPlayerId:'!!act#101'});
      await event(101,5,{m_DeadPlayerId:'!!act#102'});
      await history.tick();
      const r = await history.read();
      assert.equal(r.status,'recording'); assert.equal(r.supported,true);
      assert.equal(byId(r,'101').kills,1); assert.equal(byId(r,'101').kd,null);
      assert.equal(byId(r,'102').deaths,1); assert.equal(r.leaderboard.length,2);
      assert.equal(r.recentKills.length,1); assert.equal(r.recentKills[0].map,'Survival_1');
      assert.ok(r.recordingStartedAt); assert.ok(r.recordedSince); assert.ok(r.lastCapturedAt);
      assert.equal(Number((await db.query('SELECT count(*) AS n FROM dune.game_events')).rows[0].n),2);
      const cols = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='dune_console_combat' AND table_name='combat_events'")).rows.map(x=>x.column_name);
      for(const name of ['x','y','z','custom_data']) assert.ok(!cols.includes(name));
    });

    await t.test('repeated scans, process restart and identical timestamp/source rows remain correct', async () => {
      await history.tick({ force:true });
      const restarted = createCombatHistory(db);
      await restarted.tick();
      assert.equal(byId(await restarted.read(),'101').kills,1);
      await event(102,0,{m_KillerType:'Player',m_KillerPlayerId:'!!act#101'});
      await history.tick({ force:true });
      assert.equal(byId(await history.read(),'101').kills,2);
      await history.tick({ force:true });
      assert.equal(byId(await history.read(),'101').kills,2);
    });

    await t.test('suicides, PvE, missing/oversized references and unknown causes do not inflate K/D', async () => {
      await event(101,0,{m_KillerType:'Player',m_KillerPlayerId:'!!act#101'});
      await event(101,0,{m_KillerType:'NPC'});
      await event(101,0,{m_KillerType:'Player',m_KillerPlayerId:'12abc34'});
      await event(101,0,{m_KillerType:'Player',m_KillerPlayerId:'!!act#9223372036854775808'});
      await event(101,0,{m_KillerType:'None'});
      await event(101,0,{});
      await history.tick({ force:true });
      const r = await history.read(), p = byId(r,'101');
      assert.equal(p.kills,2); assert.equal(p.deaths,0); assert.equal(p.selfDeaths,1);
      assert.equal(p.otherDeaths,1); assert.equal(p.unknownDeaths,4); assert.equal(p.kd,null);
      assert.equal(r.recentKills.length,2);
    });

    await t.test('own-history view cannot expose another identity or unrelated events', async () => {
      const own = await history.read({ controllerId:'102', selfOnly:true });
      assert.equal(own.leaderboard.length,1); assert.equal(own.leaderboard[0].controllerId,'102');
      assert.ok(own.recentKills.every(x => x.killer==='Another Player' && x.killerId===null && x.victimId==='102'));
      const absent = await history.read({ controllerId:'999', selfOnly:true });
      assert.deepEqual(absent.leaderboard,[]); assert.deepEqual(absent.recentKills,[]);
    });

    await t.test('native actor deletion cannot cascade into captured history or lose names', async () => {
      await db.query('DELETE FROM dune.actors WHERE id=102');
      await db.query('DELETE FROM dune.player_state WHERE player_controller_id=102');
      await history.tick({ force:true });
      const r = await history.read();
      assert.equal(byId(r,'101').kills,2); assert.equal(byId(r,'102').deaths,2);
      assert.equal(byId(r,'102').name,'Same Name');
      assert.equal(r.recentKills.length,2);
    });

    await t.test('unavailable native source after restart keeps collected history readable', async () => {
      await db.query('ALTER TABLE dune.game_events RENAME COLUMN event_type TO changed_type');
      const restarted = createCombatHistory(db);
      await restarted.tick();
      const r = await restarted.read();
      assert.equal(r.supported,true); assert.equal(r.status,'unavailable');
      assert.equal(byId(r,'101').kills,2);
      await db.query('ALTER TABLE dune.game_events RENAME COLUMN changed_type TO event_type');
    });

    await t.test('failed capture rolls back and reports paused without exposing database details', async () => {
      await db.query(`ALTER TABLE dune_console_combat.combat_events ADD CONSTRAINT reject_new CHECK(victim_id<>'103')`);
      await event(103,0,{m_KillerType:'Player',m_KillerPlayerId:'!!act#101'});
      await history.tick({ force:true });
      let r = await history.read();
      assert.equal(r.status,'paused'); assert.equal(byId(r,'101').kills,2);
      assert.ok(!r.reason.includes('reject_new'));
      await db.query('ALTER TABLE dune_console_combat.combat_events DROP CONSTRAINT reject_new');
      await history.tick({ force:true });
      r = await history.read(); assert.equal(r.status,'recording'); assert.equal(byId(r,'101').kills,3);
    });

    await t.test('periodic calls are single-flight and throttled', async () => {
      await event(103,0,{m_KillerType:'Player',m_KillerPlayerId:'!!act#101'},'2026-11-02T00:00:01Z');
      await history.tick(); assert.equal(byId(await history.read(),'101').kills,3);
      clock += 30_000;
      const first = history.tick(), second = history.tick(); assert.equal(first,second);
      await first; assert.equal(byId(await history.read(),'101').kills,4);
    });
  });
});

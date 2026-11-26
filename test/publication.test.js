import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {PGlite} from '@electric-sql/pglite';
import {createApp} from '../src/api.js';
import {migrate} from '../src/db.js';
import {jst} from '../src/jobs.js';
import {defaultRules,recalculate,savePlayer,storeOfficial,track} from '../src/ranking.js';
import {cronStatus} from '../src/cron-status.js';

test('publication migration releases a saved top 200 with mismatches and stays open for new tracking',async()=>{
  const db=new PGlite();
  const server=createApp(db).listen(0,'127.0.0.1');
  try{
    await once(server,'listening');
    const get=async path=>{
      const response=await fetch('http://127.0.0.1:'+server.address().port+path);
      assert.equal(response.status,200);
      return response.json();
    };
    await db.transaction(migrate);
    const day=jst().slice(0,10);
    const {rows:[season]}=await db.query(`INSERT INTO seasons(source_term,legacy_term,starts_on,ends_on)
      VALUES('N','O',$1,$1) RETURNING id`,[day]);
    await db.query('INSERT INTO aggregation_rules(season_id,version,weekly_limit,grade_rules) VALUES($1,1,2,$2)',[season.id,defaultRules]);
    const official={time:new Date().toISOString(),rows:Array.from({length:200},(_,i)=>({
      dmpId:i+1,name:'匿名'+(i+1),rank:i+1,points:200-i
    }))};
    await storeOfficial(db,season,official);
    await db.query(`INSERT INTO sync_discrepancies(season_id,dmp_id,aggregation_at,official_points,computed_points,status)
      VALUES($1,1,$2,200,0,'mismatch'),($1,2,$2,199,NULL,'unknown')`,[season.id,official.time]);
    await db.query("UPDATE tracked_players SET backfill_status='ready' WHERE dmp_id<200");
    await recalculate(db,season.id);
    assert.equal((await get('/api/state')).progress.ready,199);
    assert.deepEqual(await get('/api/rankings?mode=provisional&limit=200'),[]);
    assert.equal((await get('/api/players/1')).player.provisional_rank,null);
    assert.deepEqual((await get('/api/borders?n=200')).provisional,[]);

    // Simulate the rows already saved by the old version before its stricter gate.
    await db.query("UPDATE tracked_players SET backfill_status='ready' WHERE dmp_id=200");
    await db.query(`INSERT INTO provisional_rankings(season_id,dmp_id,rank,points,coverage,status,calculated_at)
      VALUES($1,200,1,0,'tracked-only','ready',now())`,[season.id]);
    await db.query(`INSERT INTO provisional_history(season_id,dmp_id,rank,points,tracked,status,observed_at)
      VALUES($1,200,1,0,true,'ready',clock_timestamp())`,[season.id]);
    const readScores=async()=>(await db.query('SELECT * FROM provisional_rankings ORDER BY dmp_id')).rows;
    const readAudit=async()=>(await db.query('SELECT * FROM sync_discrepancies ORDER BY dmp_id')).rows;
    const scores=await readScores();
    const audit=await readAudit();
    await db.query('DROP VIEW season_initial_data_ready');
    await db.query("DELETE FROM schema_migrations WHERE name='005.sql'");
    await db.transaction(migrate);
    const state=await get('/api/state');
    assert.ok(state.season.initialized_at);
    assert.equal(state.progress.ready,200);
    assert.deepEqual(await readScores(),scores);
    assert.deepEqual(await readAudit(),audit);
    assert.equal((await get('/api/rankings?mode=provisional&limit=200')).length,200);
    assert.equal((await get('/api/players/1')).player.provisional_rank,1);
    assert.equal((await get('/api/borders?n=200')).provisional.at(-1).points,0);
    await savePlayer(db,{dmpId:201,name:'新規選手'});
    await track(db,season.id,201,'admin');
    // Stray rows cannot give an unfinished player a visible provisional rank.
    await db.query(`INSERT INTO provisional_rankings(season_id,dmp_id,rank,points,coverage,status,calculated_at)
      VALUES($1,201,1,9999,'tracked-only','ready',now())`,[season.id]);
    await db.query(`INSERT INTO provisional_history(season_id,dmp_id,rank,points,tracked,status,observed_at)
      VALUES($1,201,1,9999,true,'pending',clock_timestamp())`,[season.id]);
    assert.equal((await get('/api/rankings?mode=provisional&limit=all')).length,200);
    assert.equal((await get('/api/players/201')).player.provisional_rank,null);
    assert.equal((await get('/api/borders?n=1')).provisional.at(-1).points,0);
    await recalculate(db,season.id,[]);
    assert.equal((await get('/api/state')).season.initialized_at,state.season.initialized_at);
    assert.deepEqual(await readAudit(),audit);
  }finally{server.close();await db.close();}
});

test('cron health distinguishes unverified, current, paused, overdue and failed receipts',()=>{
  const now=new Date('2026-11-25T05:00:00Z');
  const receipt={received_at:'2026-11-25T04:30:00.000Z',outcome:'ok',last_succeeded_at:'2026-11-25T04:30:01.000Z'};
  assert.equal(cronStatus(null,false,now).status,'unverified');
  assert.equal(cronStatus(receipt,false,now).status,'healthy');
  assert.equal(cronStatus(receipt,true,now).status,'paused');
  assert.equal(cronStatus(receipt,false,new Date('2026-11-25T07:00:00Z')).status,'overdue');
  assert.equal(cronStatus({...receipt,outcome:'failed'},false,now).status,'error');
});

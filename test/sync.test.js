import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/db.js';
import {reconcile,schedule} from '../src/jobs.js';
import {defaultRules,recalculate,storeEvent,storeOfficial,storePersonal,storeSchedule} from '../src/ranking.js';

test('official reconciliation distinguishes match, mismatch, and unknown without changing computed totals',async()=>{
  const db=new PGlite();
  try {
    await db.transaction(migrate);
    const {rows:[season]}=await db.query("INSERT INTO seasons(source_term,legacy_term,starts_on,ends_on) VALUES('1','2','2026-11-01','2026-12-31') RETURNING id,starts_on::text,ends_on::text");
    await db.query('INSERT INTO aggregation_rules(season_id,version,weekly_limit,grade_rules) VALUES($1,1,2,$2)',[season.id,defaultRules]);
    const snapshot={time:'2026-11-25T06:00:00.000Z',rows:[{dmpId:1,name:'甲',rank:1,points:100},{dmpId:2,name:'乙',rank:2,points:50},{dmpId:3,name:'丙',rank:3,points:10}]};
    await storeOfficial(db,season,snapshot);
    assert.equal(await storeOfficial(db,season,snapshot),false);
    const eventRow={eventDate:'2026-11-24',shopId:1,eventId:1,heldId:1,name:'匿名大会',grade:'CS',multiplier:'1',isTeam:false};
    await storeSchedule(db,season,[eventRow]);
    await storeSchedule(db,season,[{...eventRow,multiplier:null,upcoming:true}]);
    assert.equal(Number((await db.query('SELECT multiplier FROM events')).rows[0].multiplier),1);
    await storeEvent(db,{id:1},[{dmpId:1,name:'甲',placement:1,totalPoints:100,updatedAt:'2026-11-24T06:00:00.000Z'}]);
    await storePersonal(db,season,1,[]);
    await storePersonal(db,season,2,[]);
    await reconcile(db,season,snapshot.time);
    await reconcile(db,season,snapshot.time);
    await recalculate(db,season.id);
    assert.deepEqual((await db.query('SELECT status FROM sync_discrepancies ORDER BY dmp_id')).rows.map(r=>r.status),['match','mismatch','unknown']);
    assert.equal((await db.query("SELECT count(*)::int n FROM fetch_jobs WHERE type='personal'")).rows[0].n,1);
    assert.deepEqual((await db.query('SELECT points FROM provisional_rankings ORDER BY dmp_id')).rows.map(r=>r.points),[100,0]);
    assert.equal((await db.query('SELECT initialized_at FROM seasons')).rows[0].initialized_at,null);
    await storePersonal(db,season,3,[]);
    await recalculate(db,season.id);
    assert.ok((await db.query('SELECT initialized_at FROM seasons')).rows[0].initialized_at);
    assert.deepEqual((await db.query('SELECT status FROM sync_discrepancies ORDER BY dmp_id')).rows.map(r=>r.status),['match','mismatch','unknown']);
    const now=new Date('2026-11-25T06:05:00.000Z');
    await db.transaction(tx=>schedule(tx,now));
    const count=(await db.query('SELECT count(*)::int n FROM fetch_jobs')).rows[0].n;
    await db.transaction(tx=>schedule(tx,now));
    assert.equal((await db.query('SELECT count(*)::int n FROM fetch_jobs')).rows[0].n,count);
  } finally {await db.close();}
});

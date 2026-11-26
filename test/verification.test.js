import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/db.js';
import {claim,enqueue,runJob} from '../src/jobs.js';
import {defaultRules,setting,storeSchedule} from '../src/ranking.js';
import {verificationKey} from '../src/verification.js';

test('official-only saves the entire snapshot and tracks ties at 200 without follow-up; normal update prioritizes incomplete top players without historical scans',async()=>{
  const db=new PGlite();
  const pool={query:db.query.bind(db),connect:async()=>({query:db.query.bind(db),release(){}})};
  try {
    await db.transaction(migrate);
    const {rows:[season]}=await db.query("INSERT INTO seasons(source_term,legacy_term,starts_on,ends_on) VALUES('N','O','2020-01-01','2020-12-31') RETURNING id");
    await db.query('INSERT INTO aggregation_rules(season_id,version,weekly_limit,grade_rules) VALUES($1,1,2,$2)',[season.id,defaultRules]);
    const rows=[{dmpId:1,name:'甲',rank:199,points:500},{dmpId:2,name:'乙',rank:200,points:400},
      {dmpId:3,name:'丙',rank:200,points:400},{dmpId:4,name:'丁',rank:202,points:300}];
    let officialTime='2020-07-01T00:00:00.000Z';
    let previous;
    const client={official:async(_,saved)=>{previous=saved;return {time:officialTime,rows};}};
    await enqueue(db,'official-only',{season:season.id},'official-only',3);
    assert.equal(await claim(db,false),undefined);
    await runJob(pool,await claim(db),{client});
    assert.equal(previous,null);
    assert.equal((await db.query('SELECT * FROM official_history')).rows.length,4);
    assert.equal((await db.query('SELECT * FROM tracked_players')).rows.length,3);
    assert.deepEqual((await db.query('SELECT type FROM fetch_jobs')).rows.map(r=>r.type),['official-only']);
    const original=officialTime;
    officialTime='2020-07-08T00:00:00.000Z';
    await enqueue(db,'official',{season:season.id},'official',3);
    await runJob(pool,await claim(db),{client});
    assert.equal(previous,original);
    assert.equal((await db.query("SELECT * FROM fetch_jobs WHERE type='personal'")).rows.length,3);
    assert.equal((await db.query("SELECT * FROM fetch_jobs WHERE type='schedule'")).rows.length,0);
    assert.deepEqual((await db.query("SELECT DISTINCT priority FROM fetch_jobs WHERE type='personal'")).rows,[{priority:1}]);
    assert.equal((await db.query('SELECT * FROM official_update_baselines')).rows.length,2);
  } finally {await db.close();}
});

test('one player validation fetches only needed dates, reports outcomes before initialization and preserves shared data',async()=>{
  const db=new PGlite();
  const pool={query:db.query.bind(db),connect:async()=>({query:db.query.bind(db),release(){}})};
  try {
    await db.transaction(migrate);
    const {rows:[season]}=await db.query("INSERT INTO seasons(source_term,legacy_term,starts_on,ends_on) VALUES('N','O','2026-11-01','2026-12-31') RETURNING id,starts_on::text,ends_on::text");
    await db.query('INSERT INTO aggregation_rules(season_id,version,weekly_limit,grade_rules) VALUES($1,1,2,$2)',[season.id,defaultRules]);
    await db.query("INSERT INTO players(dmp_id,handle_name) VALUES(1,'選手甲'),(2,'選手乙')");
    await db.query("INSERT INTO official_rankings(season_id,dmp_id,rank,points,aggregation_at) VALUES($1,1,1,250,now())",[season.id]);
    const event=(id,grade='CS')=>({eventDate:'2026-11-16',shopId:1,eventId:id,heldId:1,name:'大会'+id,grade,multiplier:'1',isTeam:id===2});
    await storeSchedule(db,season,[event(1)]);
    const personal=(id,totalPoints)=>({eventDate:'2026-11-16',key:{shopId:1,eventId:id,heldId:1},name:'大会'+id,totalPoints,placement:1});
    const calls=[];
    const client={
      personal:async player=>{calls.push(['personal',player.dmp_id]);return [personal(1,100),personal(2,90),personal(3,80),personal(4,50),personal(5,10)];},
      schedule:async(grade,from,to)=>{calls.push([grade,from,to]);return grade==='CS'?[event(2),event(3),event(99)]:grade==='GP'?[event(4,'GP')]:[];}
    };
    const key=verificationKey(season.id,1);
    await enqueue(db,'verify-player',{season:season.id,id:1},key,3);
    assert.equal(await claim(db,false),undefined);
    await runJob(pool,await claim(db),{client});
    assert.deepEqual(calls,[['personal',1],...['CS','CSE','GP','BN'].map(g=>[g,'2026-11-16','2026-11-16'])]);
    const result=await setting(db,key);
    assert.equal(result.total,240);
    assert.equal(result.difference,-10);
    assert.deepEqual(result.weekly,[{week_start:'2026-11-16',weekly_counted_points:190,extra_points:50,total_points:240}]);
    assert.deepEqual(result.results.map(r=>r.provisional_counted),[true,true,false,true]);
    assert.equal(result.unmatched[0].name,'大会5');
    assert.equal((await db.query('SELECT initialized_at FROM seasons')).rows[0].initialized_at,null);
    assert.equal((await db.query('SELECT * FROM fetch_jobs')).rows.length,1);
    assert.equal((await db.query('SELECT * FROM events')).rows.length,1);
    assert.equal((await db.query('SELECT * FROM event_results')).rows.length,0);
    assert.equal((await db.query('SELECT * FROM tracked_players')).rows.length,0);
    await enqueue(db,'verify-player',{season:season.id,id:1},key,3,{reopen:true});
    await runJob(pool,await claim(db),{client:{personal:async()=>{throw new Error('DMP HTTP 500');}}});
    assert.equal((await db.query('SELECT last_error FROM fetch_jobs')).rows[0].last_error,'DMP HTTP 500');
    assert.equal((await setting(db,key)).total,240);
  } finally {await db.close();}
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/db.js';
import {borderAt,compactHistory,defaultRules,recalculate,savePlayer,storeEvent,storePersonal,storeSchedule,track} from '../src/ranking.js';
test('weekly top two, team, extra, stable ties, coverage, dedup, cancellation, name changes, and history',async()=>{
  const db=new PGlite();
  try {
    await db.transaction(migrate);
    const {rows:[season]}=await db.query("INSERT INTO seasons(source_term,legacy_term,starts_on,ends_on) VALUES('N','O','2026-11-16','2026-12-31') RETURNING id,starts_on::text,ends_on::text");
    await db.query('INSERT INTO aggregation_rules(season_id,version,weekly_limit,grade_rules) VALUES($1,1,2,$2)',[season.id,defaultRules]);
    const row={eventDate:'2026-11-16',shopId:1,heldId:1,name:'匿名',grade:'CS',multiplier:'0'};
    await assert.rejects(db.transaction(tx=>storeSchedule(tx,season,[{...row,eventDate:'2026-11-15',eventId:9,isTeam:false}])),/outside season/);
    await storeSchedule(db,season,Array.from({length:5},(_,i)=>({...row,eventId:i+1,grade:i===3?'GP':'CS',isTeam:i===1})));
    const {rows:events}=await db.query('SELECT * FROM events ORDER BY id');
    await savePlayer(db,{dmpId:1,name:'旧名'});
    await track(db,season.id,1,'admin');
    await storePersonal(db,season,1,[{key:{shopId:1,eventId:1,heldId:1},name:'匿名',eventDate:row.eventDate,placement:1,totalPoints:100}]);
    for (let i=0;i<5;i++) {
      const result={dmpId:1,name:'新名',placement:1,totalPoints:[100,90,90,50,0][i]};
      await storeEvent(db,events[i],[result,result]);
      assert.deepEqual(await storeEvent(db,events[i],[result]),[]);
    }
    await savePlayer(db,{dmpId:2,name:'別名'});
    await track(db,season.id,2,'admin');
    await storePersonal(db,season,2,[{key:{shopId:1,eventId:1,heldId:1},name:'匿名',eventDate:row.eventDate,placement:1,totalPoints:240}]);
    await recalculate(db,season.id);
    const {rows:ranks}=await db.query('SELECT rank,points FROM provisional_rankings ORDER BY dmp_id');
    assert.deepEqual(ranks,[{rank:1,points:240},{rank:1,points:240}]);
    assert.equal(await borderAt(db,season.id,2,new Date()),240);
    assert.equal((await db.query('SELECT count(*)::int n FROM player_name_history WHERE dmp_id=1')).rows[0].n,2);
    assert.deepEqual((await db.query('SELECT provisional_counted FROM event_results WHERE dmp_id=1 ORDER BY event_id')).rows.map(r=>r.provisional_counted),[true,true,false,true,false]);
    await storeEvent(db,events[0],[],{allowCancellation:true});
    await track(db,season.id,2,'admin',false);
    await recalculate(db,season.id,[1]);
    assert.equal(await borderAt(db,season.id,1,new Date()),230);
    assert.equal(await borderAt(db,season.id,2,new Date()),null);
    assert.equal(await compactHistory(db,season.id),false);
    await db.query("UPDATE seasons SET finalized_at=now()-interval '40 days'");
    await db.query("INSERT INTO backup_history(status,verified_at) VALUES('verified',now())");
    await db.transaction(tx=>compactHistory(tx,season.id));
    assert.equal(await borderAt(db,season.id,1,'2099-12-31'),230);
  } finally { await db.close(); }
});

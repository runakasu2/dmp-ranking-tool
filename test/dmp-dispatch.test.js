import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/db.js';
import {DmpClient,scanEvent} from '../src/dmp.js';
import {claim,dispatchDmpRequest,enqueue} from '../src/jobs.js';
import {setSetting} from '../src/ranking.js';

const db=new PGlite();
const ready=db.transaction(migrate);
after(async()=>{await ready;await db.close();});
const metrics=[];

// PGlite has one connection. Each client checkout represents a transaction
// lifetime. Real concurrent Postgres connections exercise the same advisory lock.
function adapter() {
  let tail=Promise.resolve();
  return {
    connect:async()=>{
      const previous=tail;
      let release;
      tail=new Promise(resolve=>{release=resolve;});
      await previous;
      return {query:db.query.bind(db),release};
    }
  };
}
async function fixture() {
  await ready;
  await db.query('DELETE FROM fetch_jobs');
  await db.query('DELETE FROM app_settings');
  for(let i=0;i<2;i++) await enqueue(db,'event',{id:i+1},'dispatch:'+i,i);
  return {pool:adapter(),jobs:[await claim(db),await claim(db)],hits:[]};
}
function client(pool,job,hits,fetcher=()=>new Response('{}',{headers:{'content-type':'application/json'}})) {
  return new DmpClient({enabled:true,dispatch:start=>dispatchDmpRequest(pool,job,start),
    fetcher:(url,options)=>{hits.push(performance.now());return fetcher(url,options);}});
}
function check(hits) {
  assert.ok(hits.length>=2);
  const gaps=hits.slice(1).map((at,i)=>at-hits[i]);
  assert.ok(gaps.every(gap=>gap>=1000),JSON.stringify(gaps));
  metrics.push(...gaps);
}

test('two workers wait for actual fetch starts and overlap slow responses',async()=>{
  const {pool,jobs,hits}=await fixture();
  let resolveFirst, secondStarted=false;
  const body=new ReadableStream({start(controller){resolveFirst=()=>{controller.enqueue(new TextEncoder().encode('{}'));controller.close();};}});
  const first=client(pool,jobs[0],hits,()=>new Response(body,{headers:{'content-type':'application/json'}}));
  const second=client(pool,jobs[1],hits,()=>{
    secondStarted=true;
    resolveFirst();
    return new Response('{}',{headers:{'content-type':'application/json'}});
  });
  await Promise.all([first.request('event',{json:true}),second.request('official',{json:true})]);
  assert.ok(secondStarted);
  check(hits);
});

test('750 ms and 1250 ms pre-send DB stalls cannot compress starts',async()=>{
  const {pool,jobs,hits}=await fixture();
  const connect=pool.connect;
  let nextDelay=0;
  pool.connect=async()=>{
    const connection=await connect();
    const query=connection.query;
    const delay=nextDelay;
    nextDelay=0;
    connection.query=async(sql,args)=>{
      if(delay&&sql.includes('WITH owned AS')) await sleep(delay);
      return query(sql,args);
    };
    return connection;
  };
  const one=client(pool,jobs[0],hits);
  const two=client(pool,jobs[1],hits);
  for(const delay of [750,1250]) {
    nextDelay=delay;
    await Promise.all([one.request('event',{json:true}),two.request('official',{json:true})]);
  }
  check(hits);
});

test('simultaneously eligible requests and event pagination all use the dispatch gate',async()=>{
  const {pool,jobs,hits}=await fixture();
  const offsets=[];
  const one=client(pool,jobs[0],hits,(_,options)=>{
    const {offset}=JSON.parse(options.body);
    offsets.push(offset);
    return Response.json(offset===0?[{fixture:true}]:[]);
  });
  const mockEvent={event:async(_,offset)=>JSON.parse(await one.request('event',{body:{offset},json:true}))};
  const two=client(pool,jobs[1],hits);
  await Promise.all([scanEvent(mockEvent,{},{save:async()=>{}}),two.request('official',{json:true}),two.request('event',{json:true})]);
  assert.deepEqual(offsets,[0,30]);
  assert.equal(hits.length,4);
  check(hits);
});

test('HTTP failure and retry use the gate and the persisted cooldown remains effective',async()=>{
  const {pool,jobs,hits}=await fixture();
  const one=client(pool,jobs[0],hits,()=>hits.length===1
    ?new Response('',{status:429,headers:{'retry-after':'60'}}):Response.json({}));
  let cooldown;
  one.recordRetryAt=async retryAt=>{
    cooldown=retryAt;
    await setSetting(db,'dmp_next_request',retryAt);
  };
  await assert.rejects(one.request('event',{json:true}),error=>error.message==='DMP HTTP 429'&&error.retryAt===cooldown);
  assert.equal(hits.length,1);
  await assert.rejects(one.request('event',{json:true}),error=>error.retryAt===cooldown);
  assert.equal(hits.length,1);
  await setSetting(db,'dmp_next_request',0);
  await one.request('event',{json:true});
  check(hits);
});

test('new worker after restart observes expired ownership and spacing from the prior dispatch',async()=>{
  const {pool,jobs,hits}=await fixture();
  await client(pool,jobs[0],hits).request('event',{json:true});
  await db.query("UPDATE fetch_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[jobs[0].id]);
  const recovered=await claim(db);
  assert.notEqual(recovered.lease_token,jobs[0].lease_token);
  const restarted=adapter();
  await assert.rejects(client(restarted,jobs[0],hits).request('event',{json:true}),/Lease expired/);
  await client(restarted,recovered,hits).request('event',{json:true});
  check(hits);
});

test('losing the dispatch transaction after fetch starts aborts it and cannot shorten the next gap',async()=>{
  const {pool,jobs,hits}=await fixture();
  const connect=pool.connect;
  let failCommit=true;
  pool.connect=async()=>{
    const connection=await connect();
    const query=connection.query;
    connection.query=(sql,args)=>{
      if(sql==='COMMIT'&&failCommit) {
        failCommit=false;
        throw new Error('simulated dispatch commit failure');
      }
      return query(sql,args);
    };
    return connection;
  };
  let firstSignal;
  const first=client(pool,jobs[0],hits,(_,options)=>{
    firstSignal=options.signal;
    return Response.json({});
  });
  await assert.rejects(first.request('event',{json:true}),/simulated dispatch commit failure/);
  assert.equal(firstSignal.aborted,true);
  await client(adapter(),jobs[1],hits).request('event',{json:true});
  check(hits);
});

test('paused or budget-blocked acquisition sends nothing even after a job has been claimed',async()=>{
  const {pool,jobs,hits}=await fixture();
  const one=client(pool,jobs[0],hits);
  await setSetting(db,'paused',true);
  await assert.rejects(one.request('event',{json:true}),/Acquisition restricted/);
  await setSetting(db,'paused',false);
  await setSetting(db,'database_bytes',475000000);
  await assert.rejects(one.request('event',{json:true}),/Acquisition restricted/);
  assert.deepEqual(hits,[]);
});

after(()=>{if(metrics.length) console.log('Minimum mocked fetch start gap: '+Math.min(...metrics).toFixed(1)+' ms');});

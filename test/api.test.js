import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {createApp,bootstrap} from '../src/api.js';
import {migrate} from '../src/db.js';
import {defaultRules,recalculate,storeOfficial,storeSchedule,storeEvent,storePersonal} from '../src/ranking.js';
import {jst} from '../src/jobs.js';
import {once} from 'node:events';
import {chromium} from 'playwright';
import {existsSync} from 'node:fs';

test('HTTP integration serves ranking, settings, events, borders, watch, and guarded administration',async()=>{
  const db=new PGlite();
  const pool={query:db.query.bind(db),connect:async()=>({query:db.query.bind(db),release(){}})};
  const server=createApp(pool,{cronSecret:'only-a-test-secret',secure:true}).listen(0,'127.0.0.1');
  try {
    await once(server,'listening');
    const root='http://127.0.0.1:'+server.address().port;
    const call=(path,options)=>fetch(root+path,options);
    const post=(path,body,headers={})=>call(path,{method:'POST',headers:{'content-type':'application/json','x-dmp-request':'1',...headers},body:JSON.stringify(body)});
    await db.transaction(migrate);
    await bootstrap(db,'fixture','fixture-passphrase');
    const day=jst().slice(0,10);
    const {rows:[season]}=await db.query("INSERT INTO seasons(source_term,legacy_term,starts_on,ends_on) VALUES('20262','2026',$1,$1) RETURNING id,starts_on::text,ends_on::text",[day]);
    await db.query('INSERT INTO aggregation_rules(season_id,version,weekly_limit,grade_rules) VALUES($1,1,2,$2)',[season.id,defaultRules]);
    await storeOfficial(db,season,{time:new Date().toISOString(),rows:[{dmpId:1,name:'匿名の選手',rank:1,points:200}]});
    assert.deepEqual(await (await call('/api/rankings')).json(),[]);
    await storeSchedule(db,season,[{eventDate:day,shopId:1,eventId:1,heldId:1,name:'匿名の大会',grade:'CS',multiplier:'1',isTeam:false}]);
    await storeEvent(db,{id:1},[{dmpId:1,name:'匿名の選手',placement:1,totalPoints:200}]);
    await storePersonal(db,season,1,[]);
    await recalculate(db,season.id);
    const api=async path=>{const response=await call(path);assert.equal(response.status,200,path);return response.json();};
    assert.equal((await api('/api/rankings?q=匿名'))[0].points,200);
    assert.equal((await api('/api/rankings?mode=official'))[0].official_rank,1);
    assert.equal((await api('/api/players/1')).events.length,1);
    assert.equal((await api('/api/borders?n=1')).provisional.at(-1).points,200);
    assert.equal((await api('/api/events'))[0].event_name,'匿名の大会');
    const counted=await api('/api/events?period=past&meta=1');
    assert.equal(counted.total,1);
    assert.equal(counted.events[0].display_status,'registered');
    assert.equal((await api('/api/events?period=upcoming&meta=1')).total,0);
    assert.equal((await api('/api/events/1')).rows[0].total_points,200);
    const publicState=await api('/api/state');
    assert.equal(publicState.progress.ready,1);
    assert.deepEqual(publicState.counts,{registered:1,unregistered:0,personal_saved:0,event_api_fetched:0,reflected:0,reflection_unconfirmed:1});
    assert.equal((await call('/admin/api/status')).status,401);
    assert.equal((await api('/api/state')).cron.status,'unverified');
    assert.equal((await post('/internal/cron',{})).status,401);
    assert.equal((await db.query("SELECT key FROM app_settings WHERE key='cron_receipt'")).rows.length,0);
    assert.equal((await post('/internal/cron',{},{'x-cron-secret':'only-a-test-secret'})).status,202);
    const cron=(await api('/api/state')).cron;
    assert.equal(cron.status,'healthy');
    assert.ok(cron.last_received_at);
    assert.equal((await post('/api/watch',{ids:[1,1]},{'sec-fetch-site':'cross-site'})).status,403);
    assert.equal((await post('/api/watch',{ids:[1,1]})).status,204);
    assert.deepEqual((await db.query('SELECT reasons FROM tracked_players')).rows[0].reasons,['official','watch']);
    const auth=await post('/admin/api/login',{login:'fixture',password:'fixture-passphrase'});
    assert.equal(auth.status,204);
    const token=auth.headers.get('set-cookie');
    assert.match(token,/HttpOnly; Secure; SameSite=Strict/);
    const cookie=token.split(';')[0];
    assert.equal((await call('/admin/api/status',{headers:{cookie}})).status,200);
    const action=body=>post('/admin/api/action',body,{cookie});
    assert.equal((await call('/admin/api/held-results')).status,401);
    assert.equal((await call('/admin/api/held-results',{headers:{cookie}})).status,200);
    assert.equal((await call('/.env')).status,404);
    assert.equal((await call('/backups/db/before-008.dump')).status,404);
    assert.equal((await call('/admin/api/queue-migration')).status,401);
    for(const kind of ['traffic','official','database']) {
      const metrics=await call('/admin/api/telemetry?kind='+kind,{headers:{cookie}});
      assert.equal(metrics.status,200,kind);
      const response=await metrics.json();
      assert.ok(Object.hasOwn(response,{traffic:'slots',official:'time',database:'database'}[kind]),kind);
    }
    const beforeCandidatePreview=(await db.query('SELECT count(*)::int n FROM fetch_jobs')).rows[0].n;
    const candidatesResponse=await call('/admin/api/candidates',{headers:{cookie}});
    assert.equal(candidatesResponse.status,200);
    assert.equal((await candidatesResponse.json()).selected.length,0);
    assert.equal((await db.query('SELECT count(*)::int n FROM fetch_jobs')).rows[0].n,beforeCandidatePreview);
    assert.equal((await action({action:'register-candidates'})).status,400);
    const preview=await (await call('/admin/api/queue-migration',{headers:{cookie}})).json();
    assert.equal(preview.total,0);
    assert.equal((await action({action:'queue-migration'})).status,400);
    assert.equal((await action({action:'queue-migration',confirm:true})).status,409);
    await db.query(`INSERT INTO app_settings(key,value) VALUES('database_bytes','490000000')`);
    const restricted=await (await call('/admin/api/status',{headers:{cookie}})).json();
    assert.equal(restricted.acquisition.level,3);
    assert.equal((await call('/api/rankings?mode=official')).status,200);

    await db.query("INSERT INTO players(dmp_id,handle_name) VALUES(910003,'試験選手C&#128167;')");
    await db.query('INSERT INTO official_rankings(season_id,dmp_id,rank,points,aggregation_at) VALUES($1,910003,250,1,now())',[season.id]);
    const [displayed]=await api('/api/rankings?mode=official&q=910003');
    assert.equal(displayed.display_name,'試験選手C💧');
    assert.equal(displayed.handle_name,'試験選手C&#128167;');
    assert.equal((await api('/api/players/910003')).player.display_name,'試験選手C💧');
    for(const q of ['試験選手C💧','試験選手C&#128167;']) {
      const matching=await api('/api/rankings?mode=official&'+new URLSearchParams({q}));
      assert.equal(matching[0].dmp_id,910003);
      assert.equal(matching[0].display_name,'試験選手C💧');
    }
    assert.equal((await call('/admin/api/queue-review',{headers:{cookie}})).status,200);
    assert.equal((await action({action:'queue-review',confirm:true})).status,409);

    const {rows:retryJobs}=await db.query(`INSERT INTO fetch_jobs(type,payload,dedupe_key,priority,status,attempts)
      VALUES('personal',jsonb_build_object('season',$1::text,'id',910003),'identity:retry',4,'failed',5),
        ('personal',jsonb_build_object('season',$1::text,'id',1),'identity:finished',4,'done',0)
      RETURNING id`,[season.id]);
    assert.equal((await action({action:'reset-job',id:retryJobs[0].id})).status,202);
    assert.deepEqual((await db.query('SELECT status,attempts FROM fetch_jobs WHERE id=ANY($1::bigint[]) ORDER BY id',
      [retryJobs.map(row=>row.id)])).rows,[{status:'pending',attempts:0},{status:'done',attempts:0}]);
    await db.query("DELETE FROM fetch_jobs WHERE dedupe_key IN ('identity:retry','identity:finished')");

    await db.query("INSERT INTO players(dmp_id,handle_name) VALUES(2,'補完待ち'),(3,'範囲外')");
    await db.query(`INSERT INTO official_rankings(season_id,dmp_id,rank,points,aggregation_at)
      VALUES($1,2,200,20,now()),($1,3,201,10,now())`,[season.id]);
    assert.equal((await action({action:'official-only'})).status,202);
    assert.equal((await action({action:'initialize'})).status,202);
    assert.equal((await action({action:'initialize'})).status,202);
    assert.deepEqual((await db.query("SELECT payload->>'id' AS id FROM fetch_jobs WHERE type='personal'")).rows,[{id:'2'}]);
    assert.equal((await action({action:'complete-personal'})).status,202);
    assert.equal((await db.query("SELECT * FROM fetch_jobs WHERE type='complete-personal'")).rows.length,1);
    assert.equal((await call('/admin/api/completion')).status,401);
    const progress=await (await call('/admin/api/completion',{headers:{cookie}})).json();
    assert.deepEqual([progress.total,progress.fetched,progress.matched,progress.calculated],[2,1,1,1]);
    const verification=await action({action:'verify-player',query:'範囲外'});
    assert.equal(verification.status,202);
    assert.equal((await verification.json()).player,3);
    assert.equal((await action({action:'verify-player',query:'3'})).status,202);
    assert.equal((await action({action:'verify-player',query:'存在しない選手'})).status,404);
    assert.equal((await db.query("SELECT count(*)::int n FROM fetch_jobs WHERE type='verify-player'")).rows[0].n,1);
    assert.equal((await call('/admin/api/verification/3')).status,401);
    assert.equal((await (await call('/admin/api/verification/3',{headers:{cookie}})).json()).job.status,'pending');
    assert.equal((await action({action:'schedule',value:{high:[60,30,10],official:[60,30,5,15]}})).status,202);
    assert.equal((await action({action:'multiplier-ranges',value:{CS:{'1':64}}})).status,202);
    assert.equal((await action({action:'multiplier-ranges',value:{CS:{'1':-1}}})).status,400);
    assert.equal((await action({action:'rules',limit:2,grades:defaultRules})).status,202);
    assert.equal((await action({action:'track',id:1})).status,202);
    assert.equal((await action({action:'track',id:1,value:false})).status,202);
    assert.equal((await action({action:'event',id:1})).status,202);
    assert.equal((await action({action:'personal',id:1})).status,202);
    assert.equal((await action({action:'backup'})).status,202);
    assert.equal((await action({action:'finalize'})).status,409);
    const future=new Date(Date.parse(day)+86400000).toISOString().slice(0,10);
    assert.equal((await action({action:'create-season',starts:future,ends:future,term:'20271',legacyTerm:'20271'})).status,202);
    assert.equal((await action({action:'pause',value:true})).status,202);
    assert.equal((await action({action:'pause',value:false})).status,202);
    assert.equal((await post('/admin/api/logout',{},{cookie})).status,204);
    assert.equal((await call('/admin/api/status',{headers:{cookie}})).status,401);
    const page=await call('/');
    assert.match(await page.text(),/viewport.*width=device-width/);
    assert.match(page.headers.get('x-robots-tag'),/noindex/);
    assert.match(await (await call('/style.css')).text(),/@media\(max-width:560px\)/);
    const longName='とても長いハンドルネーム'.repeat(8);
    await db.query('UPDATE players SET handle_name=$1 WHERE dmp_id=910003',[longName]);
    await db.query(`INSERT INTO tracked_players(season_id,dmp_id,reasons,backfill_status) VALUES($1,910003,ARRAY['admin'],'ready')`,[season.id]);
    await db.query(`INSERT INTO provisional_rankings(season_id,dmp_id,rank,points,coverage,status,calculated_at)
      VALUES($1,910003,2,100,'tracked-only','ready',now())`,[season.id]);
    const localChrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const executablePath=process.env.CHROME_PATH ?? (existsSync(localChrome)?localChrome:undefined);
    const browser=await chromium.launch({executablePath});
    try {
      const mobile=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true});
      const errors=[];
      mobile.on('pageerror',error=>errors.push(error.message));
      await mobile.goto(root);
      await mobile.getByRole('link',{name:'匿名の選手',exact:true}).waitFor();
      await mobile.getByRole('button',{name:'DMP ID 1 ウォッチ'}).click();
      await mobile.getByRole('link',{name:'ウォッチ',exact:true}).click();
      await mobile.getByRole('heading',{name:'ウォッチリスト'}).waitFor();
      await mobile.getByRole('link',{name:'匿名の選手',exact:true}).click();
      await mobile.getByRole('heading',{name:'大会成績'}).waitFor();
      await mobile.waitForFunction(()=>{
        const canvas=document.querySelector('canvas[aria-label="週別採用ポイント"]');
        return canvas?.clientWidth&&canvas.width===canvas.clientWidth*devicePixelRatio;
      });
      await mobile.locator('.chart-readout').last().filter({hasText:/週間pt.*200 pt/}).waitFor();
      await mobile.getByText('採用のみ',{exact:true}).click();
      assert.equal(await mobile.locator('[name=only]').isChecked(),true);
      await mobile.getByRole('button',{name:'DMP ID 1 ウォッチ'}).click();
      assert.equal(await mobile.evaluate(()=>JSON.parse(localStorage.getItem('dmp-watch')).length),0);
      await mobile.getByRole('link',{name:'設定',exact:true}).click();
      await mobile.locator('[name=border]').fill('16');
      await mobile.getByRole('button',{name:'設定を保存'}).click();
      assert.equal(await mobile.evaluate(()=>JSON.parse(localStorage.getItem('dmp-border'))),16);
      await mobile.getByRole('link',{name:'ボーダー',exact:true}).click();
      await mobile.getByRole('heading',{name:'16位ボーダー'}).waitFor();
      await mobile.getByRole('img',{name:'暫定と公式のボーダー推移'}).waitFor();
      assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth===innerWidth),true);
      await mobile.getByRole('link',{name:'大会',exact:true}).click();
      await mobile.getByRole('link',{name:'匿名の大会'}).click();
      await mobile.getByRole('link',{name:'公式大会ページを開く'}).waitFor();
      await mobile.goto(root+'/admin');
      await mobile.getByLabel('ログイン',{exact:true}).fill('fixture');
      await mobile.getByLabel('パスワード').fill('fixture-passphrase');
      await mobile.getByRole('button',{name:'ログイン',exact:true}).click();
      await mobile.getByRole('button',{name:'更新管理',exact:true}).click();
      await mobile.locator('summary').filter({hasText:/^初期動作確認$/}).click();
      await mobile.getByRole('button',{name:'公式ランキングのみ取得'}).waitFor();
      await mobile.getByRole('button',{name:'全体の初期化開始'}).waitFor();
      await mobile.getByRole('button',{name:'不足大会を補完'}).waitFor();
      await mobile.getByRole('button',{name:'概要',exact:true}).click();
      const completion=mobile.getByRole('region',{name:'初期化の進捗'});
      await completion.getByText('個人成績取得済み人数').waitFor();
      await completion.getByText('1 / 2',{exact:true}).first().waitFor();
      await db.query("UPDATE tracked_players SET backfill_status='ready' WHERE dmp_id=2");
      await mobile.getByRole('button',{name:'ジョブ・ログ',exact:true}).click();
      await mobile.getByRole('button',{name:'解析保留を確認'}).click();
      await mobile.getByText(/順位空欄の再試行対象 .*要調査/).waitFor();
      await mobile.getByRole('button',{name:'待機キューの再分類をプレビュー'}).click();
      await mobile.getByText(/P1維持 .*P4へ変更/).waitFor();
      await mobile.locator('summary').filter({hasText:/^ジョブ$/}).click();
      await mobile.locator('summary').filter({hasText:/^取得ログ$/}).click();
      const {rows:[live]}=await db.query(`INSERT INTO fetch_jobs(type,payload,dedupe_key,priority,status,lease_token,started_at)
        VALUES('complete-schedule','{}','test:telemetry',1,'running','00000000-0000-0000-0000-000000000001',clock_timestamp()-interval '91 seconds') RETURNING id,lease_token`);
      await db.query(`INSERT INTO fetch_job_progress(job_id,lease_token,phase) VALUES($1,$2,'personal_replay')`,[live.id,live.lease_token]);
      await db.query(`INSERT INTO fetch_logs(job_id,status,bytes,duration,started_at,finished_at,phase_ms)
        VALUES($1,'done',1250000,62000,clock_timestamp()-interval '62 seconds',clock_timestamp(),'{"schedule_store":1000}')`,[live.id]);
      await mobile.getByRole('cell',{name:'保存済み明細の再照合'}).waitFor();
      await mobile.getByRole('cell',{name:'1.25 MB'}).waitFor();
      await mobile.getByRole('cell',{name:'1分 2秒'}).waitFor();
      await mobile.getByRole('cell',{name:'大会保存 1.00秒'}).waitFor();

      await mobile.getByRole('button',{name:'概要',exact:true}).click();
      await completion.getByText('2 / 2',{exact:true}).first().waitFor();
      await mobile.getByRole('button',{name:'システム設定',exact:true}).click();
      const candidateLimit=mobile.getByLabel('候補選手の1日上限');
      await candidateLimit.fill('37');
      await mobile.evaluate(()=>{
        Object.defineProperty(document,'hidden',{configurable:true,value:true});
        document.dispatchEvent(new Event('visibilitychange'));
      });
      let hiddenPolls=0;
      const countPoll=request=>{if(/admin\/api\/(completion|telemetry)/.test(request.url())) hiddenPolls++;};
      mobile.on('request',countPoll);
      await mobile.waitForTimeout(5400);
      assert.equal(hiddenPolls,0);
      const resumed=mobile.waitForResponse(response=>response.url().includes('/admin/api/completion'));
      await mobile.evaluate(()=>{
        Object.defineProperty(document,'hidden',{configurable:true,value:false});
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await resumed;
      mobile.off('request',countPoll);
      assert.equal(await candidateLimit.inputValue(),'37');
      await mobile.getByRole('button',{name:'選手管理',exact:true}).click();
      await mobile.getByRole('button',{name:'候補再判定をプレビュー'}).click();
      await mobile.getByText(/200位 .*取得対象 0人.*残り/).waitFor();
      await mobile.getByText('候補判定の詳細',{exact:true}).click();
      await mobile.getByLabel('候補判定理由').selectOption('below-border');

      await mobile.getByRole('button',{name:'集計検証',exact:true}).click();
      await mobile.getByText('成績の変更差分').waitFor();
      await mobile.getByLabel('DMP ID またはハンドルネーム（完全一致）').fill('範囲外');
      await mobile.getByRole('button',{name:'この選手を検証'}).click();
      await mobile.getByText(/範囲外（DMP ID 3）.*待機中/).waitFor();
      await mobile.getByRole('button',{name:'更新管理',exact:true}).click();
      await mobile.getByRole('link',{name:'公式ランキングを開く'}).click();
      await mobile.getByRole('button',{name:'公式',exact:true,pressed:true}).waitFor();
      await mobile.getByRole('link',{name:'匿名の選手',exact:true}).waitFor();
      assert.equal(await mobile.locator('.official-table thead th').count(),4);
      await mobile.getByRole('button',{name:'暫定との差分'}).click();
      await mobile.locator('.official-table th').nth(5).waitFor();
      await mobile.getByRole('button',{name:'暫定との差分'}).click();
      await mobile.waitForFunction(()=>document.querySelectorAll('.official-table th').length===4);
      await mobile.getByRole('searchbox',{name:'HN / DMP ID'}).fill('匿名');
      await mobile.getByRole('button',{name:'検索',exact:true}).click();
      await mobile.waitForFunction(()=>document.querySelectorAll('.official-table tbody tr').length===1,null,{timeout:8000});
      await mobile.getByRole('searchbox',{name:'HN / DMP ID'}).fill('');
      await mobile.getByRole('button',{name:'検索',exact:true}).click();
      await mobile.getByRole('button',{name:'暫定',exact:true}).click();
      await mobile.locator('.provisional-table tbody tr').first().waitFor();
      for(const width of [375,390,430,1280]){
        await mobile.setViewportSize({width,height:844});
        const dimensions=await mobile.evaluate(()=>{
          const table=document.querySelector('.ranking .table-wrap')??document.querySelector('.ranking');
          const nav=document.querySelector('.bottom');
          return {noOverflow:document.documentElement.scrollWidth===innerWidth,
            visible:table.getBoundingClientRect().top<innerHeight/2,
            fixed:getComputedStyle(nav).position==='fixed'};
        });
        assert.equal(await mobile.locator('.ranking-dates').count(),1);
        const header=mobile.locator('.ranking thead th').first();
        assert.equal(await header.locator(width<560?'.heading-short':'.heading-full').isVisible(),true);
        assert.deepEqual(dimensions,{noOverflow:true,visible:true,fixed:width<700},'viewport '+width);
        assert.equal(await mobile.getByRole('link',{name:longName,exact:true}).evaluate(node=>node.scrollWidth>node.clientWidth),true);
      }
      const desktop=await browser.newPage({viewport:{width:1280,height:900}});
      await desktop.goto(root);
      await desktop.locator('.provisional-table tbody tr').first().waitFor();
      assert.equal(await desktop.locator('.ranking thead th').first().locator('.heading-full').isVisible(),true);
      await desktop.getByRole('cell',{name:'未取得',exact:true}).first().waitFor();
      const icon=await call('/favicon.svg');
      assert.match(icon.headers.get('content-type'),/image\/svg/);
      assert.match(await icon.text(),/#a4c8ff/);
      for(const surface of [desktop,mobile]){
        await surface.goto(root+(surface===mobile?'/admin':'/'));
        assert.equal(await surface.locator('link[rel=icon]').getAttribute('href'),'/favicon.svg');
        for(const size of [16,32]){
          assert.equal(await surface.evaluate(async size=>{
            const image=new Image();image.src=document.querySelector('link[rel=icon]').href;await image.decode();
            const canvas=document.createElement('canvas');canvas.width=canvas.height=size;
            const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0,size,size);
            const {data}=ctx.getImageData(0,0,size,size);
            return [...data].some((value,i)=>i%4===0&&value>=140&&data[i+2]>=230&&data[i+3]>0);
          },size),true);
        }
      }
      await desktop.evaluate(()=>localStorage.setItem('dmp-watch','[1,2,3,4,5]'));
      let reads=0;
      await desktop.route('**/api/rankings?*',async route=>{
        const url=new URL(route.request().url());
        if(!url.searchParams.has('ids')) return route.continue();
        assert.equal(url.searchParams.has('limit'),false);
        reads++;
        const names=['首位選手','同点A','同点B','ゼロ選手','未取得選手'];
        const provisional=[200,120,120,0,null],official=[90,150,90,0,200];
        await route.fulfill({json:url.searchParams.get('ids').split(',').map(Number).map(id=>({
          dmp_id:id,display_name:names[id-1],provisional_points:provisional[id-1],provisional_rank:id===5?null:id+300,
          official_points:official[id-1],official_rank:id+400
        }))});
      });
      await desktop.goto(root+'/?fixture=watch#watch');
      const cells=()=>desktop.locator('.watch-table tbody tr').evaluateAll(rows=>rows.map(row=>[...row.cells].map(c=>c.textContent)));
      await desktop.locator('.watch-table tbody tr').nth(4).waitFor();
      const rankings=rows=>rows.map(r=>[r[0],r[3],r[5]]);
      assert.deepEqual(rankings(await cells()),[['1','200','0'],['2','120','80'],['2','120','80'],['4','0','200'],['未確定','未取得','—']]);
      await desktop.getByRole('button',{name:'公式',exact:true}).click();
      assert.deepEqual(rankings(await cells()),[['1','200','0'],['2','150','50'],['3','90','110'],['3','90','110'],['5','0','200']]);
      assert.equal(reads,1);
      await desktop.getByRole('button',{name:'DMP ID 5 ウォッチ'}).click();
      assert.deepEqual((await cells()).map(r=>r[0]),['1','2','2','4']);
      assert.equal(reads,1);
      await desktop.reload();
      await desktop.getByRole('heading',{name:'ウォッチリスト（4人）'}).waitFor();
      const seasonSelector=desktop.getByLabel('対象期',{exact:true});
      const alternatives=await seasonSelector.locator('option').evaluateAll(items=>items.map(item=>item.value));
      const present=await seasonSelector.inputValue();
      const target=alternatives.find(id=>id!==present);
      assert.ok(target);
      const nextSeason=desktop.waitForRequest(r=>r.url().includes('/api/rankings?')&&new URL(r.url()).searchParams.get('season')===target);
      await seasonSelector.selectOption(target);
      await nextSeason;
      await desktop.locator('.watch-table tbody tr').nth(3).waitFor();
      for(const width of [375,390,430,1280]){
        await desktop.setViewportSize({width,height:844});
        assert.equal(await desktop.evaluate(()=>document.documentElement.scrollWidth===innerWidth),true);
        assert.equal(await desktop.locator('.watch-table thead th:visible').count(),6);
      }
      await desktop.close();
      assert.deepEqual(errors,[]);
    } finally {await browser.close();}
  } finally {server.close();await db.close();}
});

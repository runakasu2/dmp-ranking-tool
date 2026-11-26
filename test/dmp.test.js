import {test} from 'node:test';
import assert from 'node:assert/strict';
import iconv from 'iconv-lite';
import {DmpClient, scanEvent, unwrap, retryAfter, formHN, eventRow, officialRows, personalRows} from '../src/dmp.js';
const envelope = rows => JSON.stringify({d:JSON.stringify(rows)});
test('CP932 schedule detects registered ×0 and sends the requested form',async () => {
  const html = '<table id="main"><tr><th>開催日</th><th>大会名</th><th>開催地</th><th>店舗/団体</th><th>フォー　マット</th><th>参加 形式</th><th>倍率</th><th>承認</th></tr><tr onclick="result.asp?ShopID=2&amp;EventID=3&amp;Seq=1"><td>26/11/22</td><td>匿名大会</td><td>東京</td><td>店舗</td><td>殿堂</td><td>チーム</td><td>×0</td><td>承認</td></tr></table>';
  const client = new DmpClient({enabled:true,dispatch:start=>start(),fetcher:async(url,init)=>{
    assert.equal(url.pathname,'/schedule.asp');
    assert.equal(new URLSearchParams(init.body).get('EventFrom'),'2026/11/19');
    return new Response(iconv.encode(html,'cp932'),{headers:{'content-type':'text/html'}});
  }});
  const [event] = await client.schedule('CS','2026-11-19','2026-11-25');
  assert.equal(event.name,'匿名大会');
  assert.equal(event.multiplier,'0');
  assert.equal(event.isTeam,true);
});
test('short and zero-point pages continue at increments of 30, resuming at checkpoint',async () => {
  const offsets = [];
  const client = {event:async (_,offset)=>{offsets.push(offset);return offset === 90 ? [] : [{totalPoints:offset === 60 ? 0 : 1}];}};
  let checkpoint;
  const save = async (_,__,next)=>{checkpoint=next;};
  assert.equal((await scanEvent(client,{},{pages:2,save})).complete,false);
  assert.equal((await scanEvent(client,{},{offset:checkpoint,save})).complete,true);
  assert.deepEqual(offsets,[0,30,60,90]);
});
test('point blanks differ from zero and malformed responses fail',()=>{
  const row={ShopID:'2',EventID:'3',HeldID:'1',MemberID:'4',Rank:'129',HandleName:'匿名',RankPoint:'',JudgePoint:'0'};
  const key={shopId:2,eventId:3,heldId:1};
  assert.equal(eventRow(row,key).rankPoints,null);
  assert.equal(eventRow(row,key).judgeBonus,0);
  assert.throws(()=>eventRow({...row,RankPoint:undefined},key));
  assert.throws(()=>unwrap('{"d":[]}'));
  assert.throws(()=>unwrap('{"d":"{}"}'));
  assert.throws(()=>officialRows([{MemberID:1,HandleName:'匿名',Rank:2,Point:1}]));
});
test('429 retains Retry-After and CP932 name matches expected encoding',async()=>{
  assert.equal(formHN('あ'),'%82%A0');
  assert.equal(retryAfter('30',0),30000);
  const client=new DmpClient({enabled:true,dispatch:start=>start(),fetcher:async()=>new Response('',{status:429,headers:{'retry-after':'60'}})});
  await assert.rejects(client.officialTime('20262'),error=>error.retryAt>=Date.now()+59000);
});
test('personal table parses yellow and total without fabricating component points',()=>{
  const rows=personalRows('<table id=result><tr><th>開催日</th><th>大会名</th><th>順位</th><th>ポイント</th></tr><tr style="color:#ffff00" onclick="result.asp?ShopID=2&amp;EventID=3&amp;Seq=0"><td>2026/11/22</td><td>匿名</td><td>1位</td><td>132pts</td></tr></table>');
  assert.equal(rows[0].totalPoints,132);
  assert.equal(rows[0].officialCounted,true);
  assert.equal(rows[0].key.heldId,0);
});
test('official timestamp switch aborts the snapshot',async()=>{
  let clocks=0;
  const client=new DmpClient({enabled:true,dispatch:start=>start(),fetcher:async url=>{
    if(url.pathname==='/ranking.asp') return new Response('前回集計日時：2026/11/18 15:01:0'+clocks++,{headers:{'content-type':'text/html; charset=utf-8'}});
    return new Response(envelope(Array.from({length:201},(_,i)=>({MemberID:i+1,HandleName:'匿名'+i,Rank:i+1,Point:500-i}))),{headers:{'content-type':'application/json'}});
  }});
  await assert.rejects(client.official({legacy_term:'A',source_term:'B'}),/changed/);
});
test('actual Japanese field names and the GP pattern continue past zero-point pages',async()=>{
  const key={shopId:3954,eventId:359,heldId:1,eventDate:'2026-11-15'};
  const counts=new Map([[240,17],[270,1],[300,1]]);
  const offsets=[],buffer=[];
  const client=new DmpClient({enabled:true,dispatch:start=>start(),fetcher:async(_,init)=>{
    const request=JSON.parse(init.body);
    assert.equal(request.year,'2026/11/15 0:00:00');
    offsets.push(request.offset);
    const rows=Array.from({length:counts.get(request.offset)??0},(_,i)=>({
      店舗ID:'3954',大会ID:'359',開催ID:'1',成績ID:String(request.offset+i),会員ID:String(request.offset+i),
      順位:String(request.offset+i+1),順位ポイント:request.offset===240&&i<16?'150':'',ジャッジ加算:'',
      ハンドルネーム:'匿名',集計対象:'1',最終更新日時:'2026/11/15 16:09:32'
    }));
    return new Response(envelope(rows),{headers:{'content-type':'application/json'}});
  }});
  const result=await scanEvent(client,key,{offset:240,save:async(_,rows)=>buffer.push(...rows)});
  assert.equal(result.complete,true);
  assert.deepEqual(offsets,[240,270,300,330]);
  assert.equal(buffer.filter(r=>r.totalPoints===150).length,16);
  assert.equal(buffer.filter(r=>r.rankPoints===null).length,3);
});
test('personal fetch verifies the HN, excludes other seasons and accepts zero-point rows without a rank',async()=>{
  let identity='匿名';
  const client=new DmpClient({enabled:true,dispatch:start=>start(),fetcher:async()=>{
    const html='<span class=tx1618><b>'+identity+'</b></span><table id=result><tr><th>開催日</th><th>大会</th><th>順位</th><th>ポイント</th></tr>'
      +'<tr><td>2026/10/01</td><td>匿名大会</td><td>－</td><td>0pts</td></tr><tr><td>2026/09/30</td><td>過去大会</td><td>1位</td><td>12pts</td></tr></table>';
    return new Response(iconv.encode(html,'cp932'),{headers:{'content-type':'text/html; charset=Shift_JIS'}});
  }});
  const season={starts_on:'2026-10-01',ends_on:'2027-03-31',legacy_term:'20262'};
  const rows=await client.personal({handle_name:'匿名'},season);
  assert.equal(rows.length,1);
  assert.equal(rows[0].placement,null);
  identity='別人';
  await assert.rejects(client.personal({dmp_id:42,handle_name:'匿名'},season),error=>{
    assert.match(error.message,/Unexpected personal history identity: dmp=42 headings=1 table=1 expected=[0-9a-f]{8} got=[0-9a-f]{8} normalized=false/);
    assert.doesNotMatch(error.message,/匿名|別人/);
    return true;
  });
});

const identitySeason={starts_on:'2026-10-01',ends_on:'2027-03-31',legacy_term:'20262'};
function identityFixture(heading,verifyBody=()=>{}) {
  return new DmpClient({enabled:true,dispatch:start=>start(),fetcher:async(_,request)=>{
    verifyBody(request.body);
    const html='<span class=tx1618><b>'+heading+'</b></span><table id=result><tr><th>開催日</th><th>大会</th><th>順位</th><th>ポイント</th></tr>'
      +'<tr><td>2026/10/01</td><td>テスト</td><td>－</td><td>0pts</td></tr></table>';
    return new Response(iconv.encode(html,'cp932'),{headers:{'content-type':'text/html; charset=Shift_JIS'}});
  }});
}

test('uses the source spelling for the form and the exact once-decoded name for identity',async()=>{
  const cases=[
    [910001,'試験&#12316;A','試験〜A'],
    [910002,'試験&#12316;B、例','試験〜B、例'],
    [910003,'試験選手C&#128167;','試験選手C💧'],
    [1,'絵文字&#x1F4A7;','絵文字💧'],
    [2,'匿名 & 仲間','匿名 & 仲間','匿名 &amp; 仲間']
  ];
  for(const [dmp_id,raw,expected,heading=raw] of cases){
    const client=identityFixture(heading,body=>assert.ok(body.startsWith('UserID='+formHN(raw)+'&')));
    const rows=await client.personal({dmp_id,handle_name:raw},identitySeason,undefined,
      {nameCollision:name=>{assert.equal(name,expected);return false;}});
    assert.equal(rows.length,1);
  }
});

test('rejects collisions and different or ambiguous upstream headings',async()=>{
  const player={dmp_id:910003,handle_name:'試験選手C&#128167;'};
  const options={nameCollision:async()=>false};
  const client=identityFixture('試験選手C&#128167;',()=>assert.fail('Ambiguous name was fetched'));
  await assert.rejects(client.personal(player,identitySeason,undefined,{nameCollision:async()=>true}),/ambiguous name/);
  await assert.rejects(client.personal(player,identitySeason),/ambiguous name/);
  await assert.rejects(identityFixture('別人').personal(player,identitySeason,undefined,options),/Unexpected personal history identity/);
  await assert.rejects(identityFixture('試験選手C&#128167;</b><b>別人').personal(player,identitySeason,undefined,options),/headings=2/);
});

test('rejects malformed and nested references without relaxing the upstream comparison',async()=>{
  const client=identityFixture('匿名',()=>assert.fail('Invalid name was fetched'));
  const options={nameCollision:async()=>false};
  for(const raw of ['匿名&#12316','匿名&#;','匿名&#xZZ;','匿名&#0;','匿名&#55296;','匿名&#1114112;',
    '匿名&amp;#12316;','匿名&#38;#12316;','匿名&#38;amp;#12316;']){
    await assert.rejects(client.personal({dmp_id:1,handle_name:raw},identitySeason,undefined,options),/invalid character reference/);
  }
  const player={dmp_id:910001,handle_name:'試験&#12316;A'};
  for(const heading of ['な&#12316まちゃ','な&amp;#12316;まちゃ','な&#65374;まちゃ']){
    await assert.rejects(identityFixture(heading).personal(player,identitySeason,undefined,options),/Unexpected personal history identity/);
  }
});

test('malformed event integers record field and pagination context without exposing text values',async()=>{
  const privateText='sensitive arbitrary text, not logged';
  const mock=new DmpClient({enabled:true,dispatch:start=>start(),fetcher:async()=>Response.json({
    d:JSON.stringify([{ShopID:2,EventID:3,HeldID:4,MemberID:123,Rank:privateText,HandleName:'fixture',RankPoint:'',JudgePoint:null}])
  })});
  await assert.rejects(mock.event({shopId:2,eventId:3,heldId:4,eventDate:'2026-11-25'},30),error=>{
    assert.equal(error.eventInteger,true);
    assert.match(error.message,/event=2\/3\/4 offset=30 \[placement\] value=text/);
    assert.ok(!error.message.includes(privateText));
    return true;
  });
});

test('explicit zero with a valid player and blank placement is saved as unranked; ambiguous scores fail closed',()=>{
  const key={shopId:2,eventId:3,heldId:4};
  const zero={ShopID:2,EventID:3,HeldID:4,MemberID:42,Rank:'',HandleName:'fixture',RankPoint:'0',JudgePoint:null};
  assert.equal(eventRow(zero,key).placement,null);
  assert.equal(eventRow({...zero,Rank:null},key).totalPoints,0);
  assert.throws(()=>eventRow({...zero,RankPoint:'',JudgePoint:null},key),/points=unconfirmed/);
  assert.throws(()=>eventRow({...zero,RankPoint:'20'},key),/points=positive/);
  assert.throws(()=>eventRow({...zero,MemberID:0},key),/\[dmpId\]/);
  assert.throws(()=>eventRow({...zero,Rank:undefined},key),/\[placement\]/);
  assert.throws(()=>eventRow({...zero,Rank:1,RankPoint:'1,,0'},key),/\[rankPoints\]/);
  assert.throws(()=>officialRows([{MemberID:1,HandleName:'fixture',Rank:1,Point:'1,2'}]),/Invalid integer/);
});

import {api,el,pt,seasonLabel,table} from './ui.js';

const login=document.querySelector('#login');
const notice=document.querySelector('#admin-notice');
const area=document.querySelector('#admin');
let season='';
let activeSection='overview';
let pollLifecycle=new AbortController();
const selectedPlayers=new Map();
const endpoint='/admin/api/';
const getSeasons=()=>api('/api/seasons');
const report=message=>{notice.textContent=message;};
const label=(text,input)=>{const node=el('label',text);node.append(input);return node;};
function control(type,name,value=''){
  const node=type==='textarea'?el('textarea',value,{name}):el('input',null,{type,name,value,required:''});
  return node;
}
async function send(body){
  const warning={'retry-blank-placement':'旧診断の順位空欄ジョブを保存済みページから再試行するため待機へ戻しますか？','queue-review':'最新のキューで再分類と追跡ジョブの整理を適用しますか？','register-candidates':'最新条件で候補を再判定し、取得ジョブを登録しますか？','queue-migration':'ドライランの結果を確認し、旧ジョブの分類を適用しますか？',rules:'集計ルールを保存して再集計しますか？',finalize:'この期を確定しますか？',recalculate:'対象期を再集計しますか？'}[body.action];
  if((warning||body.action==='track'&&body.value===false)&&!window.confirm(warning??'この選手の管理者追跡を解除しますか？'))return;
  try{
    const result=await api(endpoint+'action',{body:{season,...body}});
    report(body.action==='register-candidates'
      ?result.paused?'停止・予算制限のため登録できませんでした。':'最新条件で '+result.registered+' 件登録しました。'
      :'受け付けました。');
    await load();
  }
  catch(error){report(error.message);}
}
function form(title,fields,handler){
  const row=el('form');
  row.append(...fields,el('button',title,{type:'submit'}));
  row.onsubmit=e=>{
    e.preventDefault();
    try{handler(Object.fromEntries(new FormData(row)));}catch(error){report(error.message);}
  };
  return row;
}
function action(title,body){
  const b=el('button',title,{type:'button'});
  b.onclick=()=>send(body);return b;
}
function detail(title,content){
  const wrapper=el('details',null,{class:'panel'});wrapper.append(el('summary',title),content);return wrapper;
}
function playerVerification(seasonId,lastVerification){
  const panel=el('section',null,{class:'panel controls'});
  panel.append(el('h2','選手単位の集計検証'));
  const resultPanel=el('details');
  const output=el('div');
  resultPanel.append(el('summary','検証結果'),output);
  const status=el('p',null,{role:'status'});
  const input=control('text','query');
  input.maxLength=200;
  let requested=0;
  async function refresh(id,token){
    if(!panel.isConnected||token!==requested) return;
    try{
      const {job,result,fetchEnabled,paused}=await api(endpoint+'verification/'+id+'?'+new URLSearchParams({season:seasonId}));
      if(!panel.isConnected||token!==requested) return;
      const states={pending:'待機中',running:'取得・集計中',done:'完了',failed:'取得・集計失敗'};
      status.textContent=[(job.display_name??job.handle_name)+'（DMP ID '+job.dmp_id+'）',states[job.status],
        !fetchEnabled&&job.status==='pending'?'外部取得が無効です':null,
        paused&&job.status==='pending'?'取得処理は停止中です':null,
        job.last_error?'前回の試行エラー '+job.last_error:null].filter(Boolean).join(' ／ ');
      output.replaceChildren();
      if(result){
        const checked=new Date(result.checkedAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'});
        const missing=result.unmatched.length;
        output.append(el('p',(job.status==='done'?'検証結果':'前回成功時の結果')+' '+checked),
          el('p',(missing?'未照合分を除く暫定合計 ':'暫定合計 ')+pt(result.total)+' pt ／ 公式 '+pt(result.official?.points)
            +' pt ／ 差分（暫定 − 公式） '+(result.difference==null?'—':(result.difference>0?'+':'')+pt(result.difference))+' pt'),
          el('p','週内採用上限 '+result.weeklyLimit+'大会。差分は保存済みの公式ポイントとの比較です。',{class:'muted'}),
          el('h3','週間ポイント'),
          table(['週の開始日','通常枠pt','別枠pt','合計pt'],result.weekly.map(r=>[r.week_start,pt(r.weekly_counted_points),pt(r.extra_points),pt(r.total_points)])),
          el('h3','大会ごとの採用判定'),
          table(['開催日','大会','種別','獲得pt','集計'],result.results.map(r=>[r.event_date,r.event_name,r.grade,pt(r.total_points),
            el('span',r.provisional_counted?'✓ 採用':'対象外',{class:r.provisional_counted?'active-point':'inactive-point'})])),
          el('h3','未照合の大会 '+missing+'件'));
        if(missing) output.append(table(['開催日','大会','獲得pt'],result.unmatched.map(r=>[r.eventDate,r.name,pt(r.totalPoints)])));
      }
      if(job.status==='running'||(job.status==='pending'&&fetchEnabled&&!paused)) setTimeout(()=>refresh(id,token),4000);
    }catch(error){if(panel.isConnected&&token===requested) status.textContent=error.message;}
  }
  panel.append(form('この選手を検証',[label('DMP ID またはハンドルネーム（完全一致）',input)],async ({query})=>{
    const token=++requested;
    status.textContent='受け付けを確認中…';
    output.replaceChildren();
    try{
      const response=await api(endpoint+'action',{body:{season:seasonId,action:'verify-player',query}});
      if(token!==requested||!panel.isConnected) return;
      selectedPlayers.set(String(seasonId),response.player);
      await refresh(response.player,token);
    }catch(error){if(token===requested&&panel.isConnected) status.textContent=error.message;}
  }),status,resultPanel);
  const previous=selectedPlayers.get(String(seasonId))??lastVerification;
  if(previous) queueMicrotask(()=>refresh(previous,++requested));
  return panel;
}
const fmt=value=>value?new Date(value).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'}):'—';
const phases={prepare:'準備',waiting_lock:'DBロック待ち',schedule_fetch:'大会一覧取得',
  schedule_store:'大会保存',personal_replay:'保存済み明細の再照合',recalculate:'再集計',official_reconcile:'公式照合',
  official_fetch:'公式ランキング取得',official_store:'公式ランキング保存',personal_fetch:'個人成績取得',
  personal_store:'個人成績保存',event_fetch:'大会結果取得',event_store:'大会結果保存',plan_completion:'補完ジョブ計画',
  verify_calculation:'選手の検証集計',tracking:'追跡対象の更新',maintenance:'保守',backup:'バックアップ'};
function duration(value) {
  if(value==null) return '—';
  const seconds=Math.max(0,Number(value))/1000;
  const whole=Math.floor(seconds);
  return whole>=60?Math.floor(whole/60)+'分 '+whole%60+'秒':seconds.toFixed(2)+'秒';
}
function bytes(value) {
  const amount=Number(value??0);
  return amount>=1000000?(amount/1000000).toFixed(2)+' MB':(amount/1000).toFixed(2)+' KB';
}
function jobTable(jobs) {
  return table(['ID','優先度','種別','対象','登録理由','状態','工程','試行','開始','終了','経過','次回','エラー','操作'],jobs.map(r=>[
    r.id,r.legacy_queue?'移行待ち':'P'+r.priority,r.type,r.target?.id??[r.target?.grade,r.target?.from,r.target?.to].filter(Boolean).join(' '),
    r.reason,r.status,phases[r.phase]??'—',r.attempts,fmt(r.started_at),fmt(r.finished_at),duration(r.elapsed_ms),fmt(r.next_run_at),r.last_error,(r.status==='failed'||r.status==='held'&&r.last_error?.startsWith('Invalid integer event='))&&r.season_id?action('再開',{action:'reset-job',id:r.id,season:r.season_id}):'—']));
}
function logTable(logs) {
  return table(['ジョブ','状態','開始','終了','通信量','件数','所要時間','工程ごとの所要時間','エラー'],logs.map(r=>[
    r.job_id,r.status,fmt(r.started_at),fmt(r.finished_at),bytes(r.bytes),r.records,duration(r.duration),
    Object.entries(r.phase_ms??{}).map(([phase,ms])=>(phases[phase]??phase)+' '+duration(ms)).join(' ／ ')||'—',r.error]));
}
function replaceTable(details,grid) {
  const previous=details.querySelector('.table-wrap');
  const scroll=previous?.scrollLeft??0;
  previous?.replaceWith(grid);
  grid.scrollLeft=scroll;
}
function completionPanel(seasonId,jobs,logs,updateLive=()=>{},supportsTelemetry=true) {
  const panel=el('section',null,{'aria-label':'初期化の進捗'});
  const figures=el('dl',null,{class:'metrics'});
  const fields=[
    ['fetched','個人成績取得済み人数'],['matched','大会照合完了人数'],['calculated','ポイント集計完了人数'],
    ['details','未照合明細数'],['events','未照合大会数'],['positive','正のポイントを持つ未照合明細数'],
    ['pending','待機中ジョブ数'],['running','実行中ジョブ数'],['done','完了ジョブ数'],['failed','失敗ジョブ数'],['held','保留ジョブ数'],['cancelled','取消ジョブ数']
  ];
  const values=new Map(fields.map(([key,title])=>{
    const item=el('div');
    const value=el('dd','—');
    item.append(el('dt',title),value);
    figures.append(item);
    return [key,value];
  }));
  const status=el('p',null,{role:'status'});
  panel.append(el('small','進捗欄は対象期の取得・補完ジョブ、優先度別の待機数は全期・全種別です。',{class:'muted'}),figures,status);
  let timer,currentRequest,running=false,refreshOnReturn=false;
  const next={traffic:0,official:0,database:0};
  const lifecycle=pollLifecycle.signal;
  const query=new URLSearchParams({season:seasonId});
  async function refresh(){
    clearTimeout(timer);
    if(lifecycle.aborted||!panel.isConnected||document.hidden||running) return;
    running=true;
    currentRequest=new AbortController();
    const signal=AbortSignal.any([lifecycle,currentRequest.signal]);
    try {
      const progress=await api(endpoint+'completion?'+query,{signal});
      if(!panel.isConnected||document.hidden) return;
      if(Array.isArray(progress.jobs)) replaceTable(jobs,jobTable(progress.jobs));
      if(Array.isArray(progress.logs)) replaceTable(logs,logTable(progress.logs));
      for(const [key,value] of values) value.textContent=pt(progress[key])+(fields.slice(0,3).some(([k])=>key===k)?' / '+pt(progress.total):'');
      updateLive('progress',progress);
      const now=Date.now();
      const updates=await Promise.allSettled(Object.entries({traffic:10000,official:30000,database:60000}).map(async([kind,interval])=>{
        if(!supportsTelemetry||now<next[kind]||document.hidden||!panel.isConnected) return;
        next[kind]=now+interval;
        const data=await api(endpoint+'telemetry?'+query+'&kind='+kind,{signal});
        if(panel.isConnected&&!document.hidden) updateLive(kind,data);
      }));
      const failed=updates.find(update=>update.status==='rejected');
      if(failed) throw failed.reason;
      status.textContent='';
    } catch(error) {
      if(!signal.aborted) status.textContent='進捗を取得できませんでした。 '+error.message;
    } finally {
      running=false;
      currentRequest=null;
      if(!lifecycle.aborted&&panel.isConnected&&!document.hidden) timer=setTimeout(refresh,refreshOnReturn?0:5000);
      refreshOnReturn=false;
    }
  }
  document.addEventListener('visibilitychange',()=>{
    clearTimeout(timer);
    if(document.hidden) currentRequest?.abort();
    if(!panel.isConnected||document.hidden) return;
    for(const key of Object.keys(next)) next[key]=0;
    if(running) refreshOnReturn=true;
    else refresh();
  },{signal:pollLifecycle.signal});
  queueMicrotask(refresh);
  return panel;
}
async function load(){
  pollLifecycle.abort();
  pollLifecycle=new AbortController();
  try{
    const data=await api(endpoint+'status?'+new URLSearchParams(season?{season}:{}));
    const seasons=await getSeasons();
    login.hidden=true;
    const selector=el('select',null,{'aria-label':'管理対象期'});
    for(const row of seasons)selector.append(el('option',seasonLabel(row),{value:row.id,title:row.starts_on+' ～ '+row.ends_on}));
    selector.value=String(data.season?.id??'');
    selector.onchange=()=>{season=selector.value;load();};
    const logout=el('button','ログアウト');
    logout.onclick=async()=>{await api(endpoint+'logout',{body:{}});await load();};
    const top=el('div',null,{class:'bar'});top.append(selector,logout);
    const acquisition=data.acquisition;
    const policy=acquisition.configuration;
    const supportsTelemetry=policy.candidateLimit!=null;
    const percent=rate=>rate==null?'使用率不明':Math.floor(rate*100)+'%';
    const limits=['取得制限なし','バックフィル停止','P3・P4の外部取得停止','全外部取得停止'];
    const backfill=el('p','通常更新 '+(data.paused?'停止中':acquisition.level===3?'容量・通信量による停止':'実行可能')+
      ' ／ バックフィル '+(data.paused||!policy.backfillEnabled||acquisition.level>=1?'停止中':data.backfill.windowOpen?'時間帯内':'時間帯外')+
      ' ／ JST 00:00～12:00 ／ 次回実行可能 '+(data.paused?'—':fmt(data.backfill.next)));
    const commands=el('div',null,{class:'bar'});
    commands.append(action(data.paused?'再開':'停止',{action:'pause',value:!data.paused}),action('再集計',{action:'recalculate'}),
      action('公式更新確認',{action:'official'}),action('バックアップ',{action:'backup'}),action('期確定',{action:'finalize'}));
    const setup=el('section',null,{class:'panel controls'});
    setup.append(el('h2','初期動作確認'));
    const steps=el('div',null,{class:'bar'});
    steps.append(action('公式ランキングのみ取得',{action:'official-only'}),action('全体の初期化開始',{action:'initialize'}),
      action('不足大会を補完',{action:'complete-personal'}),
      el('a','公式ランキングを開く',{href:'/?'+new URLSearchParams({season:data.season?.id??'',mode:'official'})+'#ranking'}));
    setup.append(steps);
    const jobs=detail('ジョブ',jobTable(data.jobs));
    const logs=detail('取得ログ',logTable(data.logs));

    if(data.season?.initialized_at){
      const wrapper=detail('初期動作確認',steps);
      setup.replaceChildren(wrapper);
    }else setup.replaceChildren(el('h2','初期動作確認'),steps);
    const controls=()=>el('div',null,{class:'controls panel'});
    const system=controls(),players=controls(),events=controls(),jobControls=controls();
    system.append(form('新規期を作成',[label('開始日',control('date','starts')),label('終了日',control('date','ends')),
      label('新API期コード',control('text','term')),label('旧ページ期コード',control('text','legacyTerm'))],v=>send({action:'create-season',...v})));
    for(const [title,name,value,section] of [['追跡追加','track',true,players],['追跡解除','track',false,players],
      ['選手再取得','personal',true,players],['大会再取得','event',true,events],['ジョブ再開','reset-job',true,jobControls]]){
      section.append(form(title,[label(name==='event'?'内部大会ID':name==='reset-job'?'ジョブID':'DMP ID',control('number','id'))],v=>send({action:name,id:v.id,value})));
    }
    function lookup(title,endpointPath,field,selectResult){
      const panel=controls(),output=el('div');
      const search=control('search','q');
      panel.append(form('検索',[label(title,search)],async bound=>{
        try{
          const query=new URLSearchParams({q:bound.q,...data.season?.id&&{season:data.season.id},...field});
          const rows=await api(endpointPath+'?'+query);
          const visible=rows.slice(0,15);
          output.replaceChildren(el('p',visible.length?visible.length+'件表示':'該当なし'));
          for(const row of visible){
            const button=el('button',selectResult(row).text,{type:'button'});
            button.onclick=()=>{for(const input of (endpointPath==='/api/events'?events:players).querySelectorAll('[name=id]'))input.value=selectResult(row).id;};
            output.append(button);
          }
        }catch(error){output.textContent=error.message;}
      }),output);
      return panel;
    }
    const playerLookup=lookup('公式保存分のHN / DMP ID','/api/rankings',{mode:'official',limit:50},
      row=>({id:row.dmp_id,text:(row.display_name??row.handle_name)+' #'+row.dmp_id}));
    const eventLookup=lookup('大会名','/api/events',{},row=>({id:row.id,text:row.event_date+' '+row.event_name+' #'+row.id}));
    const policyFields=[
      label('バックフィルを有効にする（1＝有効、0＝無効）',control('number','enabled',policy.backfillEnabled?1:0)),
      label('バックフィルの日次大会上限',control('number','daily',policy.backfillLimit)),
      label('候補選手の1日上限',control('number','candidates',policy.candidateLimit)),
      label('個人成績の再取得間隔（日）',control('number','days',policy.personalDays)),
      label('DB容量予算（バイト）',control('number','db',policy.dbBudget)),
      label('DMP受信本文予算（バイト、0＝未設定）',control('number','traffic',policy.trafficBudget??0))
    ];
    system.append(form('取得設定を保存',policyFields,v=>send({action:'acquisition',value:{backfillEnabled:Number(v.enabled)===1,
      backfillLimit:Number(v.daily),candidateLimit:Number(v.candidates),personalDays:Number(v.days),dbBudget:Number(v.db),trafficBudget:Number(v.traffic)||null}})));
    const migration=el('div',null,{class:'controls panel'});
    const dry=el('button','旧ジョブ移行のドライラン',{type:'button'});
    const preview=el('div');
    migration.append(el('p','移行待ち '+pt(data.backfill.legacy)+'件'),dry,preview);
    dry.onclick=async()=>{
      try {
        const response=await api(endpoint+'queue-migration');
        preview.replaceChildren(table(['状態・優先度・理由','件数'],Object.entries(response.counts)),
          detail('対象別の判定根拠',table(['ジョブID','種別','判定','根拠'],response.changes.map(row=>[
            row.id,row.type,row.reason,row.evidence?JSON.stringify(row.evidence):'—']))));
        if(response.total&&data.paused) preview.append(action('旧ジョブの分類を適用',{action:'queue-migration',confirm:true}));
      } catch(error) {report(error.message);}
    };
    const review=el('button','待機キューの再分類をプレビュー',{type:'button'});
    const reviewOutput=el('div');
    migration.append(review,reviewOutput);
    review.onclick=async()=>{
      review.disabled=true;
      try {
        const result=await api(endpoint+'queue-review');
        reviewOutput.replaceChildren(el('p','P1維持 '+result.retained+'件 ／ P4へ変更 '+result.demoted+
          '件 ／ 追跡の重複 '+result.duplicates.length+'件 ／ バックフィル最短 '+result.days+'運転日'),
          el('p',Object.entries(result.projected).map(([p,n])=>'P'+p+' '+n+'件').join(' ／ ')),
          detail('大会ジョブの分類',table(['ジョブID','開催日','大会','現在','変更後','理由'],
            result.changes.map(r=>[r.id,r.date,r.name,'P'+r.priority,'P'+r.nextPriority,r.reason]))),
          detail('追跡ジョブの重複',table(['取消対象','維持するジョブ','期'],
            result.duplicates.map(r=>[r.id,r.duplicate_of,r.season]))));
        if(result.canApply&&(result.demoted||result.duplicates.length)) {
          reviewOutput.append(action('再分類と重複整理を適用',{action:'queue-review',confirm:true}));
        } else if(!result.canApply) reviewOutput.append(el('p','適用には取得停止と実行中0件が必要です。'));
      } catch(error){report(error.message);}
      finally {review.disabled=false;}
    };
    const heldButton=el('button','解析保留を確認',{type:'button'});
    const heldOutput=el('div');
    migration.append(heldButton,heldOutput);
    heldButton.onclick=async()=>{
      heldButton.disabled=true;
      try {
        const result=await api(endpoint+'held-results?'+new URLSearchParams({season:data.season?.id??''}));
        const labels={'blank-placement-legacy':'旧診断・順位空欄','blank-placement-positive':'順位空欄・正のpt',
          'blank-placement-unconfirmed':'順位空欄・0pt未確認',other:'その他'};
        heldOutput.replaceChildren(el('p','順位空欄の再試行対象 '+result.retry+'件 ／ 要調査 '+result.needsInvestigation+'件'),
          el('p',Object.entries(result.counts).map(([key,n])=>labels[key]+' '+n+'件').join(' ／ ')),
          detail('大会結果の保留一覧',table(['ジョブID','大会','再開位置','理由','診断'],
            result.rows.map(r=>[r.id,r.event_name,r.offset,labels[r.category],r.last_error]))));
        if(result.canApply&&result.retry) heldOutput.append(action('順位空欄の対象を待機へ戻す',
          {action:'retry-blank-placement',confirm:true}));
      } catch(error){report(error.message);}
      finally {heldButton.disabled=false;}
    };
    const candidatePanel=el('section',null,{class:'controls panel'});
    const candidateButton=el('button','候補再判定をプレビュー',{type:'button'});
    const previewOutput=el('div');
    candidatePanel.append(candidateButton,previewOutput);
    candidatePanel.hidden=!supportsTelemetry;
    candidateButton.onclick=async()=>{
      candidateButton.disabled=true;
      try {
        const view=await api(endpoint+'candidates?'+new URLSearchParams({season:data.season?.id??''}));
        const summary=el('p','200位 '+pt(view.border)+' pt ／ 取得対象 '+view.selected.length+'人 ／ 判定保留 '+view.held+
          '人 ／ 取得条件未達 '+view.below+'人 ／ 既存の保留ジョブ '+view.existingHeld+
          '件 ／ 当日 '+view.used+'/'+view.limit+'人 ／ 残り '+view.remaining+'枠 ／ 推定受信本文 '+
          (view.estimatedBytes==null?'未計測':bytes(view.estimatedBytes)+(view.approximate?'（旧ログからの概算）':'')));
        const reasons={
          selected:'取得対象','daily-limit':'日次上限到達','hold-no-border':'ボーダー未確定',
          'hold-no-post-cutoff-evidence':'公式集計後の加点根拠なし','hold-no-official-baseline':'公式ptなし',
          'qualify-known-results':'保存済みptが到達','qualify-upper-bound':'推定上限が到達','below-border':'ボーダー未達'
        };
        const filter=el('select',null,{'aria-label':'候補判定理由'});
        filter.append(el('option','すべて',{value:''}),...Object.entries(reasons).map(([key,text])=>el('option',text,{value:key})));
        const results=el('div');
        const renderRows=()=>results.replaceChildren(table(['DMP ID','選手','公式pt','保存済みpt','推定上限pt','判定'],
          view.rows.filter(r=>!filter.value||r.category===filter.value||r.decision===filter.value).map(r=>[
            r.dmp_id,r.display_name??r.handle_name,pt(r.official_points),pt(r.known),pt(r.upper),reasons[r.category]??r.decision])));
        renderRows();
        filter.onchange=renderRows;
        const details=detail('候補判定の詳細',label('理由で絞り込み',filter));
        details.append(results);
        previewOutput.replaceChildren(summary,el('small','既存保留ジョブの選手は、今回の判定人数にも含まれる場合があります。'),details);
        if(view.selected.length) previewOutput.append(action('取得ジョブを登録',{action:'register-candidates',confirm:true}));
      } catch(error){report(error.message);}
      finally {candidateButton.disabled=false;}
    };
    const liveState=el('p'),liveUsage=el('p'),liveOfficial=el('p'),liveDatabase=el('p');
    const live=(kind,result)=>{
      if(kind==='progress') {
        liveState.textContent=(result.paused?'取得停止中':result.cooldown?'クールダウン中・再開可能 '+fmt(result.cooldown):'取得可能')+' ／ '+Array.from({length:5},(_,priority)=>
          'P'+priority+' '+pt(result.queues?.find(q=>q.priority===priority&&q.status==='pending')?.count??0)+'件').join(' ／ ');
      } else if(kind==='traffic') {
        liveUsage.textContent='DMP受信本文 '+result.traffic_from+' ～ '+result.traffic_through+' JST ／ '+
          (result.traffic==null?'未計測':bytes(result.traffic))+' / '+
          (result.configuration.trafficBudget==null?'予算未設定':bytes(result.configuration.trafficBudget))+
          ' ／ '+percent(result.trafficRate)+' ／ 最終計測 '+fmt(result.traffic_at)+
          ' ／ バックフィル '+result.slots.backfill+'/'+result.configuration.backfillLimit+
          ' ／ 候補 '+result.slots.candidates+'/'+result.configuration.candidateLimit+
          ' ／ '+limits[result.level]+(result.trafficRate>=.7||result.databaseRate>=.7?' ／ 使用率警告':'');
      } else if(kind==='official') {
        liveOfficial.textContent='公式集計日時 '+fmt(result.time);
      } else if(kind==='database') {
        liveDatabase.textContent='DB容量 '+(result.database==null?'未計測':bytes(result.database))+' / '+bytes(policy.dbBudget)+' ／ 最終計測 '+fmt(result.database_at)+
          (result.database_error_at?' ／ 計測失敗 '+fmt(result.database_error_at):'');
      }
    };
    const advanced=controls();
    advanced.append(form('集計ルール保存',[label('週内採用数',control('number','limit',data.rules?.weekly_limit??2)),
      label('種別ルール JSON',control('textarea','grades',JSON.stringify(data.rules?.grade_rules??{CS:'weekly',CSE:'extra',GP:'extra',BN:'extra'},null,2)))],
      v=>send({action:'rules',limit:v.limit,grades:JSON.parse(v.grades)})));
    for(const [name,title,value] of [['schedule','確認間隔',Object.keys(data.schedule).length?data.schedule:{high:[60,30,10],official:[60,30,5,15]}],
      ['multiplier-ranges','倍率別付与範囲',data.multiplierRanges],['source-mapping','公式レスポンス対応設定',data.source]]){
      advanced.append(form(title+'を保存',[label(title+' JSON',control('textarea','config',JSON.stringify(value,null,2)))],
        v=>send({action:name,value:JSON.parse(v.config)})));
    }
    const mostRecentAudit=data.discrepancies[0]?.aggregation_at;
    const count=Object.groupBy(data.discrepancies.filter(r=>r.aggregation_at===mostRecentAudit),r=>r.status);
    const auditLabel='公式照合 一致 '+(count.match?.length??0)+' ／ 不一致 '+(count.mismatch?.length??0)+' ／ 比較不能 '+(count.unknown?.length??0);
    const audit=detail(auditLabel,table(['集計日時','DMP ID','公式pt','独自pt','状態'],
      data.discrepancies.map(r=>[fmt(r.aggregation_at),r.dmp_id,r.official_points,r.computed_points,r.status])));
    const eventCounts=el('dl',null,{class:'metrics'});
    const cronInfo=el('p',null,{class:'muted'});
    if(data.season) api('/api/state?'+new URLSearchParams({season:data.season.id})).then(state=>{
      const cron={unverified:'自動更新未確認',healthy:'定期ジョブ登録正常',paused:'停止中',error:'異常・登録失敗',overdue:'異常・定期受信なし'};
      cronInfo.textContent=(cron[state.cron?.status]??'自動更新未確認')+' ／ 最終受信 '+fmt(state.cron?.last_received_at);
      for(const [key,title] of [['registered','結果登録検知'],['unregistered','結果未登録'],['personal_saved','個人成績経由'],
        ['event_api_fetched','大会結果API取得'],['reflected','公式反映確認済み'],['reflection_unconfirmed','公式反映未確認']]){
        const item=el('div');item.append(el('dt',title),el('dd',pt(state.counts?.[key])+'件'));eventCounts.append(item);
      }
    }).catch(error=>{cronInfo.textContent=error.message;});
    const sections=[
      ['overview','概要',[cronInfo,liveState,liveUsage,liveOfficial,liveDatabase,el('p',auditLabel+(mostRecentAudit?' ／ '+fmt(mostRecentAudit):'')),completionPanel(data.season?.id??'',jobs,logs,live,supportsTelemetry)]],
      ['updates','更新管理',[commands,backfill,setup]],
      ['players','選手管理',[playerLookup,players,candidatePanel,detail('追跡選手',table(['DMP ID','理由','追跡中','補完'],data.tracked.map(r=>[r.dmp_id,r.reasons.join(', '),r.active?'○':'—',r.backfill_status])))]],
      ['events','大会管理',[detail('大会取得状況',eventCounts),eventLookup,events,
        detail('設定した付与範囲を超えた大会',table(['大会ID','日付','大会名','設定順位','範囲外の獲得者'],data.rangeChecks.map(r=>[r.id,r.event_date,r.event_name,r.range_check.configured,r.range_check.outside])))]],
      ['jobs','ジョブ・ログ',[jobControls,migration,jobs,logs,detail('候補判定の記録',table(['DMP ID','判定日時','根拠'],
        data.candidateDecisions.map(row=>[row.dmp_id,fmt(row.evaluated_at),JSON.stringify(row.details)])))]],
      ['audit','集計検証',[...data.season?[playerVerification(data.season.id,data.lastVerification)]:[],audit,
        detail('成績の変更差分',table(['検知日時','大会ID','DMP ID','変更内容'],data.changes.map(r=>[fmt(r.detected_at),r.event_id,r.dmp_id,JSON.stringify(r.changed_fields)])))]],
      ['system','システム設定',[system,detail('詳細設定（JSON）',advanced),action('期確定',{action:'finalize'})]],
      ['backup','バックアップ',[action('バックアップ',{action:'backup'}),table(['作成日時','状態','保存先','SHA256'],
        data.backups.map(r=>[fmt(r.created_at),r.status,r.storage_reference,r.checksum]))]]
    ];
    // Keep each section mounted for live progress and to preserve disclosure/input state.
    commands.replaceChildren(action(data.paused?'再開':'停止',{action:'pause',value:!data.paused}),
      action('再集計',{action:'recalculate'}),action('公式更新確認',{action:'official'}));
    const menu=el('nav',null,{class:'admin-menu','aria-label':'管理メニュー'});
    const panels=sections.map(([key,title,children])=>{
      const panel=el('section',null,{id:'admin-'+key,'aria-label':title,class:'admin-section'});
      panel.append(el('h2',title),...children);
      const button=el('button',title,{type:'button','aria-controls':panel.id});
      button.onclick=()=>show(key);
      menu.append(button);
      return {key,panel,button};
    });
    function show(key){
      activeSection=key;
      for(const entry of panels){
        entry.panel.hidden=entry.key!==key;
        entry.button.setAttribute('aria-pressed',entry.key===key);
      }
    }
    area.replaceChildren(top,menu,...panels.map(entry=>entry.panel));
    show(activeSection);
  }catch(error){
    area.replaceChildren();
    login.hidden=false;
    if(error.message!=='管理者認証が必要です')report(error.message);
  }
}
login.onsubmit=async e=>{
  e.preventDefault();
  try{await api(endpoint+'login',{body:Object.fromEntries(new FormData(login))});login.reset();report('');await load();}
  catch(error){report(error.message);}
};
load();

export function el(tag,text,attrs={}){
  const node=document.createElement(tag);
  if(text!=null) node.textContent=text;
  for(const [key,value] of Object.entries(attrs)) if(value!=null) node.setAttribute(key,value);
  return node;
}
export async function api(path,{body,signal}={}){
  const response=await fetch(path,{signal,cache:'no-store',...(body===undefined?{}:{method:'POST',headers:{'content-type':'application/json','x-dmp-request':'1'},body:JSON.stringify(body)})});
  if(response.status===204) return;
  const data=await response.json();
  if(!response.ok) throw new Error(data.error??'通信に失敗しました');
  return data;
}
export const pt=value=>value==null?'—':Number(value).toLocaleString('ja-JP');
const delta=value=>value==null?'—':value>0?'▲ '+pt(value):value<0?'▼ '+pt(-value):'±0';
const trend=(rows,key,time,origin=0)=>({values:rows.map(r=>r[key]),times:rows.map(r=>Date.parse(r[time])-origin)});
const displayTime=value=>value?new Date(value).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'—';
export function table(columns,rows,className=''){
  const wrap=el('div',null,{class:'table-wrap '+className,tabindex:'0',role:'region','aria-label':'表'});
  const grid=el('table'),head=el('thead'),line=el('tr'),body=el('tbody');
  for(const column of columns){const th=el('th',null,{scope:'col'});th.append(column instanceof Node?column:document.createTextNode(column));line.append(th);}
  head.append(line);
  for(const row of rows){
    const tr=el('tr');
    for(const value of row){const td=el('td');if(value instanceof Node)td.append(value);else td.textContent=value??'—';tr.append(td);}
    body.append(tr);
  }
  grid.append(head,body);wrap.append(grid);return wrap;
}
const dateLabel=value=>value?new Date(value).toLocaleDateString('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric'}):'—';
export function seasonLabel(season) {
  const [year,month]=season.starts_on.split('-');
  const term=/^(\d{4})([12])$/.exec(season.source_term??'');
  return term?term[1]+'年度'+(term[2]==='1'?'上期':'下期'):
    year+'年'+Number(month)+'月開始';
}
export function chart(series,label,{invert=false,average=null}={}){
  const shell=el('figure',null,{class:'chart-panel'});
  const area=el('canvas',null,{class:'chart',role:'img','aria-label':label});
  const readout=el('figcaption',null,{class:'chart-readout','aria-live':'polite'});
  const legend=el('div',null,{class:'chart-key'});
  const colors=['#f5d87b','#a5caff','#8de2b4','#ffadad'];
  const points=series.flatMap((s,k)=>s.values.flatMap((value,i)=>value==null?[]:[{
    value,time:s.times?.[i]??i,label:s.labels?.[i],originalTime:s.originalTimes?.[i],name:s.name,color:colors[k%colors.length],bar:s.bar,partial:s.partial?.[i]
  }]));
  if(!points.length){shell.append(area,el('p','取得済みの履歴がありません。',{class:'muted'}));return shell;}
  series.forEach((s,i)=>{if(s.name)legend.append(el('span',s.name,{class:'series-'+i}));});
  if(average!=null) legend.append(el('span','点線 完了週平均 '+pt(Math.round(average))+'pt'));
  if(series.some(s=>s.partial?.some(Boolean))) legend.append(el('span','薄色 集計途中'));
  const control=el('input',null,{type:'range',min:0,max:points.length-1,value:points.length-1,'aria-label':label+'のデータ点',class:'chart-control'});
  shell.append(legend,area,readout,control);
  let selected=points.length-1;
  let positions=[];
  const ctx=area.getContext('2d');
  const timed=series.some(s=>s.times);
  const domain=points.map(p=>p.time).sort((a,b)=>a-b);
  const first=Math.min(...domain),last=Math.max(...domain);
  const min=invert?1:0,max=Math.max(invert?2:1,...points.map(p=>p.value),average??0);
  const formatX=x=>{
    const item=points.find(p=>p.time===x);
    if(item?.label)return item.label;
    if(!timed)return String(x+1);
    return dateLabel(x);
  };
  function draw(){
    if(!ctx||!area.clientWidth) return;
    const width=area.clientWidth,height=area.clientHeight,dpr=window.devicePixelRatio||1;
    area.width=Math.round(width*dpr);area.height=Math.round(height*dpr);
    ctx.scale(dpr,dpr);ctx.font='11px system-ui';
    const left=Math.max(38,ctx.measureText(pt(max)).width+12),right=width-12,top=13,bottom=height-27;
    const y=v=>invert?top+(v-min)/(max-min)*(bottom-top):bottom-(v-min)/(max-min)*(bottom-top);
    const bars=series.some(s=>s.bar);
    const span=last-first;
    const scale=bars?(right-left)/(span+1):span?(right-left)/span:0;
    const x=t=>span||bars?left+(t-first+(bars ? .5 : 0))*scale:(left+right)/2;
    for(const v of [...new Set(Array.from({length:5},(_,i)=>Math.round(min+(max-min)*i/4)))]){
      ctx.strokeStyle='#354258';ctx.beginPath();ctx.moveTo(left,y(v));ctx.lineTo(right,y(v));ctx.stroke();
      ctx.fillStyle='#a8b5ca';ctx.textAlign='right';ctx.fillText(pt(v),left-5,y(v)+4);
    }
    const steps=width<420?2:4;
    const ticks=[...new Set(Array.from({length:steps+1},(_,i)=>timed
      ?first+(last-first)*i/steps:Math.round(first+(last-first)*i/steps)))];
    ctx.textAlign='center';ctx.fillStyle='#a8b5ca';
    for(const [i,t] of ticks.entries()){
      ctx.textAlign=i===0?'left':i===ticks.length-1?'right':'center';
      ctx.fillText(formatX(t),x(t),height-7);
    }
    if(average!=null){
      ctx.strokeStyle='#a5caff';ctx.setLineDash([4,4]);ctx.beginPath();ctx.moveTo(left,y(average));ctx.lineTo(right,y(average));ctx.stroke();ctx.setLineDash([]);
    }
    positions=[];
    for(const [k,s] of series.entries()){
      let before=null;
      ctx.strokeStyle=ctx.fillStyle=colors[k%colors.length];ctx.lineWidth=2;
      s.values.forEach((v,i)=>{
        if(v==null){before=null;return;}
        const t=s.times?.[i]??i,px=x(t),py=y(v);
        positions.push({x:px,y:py});
        if(s.bar){
          ctx.globalAlpha=s.partial?.[i]?.45:1;
          ctx.fillRect(px-scale*.33,py,scale*.66,Math.max(1,bottom-py));ctx.globalAlpha=1;
        }else{
          if(before){ctx.beginPath();ctx.moveTo(...before);ctx.lineTo(px,py);ctx.stroke();}
          ctx.beginPath();ctx.arc(px,py,selected===positions.length-1?4:2.5,0,Math.PI*2);ctx.fill();
          before=[px,py];
        }
      });
    }
  }
  function selectPoint(index){
    selected=index; control.value=index;
    const p=points[index];
    readout.textContent=[p.name,timed?displayTime(p.originalTime??p.time):p.label??formatX(p.time),pt(p.value)+(invert?'位':' pt'),p.partial?'集計途中':null].filter(Boolean).join(' ／ ');
    draw();
  }
  control.oninput=()=>selectPoint(Number(control.value));
  area.onpointermove=area.onpointerdown=e=>{
    if(!positions.length)return;
    const rect=area.getBoundingClientRect();
    const distance=p=>Math.hypot(p.x-(e.clientX-rect.left),p.y-(e.clientY-rect.top));
    const nearest=positions.reduce((best,p,i)=>distance(p)<distance(positions[best])?i:best,0);
    if(nearest!==selected)selectPoint(nearest);
  };
  selectPoint(selected);
  const observer=new ResizeObserver(()=>{if(!shell.isConnected)observer.disconnect();else draw();});
  requestAnimationFrame(()=>{if(shell.isConnected){observer.observe(area);draw();}});
  return shell;
}
function local(key,fallback){try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return fallback;}}
function remember(key,value){localStorage.setItem(key,JSON.stringify(value));}
const view=document.querySelector('#view');
if(view) init();
function init(){
  const status=document.querySelector('#status'),notice=document.querySelector('#notice'),select=document.querySelector('#season');
  const initial=new URLSearchParams(location.search);
  const requestedSeason=initial.get('season')??'';
  const state={season:/^\d{1,19}$/.test(requestedSeason)?requestedSeason:local('dmp-season',''),limit:local('dmp-limit','100'),border:local('dmp-border',100),mode:initial.get('mode')==='official'?'official':'provisional',
    q:'',sort:'rank',dir:'asc',watch:local('dmp-watch',[]),filters:{},offset:0,target:local('dmp-target',{}),seasons:[],version:null};
  let generation=0,versionBusy=false;
  const seasonQuery=extra=>new URLSearchParams({...state.season&&{season:state.season},...extra});
  const get=(path,extra)=>api(path+'?'+seasonQuery(extra));
  const route=()=>location.hash.slice(1).split('/');
  function warn(message){notice.textContent=message;notice.hidden=!message;}
  let lastWatchDay;
  function refreshWatch(force=true){
    const day=new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'});
    if(!force&&day===lastWatchDay)return;
    lastWatchDay=day;
    if(state.watch.length) api('/api/watch',{body:{ids:state.watch,season:state.season}}).catch(error=>warn(error.message));
  }
  function stars(id){
    const active=state.watch.includes(id);
    const b=el('button',active?'★':'☆',{class:'star','aria-label':'DMP ID '+id+' ウォッチ','aria-pressed':active,type:'button'});
    b.onclick=()=>{
      if(!active&&state.watch.length>=30)return warn('ウォッチは30人までです');
      state.watch=active?state.watch.filter(x=>x!==id):[...state.watch,id];
      remember('dmp-watch',state.watch);
      if(!active)refreshWatch();
      render(true);
    };
    return b;
  }
  function heading(title,subtitle){const frag=document.createDocumentFragment();frag.append(el('h1',title));if(subtitle)frag.append(el('p',subtitle,{class:'muted'}));return frag;}
  function label(text,input){const label=el('label',text);label.append(input);return label;}
  function input(type,value,name){const n=el('input',null,{type,name});n.value=value??'';return n;}
  function choices(options,value,name){
    const node=el('select',null,{name});
    for(const [key,label] of options)node.append(el('option',label,{value:key}));
    node.value=value??'';return node;
  }
  function link(name,key){return el('a',name,{href:'#'+key});}
  async function updateStatus(){
    const [seasons,data]=await Promise.all([get('/api/seasons'),get('/api/state')]);
    state.seasons=seasons;
    const selected=String(data.season?.id??'');
    select.replaceChildren(...seasons.map(s=>el('option',seasonLabel(s),{value:s.id,title:s.starts_on+' ～ '+s.ends_on})));
    select.value=selected;
    select.title=data.season?data.season.starts_on+' ～ '+data.season.ends_on:'';

    const button=el('button','更新',{type:'button'});button.onclick=()=>check(true);
    if(!data.season){status.replaceChildren(el('p','対象期は未設定です。'),button);return;}
    const dl=el('dl');
    const cronLabels={unverified:'自動更新未確認',healthy:'定期ジョブ登録正常',paused:'停止中',error:'異常・ジョブ登録失敗',overdue:'異常・定期受信なし'};
    const cron=data.cron??{status:data.paused?'paused':'unverified'};
    for(const [key,value] of [
      ['公式集計日時',displayTime(data.times.official)],['暫定最終計算',displayTime(data.times.provisional)],['自動更新',cronLabels[cron.status]]
    ])dl.append(metric(key,value));
    const eventMetrics=el('dl',null,{class:'metrics'});
    for(const [key,value] of [
      ['更新ルール上の次回時刻',displayTime(data.next)],['定期実行の最終受信',displayTime(cron.last_received_at)],
      ['結果登録検知',data.counts.registered],['結果未登録',data.counts.unregistered],
      ['個人成績経由で保存',data.counts.personal_saved],['大会結果APIで取得',data.counts.event_api_fetched],
      ['公式反映確認済み',data.counts.reflected],['公式反映未確認（登録検知済み）',data.counts.reflection_unconfirmed]
    ])eventMetrics.append(metric(key,typeof value==='number'?pt(value)+'件':value??'—'));
    const details=el('details',null,{class:'status-details'});
    details.open=status.querySelector('details')?.open??false;
    details.append(el('summary','更新・大会取得の詳細'),eventMetrics);
    const msg=!data.season.initialized_at?'初期化中 '+data.progress.ready+'/'+data.progress.total:
      data.times.failures||data.progress.incomplete?'取得不足あり・旧値を含む場合があります':'';
    const bar=el('div',null,{class:'status-main'});bar.append(dl,button);
    status.replaceChildren(bar,...msg?[el('small',msg)]:[],details);
  }
  const metric=(key,value)=>{const d=el('div');d.append(el('dt',key),el('dd',value));return d;};
  async function rankings(watch){
    const official=!watch&&state.mode==='official';
    const frag=heading(watch?'ウォッチリスト（'+state.watch.length+'人）':'ランキング');
    if(select.title) frag.append(el('p',select.title,{class:'ranking-dates muted'}));
    const bar=el('div',null,{class:'bar'});
    if(!watch)for(const [mode,label] of [['provisional','暫定'],['official','公式']]){
      const b=el('button',label,{'aria-pressed':state.mode===mode});b.onclick=()=>{state.mode=mode;state.sort='rank';state.dir='asc';render();};bar.append(b);
    }
    frag.append(bar);
    if(watch&&!state.watch.length){frag.append(el('p','ランキングの星から選手を追加できます。'));return frag;}
    if(!watch){
      const form=el('form',null,{class:'filters ranking-filters'});
      const q=input('search',state.q,'q'),limit=choices([['50','50人'],['100','100人'],['200','200人'],['all','全件']],state.limit,'limit');
      form.append(label('HN / DMP ID',q),label('表示件数',limit),el('button','検索',{type:'submit'}));
      form.onsubmit=event=>{event.preventDefault();state.q=q.value;render();};
      limit.onchange=()=>{state.limit=limit.value;remember('dmp-limit',state.limit);state.q=q.value;render();};
      frag.append(form);
    }
    const rows=await get('/api/rankings',{mode:watch?'provisional':state.mode,limit:state.limit,q:watch?'':state.q,sort:state.sort,dir:state.dir,...watch&&{ids:state.watch.join(',')}});
    if(!rows.length){frag.append(el('p','表示できる選手がいません。',{class:'muted'}));return frag;}
    const cols=official?[['rank','公式順位'],[null,'★'],['name','プレイヤー'],['points','公式pt'],
      ...state.officialDifferences?[['rank_diff','順位差'],['point_diff','pt差']]:[]]:
      [['rank','暫定順位'],[null,'★'],['name','プレイヤー'],['points','暫定pt'],['point_diff','pt差'],
        ['official_rank','公式順位'],['official_points','公式pt'],['rank_diff','順位差'],['weekly','週間pt'],['status','追跡状態']];
    const headers=cols.map(([key,title])=>{
      if(!key)return title;
      const arrow=state.sort===key?(state.dir==='asc'?' ▲':' ▼'):'';
      const short={rank:'順位',name:'選手',points:'pt',official_rank:'公式順',rank_diff:'順差',weekly:'週pt',status:'状態'}[key];
      const button=el('button',null,{'aria-label':title+arrow});
      button.append(el('span',title+arrow,{class:'heading-full'}),el('span',(short??title)+arrow,{class:'heading-short'}));
      button.onclick=()=>{state.dir=state.sort===key&&state.dir==='asc'?'desc':'asc';state.sort=key;render();};return button;
    });
    const tone=n=>el('span',delta(n),{class:n>0?'up':n<0?'down':''});
    const states={pending:'初期化待ち',partial:'取得不足',stale:'旧値・取得不足'};
    const rankTable=table(headers,rows.map(r=>{
      const player=link(r.display_name??r.handle_name,'player/'+r.dmp_id);
      player.className='name-link';player.title=player.textContent;
      const rank=el('div',pt(r.rank),{class:'ranking-rank'});
      if((!official||state.officialDifferences)&&r.rank_diff!=null) {
        const move=tone(r.rank_diff);
        move.classList.add('ranking-move');
        rank.append(move);
      }
      const core=[rank,stars(r.dmp_id),player,pt(r.points)];
      return official?[...core,...state.officialDifferences?[tone(r.rank_diff),tone(r.point_diff)]:[]]:[...core,tone(r.point_diff),r.official_rank,pt(r.official_points),tone(r.rank_diff),r.weekly==null?'未取得':pt(r.weekly),states[r.status]?el('span',states[r.status],{class:'warning-label'}):'—'];
    }),official?'ranking official-table':'ranking provisional-table'+(state.extraColumns?' expanded':''));
    if(official){
      const differences=el('button','暫定との差分',{'aria-pressed':state.officialDifferences??false});
      differences.onclick=()=>{state.officialDifferences=!state.officialDifferences;
        if(!state.officialDifferences&&['rank_diff','point_diff'].includes(state.sort)){state.sort='rank';state.dir='asc';}
        render(true);
      };
      frag.append(differences);
    }else{
      const more=el('button',state.extraColumns?'基本列':'詳細列',{class:'mobile-columns','aria-pressed':state.extraColumns??false});
      more.onclick=()=>{state.extraColumns=!state.extraColumns;render(true);};
      frag.append(more,el('small','暫定順位は追跡対象内', {class:'ranking-scope'}));
    }
    frag.append(rankTable);
    return frag;
  }
  async function borders(){
    const frag=heading(state.border+'位ボーダー','暫定ボーダーは追跡対象内の参考値です。');
    const form=el('form',null,{class:'filters'});
    const n=input('number',state.border,'n');n.min=1;n.max=200;n.required=true;
    const compare=choices([['','比較なし'],...state.seasons.filter(s=>String(s.id)!==select.value).map(s=>[s.id,seasonLabel(s)])],state.compare,'compare');
    form.append(label('順位',n),label('比較する過去期',compare),el('button','表示',{type:'submit'}));
    form.onsubmit=e=>{e.preventDefault();state.border=Number(n.value);state.compare=compare.value;remember('dmp-border',state.border);render();};
    const presets=el('div',null,{class:'bar'});
    for(const value of [16,50,100,150,200]){const b=el('button',value+'位',{'aria-pressed':state.border===value});b.onclick=()=>{state.border=value;state.compare=compare.value;remember('dmp-border',value);render();};presets.append(b);}
    frag.append(form,presets);
    const [data,previous]=await Promise.all([get('/api/borders',{n:state.border}),state.compare?get('/api/borders',{n:state.border,season:state.compare}):null]);
    const last=list=>list.at(-1)?.points??null,o=last(data.official),p=last(data.provisional);
    const metrics=el('dl',null,{class:'metrics panel'});
    metrics.append(metric('暫定',p==null?'未確定':pt(p)+' pt'),metric('公式',o==null?'未確定':pt(o)+' pt'),metric('暫定 − 公式',el('span',delta(p==null||o==null?null:p-o),{class:p>o?'up':p<o?'down':''})));
    if(data.coverage?.incomplete) metrics.append(metric('暫定の取得不足',data.coverage.incomplete+'人'));
    if(previous)metrics.append(metric('過去期 暫定 / 公式',pt(last(previous.provisional))+' / '+pt(last(previous.official))));
    if(previous&&last(previous.provisional)==null&&last(previous.official)==null)frag.append(el('p','選択期に比較できるデータがありません。'));
    const currentSeason=state.seasons.find(s=>String(s.id)===select.value);
    const otherSeason=state.seasons.find(s=>String(s.id)===state.compare);
    const series=(rows,name,season,provisional=false,align=false)=>{
      const filtered=provisional?rows.filter(r=>!season?.initialized_at||Date.parse(r.at)>=Date.parse(season.initialized_at)):rows;
      const origin=previous&&align?Date.parse(currentSeason?.starts_on??'1970-01-01')-Date.parse(season?.starts_on??'1970-01-01'):0;
      return {...trend(filtered,'points','at',-origin),originalTimes:filtered.map(r=>Date.parse(r.at)),name};
    };
    frag.append(metrics,el('h2','推移'),chart([series(data.provisional,'暫定',currentSeason,true),series(data.official,'公式',currentSeason),
      ...previous?[series(previous.provisional,'過去期 暫定',otherSeason,true,true),series(previous.official,'過去期 公式',otherSeason,false,true)]:[]],
    '暫定と公式のボーダー推移'));
    if(!data.provisional.some(r=>r.points!=null&&(!currentSeason?.initialized_at||Date.parse(r.at)>=Date.parse(currentSeason.initialized_at))))
      frag.append(el('p','準備完了後の暫定履歴はまだありません。',{class:'muted'}));
    return frag;
  }
  const eventLabels={upcoming:'開催予定',unregistered:'結果未登録',registered:'結果登録検知済み',
    partial:'一部取得済み',fetched:'大会結果API取得完了',failed:'結果取得失敗'};
  const localDay=()=>new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'});
  function eventStatus(event){
    const state=event.display_status??(event.event_date>localDay()?'upcoming':event.result_failed?'failed':event.last_fetched_at?'fetched':
      event.personal_saved?'partial':event.multiplier==null?'unregistered':'registered');
    return eventLabels[state];
  }
  async function events(){
    const frag=heading('大会');
    const period=state.filters.period??'past';
    const data=await get('/api/events',{...state.filters,period,offset:state.offset,meta:'1'});
    const rows=Array.isArray(data)?data:data.events;
    const tabs=el('div',null,{class:'bar'});
    for(const [key,title] of [['past','開催済み'],['upcoming','開催予定'],['all','すべて']]){
      const b=el('button',title,{'aria-pressed':key===period});
      b.onclick=()=>{state.filters={...state.filters,period:key,status:''};state.offset=0;render();};
      tabs.append(b);
    }
    const form=el('form',null,{class:'filters event-filters'});
    for(const [key,title,type] of [['from','開始日','date'],['to','終了日','date'],['q','大会名','search']])
      form.append(label(title,input(type,state.filters[key],key)));
    const prefectures=data.prefectures??[...new Set(rows.map(r=>r.prefecture).filter(Boolean))];
    form.append(label('都道府県',choices([['','すべて'],...prefectures.map(p=>[p,p])],state.filters.pref??'','pref')),
      label('種別',choices([['','すべて'],...['CS','CSE','GP','BN'].map(g=>[g,g])],state.filters.grade??'','grade')),
      label('状態',choices([['','すべて'],...Object.entries(eventLabels)],state.filters.status??'','status')),
      el('button','絞り込み',{type:'submit'}));
    form.onsubmit=e=>{e.preventDefault();state.filters={...Object.fromEntries(new FormData(form)),period};state.offset=0;render();};
    const showCount=data.total==null?(rows.length>100?'100件以上':pt(rows.length)+'件'):pt(data.total)+'件';
    frag.append(tabs,form,el('p','検索結果 '+showCount,{class:'muted'}));
    if(rows.length)frag.append(table(['開催日','大会名','都道府県','種別','参加形式','倍率','結果取得状況'],rows.slice(0,100).map(r=>[
      dateLabel(r.event_date),link(r.event_name,'event/'+r.id),r.prefecture,r.grade,r.is_team?'チーム':'個人',
      r.multiplier==null?'—':'×'+r.multiplier,eventStatus(r)
    ]),'event-table'));
    else frag.append(el('p','該当大会がありません。'));
    for(const [show,title,step] of [[state.offset>0,'前の100件',-100],[rows.length>100,'次の100件',100]])if(show){
      const b=el('button',title);b.onclick=()=>{state.offset+=step;render();};frag.append(b);
    }
    return frag;
  }
  async function eventDetail(id){
    const {event,rows,url}=await get('/api/events/'+id);
    const frag=document.createDocumentFragment();
    const back=link('大会一覧に戻る','events');back.className='back-link';
    frag.append(back,heading(event.event_name,[dateLabel(event.event_date),event.prefecture,event.grade,event.is_team?'チーム':'個人'].filter(Boolean).join(' · ')));
    const metadata=el('dl',null,{class:'metrics panel'});
    metadata.append(metric('倍率',event.multiplier==null?'—':'×'+event.multiplier),metric('結果取得状況',eventStatus(event)));
    if(event.shop_name) metadata.append(metric('店舗・団体（公式一覧）',event.shop_name));
    if(event.event_date<=localDay()) metadata.append(metric('公式反映',event.official_reflected_at?'確認済み':'未確認'));
    frag.append(metadata,el('a','公式大会ページを開く',{href:url,rel:'noreferrer',target:'_blank',class:'external-link'}));
    if(!event.last_fetched_at&&event.personal_saved) frag.append(el('p','個人成績経由で一部取得済みです。掲載範囲は大会全体の結果を含みません。'));
    else if(event.last_fetched_at) frag.append(el('p','大会結果APIで取得した範囲のポイント獲得者を表示します。'));
    else frag.append(el('p','表示できる大会成績はありません。'));
    const rank=rows.some(r=>r.rank_points!=null),judge=rows.some(r=>r.judge_bonus!=null);
    if(rows.length)frag.append(table(['順位','選手','獲得pt',...rank?['順位pt']:[],...judge?['ジャッジ']:[],'追跡'],rows.map(r=>[
      r.placement,link(r.display_name??r.handle_name,'player/'+r.dmp_id),pt(r.total_points),...rank?[pt(r.rank_points)]:[],
      ...judge?[pt(r.judge_bonus)]:[],r.tracked?el('span','追跡中',{class:'tracked'}):'—'
    ])));
    return frag;
  }
  async function player(id){
    const [data,border]=await Promise.all([get('/api/players/'+id),get('/api/borders',{n:state.border})]);
    const p=data.player,frag=document.createDocumentFragment();
    const back=link('ランキングに戻る','ranking');back.className='back-link';
    const title=el('div',null,{class:'bar player-title'});title.append(el('h1',p.display_name??p.handle_name),stars(p.dmp_id));
    frag.append(back,title,el('small','DMP ID '+p.dmp_id));
    const provisionalVisible=data.provisional_visible??p.provisional_rank!=null;
    const current=border.provisional.at(-1)?.points;
    const metrics=el('dl',null,{class:'metrics panel'});
    metrics.append(metric('暫定順位',pt(p.provisional_rank)),metric('暫定pt',pt(p.provisional_points)),
      metric('公式順位',pt(p.official_rank)),metric('公式pt',pt(p.official_points)),
      metric('順位差（公式比）',delta(p.official_rank==null||p.provisional_rank==null?null:p.official_rank-p.provisional_rank)),
      metric('pt差（公式比）',delta(p.official_points==null||p.provisional_points==null?null:p.provisional_points-p.official_points)),
      metric('暫定'+state.border+'位ボーダーとの差',delta(current==null||p.provisional_points==null?null:p.provisional_points-current)));
    frag.append(metrics);
    const controls=el('div',null,{class:'filters'});
    state.playerFilters??={};
    const filter=state.playerFilters[id]??{};
    const range=choices([['all','全期'],['month','今月'],['week','今週'],['custom','任意期間']],filter.range??'all','range');
    const from=input('date',filter.from,'from'),to=input('date',filter.to,'to'),only=input('checkbox','','only');
    only.checked=provisionalVisible&&Boolean(filter.only);
    const target=input('number',state.target[id]??'','target');target.min=0;target.placeholder='例 5000';
    controls.append(label('表示期間',range),label('開始',from),label('終了',to));
    if(provisionalVisible) controls.append(label('採用のみ',only),label('目標（pt）',target));
    const content=el('div');
    const fmt=d=>d.toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'});
    const today=fmt(new Date());
    const month=today.slice(0,7);
    const monday=new Date(today+'T00:00:00Z');monday.setUTCDate(monday.getUTCDate()-((monday.getUTCDay()+6)%7));
    const week=monday.toISOString().slice(0,10);
    const weeklyMap=new Map(data.weekly.map(x=>[x.week_start,x.total_points]));
    const start=new Date(data.season.starts_on+'T00:00:00Z');
    start.setUTCDate(start.getUTCDate()-((start.getUTCDay()+6)%7));
    const history=[];
    for(let d=+start;provisionalVisible&&d<=Date.parse(data.season.ends_on);d+=604800000){
      const key=new Date(d).toISOString().slice(0,10);
      history.push({key,points:weeklyMap.get(key)??null,recorded:weeklyMap.has(key)});
    }
    const complete=history.filter(r=>r.recorded&&(r.key<week || data.season.ends_on < today));
    const future=history.filter(r=>r.key>=week&&data.season.ends_on>=today).length;
    const elapsedCurrent=history.find(r=>r.key===week)?.points??0;
    const average=complete.length?complete.reduce((sum,r)=>sum+r.points,0)/complete.length:null;
    const draw=()=>{
      const selected = day=>({all:true,month:day.startsWith(month),week:day>=week&&day<=today,
        custom:(!from.value||day>=from.value)&&(!to.value||day<=to.value)}[range.value]);
      const selectedWeeks=history.filter(r=>{
        if(r.key>week) return false;
        return Array.from({length:7},(_,offset)=>new Date(Date.parse(r.key)+offset*86400000).toISOString().slice(0,10)).some(day=>selected(day));
      });
      const rows=data.events.filter(r=>(!only.checked||r.provisional_counted)&&selected(r.event_date));
      const provisional=data.history.filter(r=>selected(fmt(new Date(r.observed_at))));
      const official=data.official.filter(r=>selected(fmt(new Date(r.aggregation_at))));
      const accepted=rows.reduce((sum,r)=>sum+(r.provisional_counted?r.total_points:0),0);
      const projected=average==null||p.provisional_points==null?null:Math.round(p.provisional_points+average*Math.max(0,future-1)+(future?Math.max(0,average-elapsedCurrent):0));
      const needed=target.value&&future&&p.provisional_points!=null?Math.max(0,Math.ceil((Number(target.value)-p.provisional_points)/future)):null;
      const stats=el('dl',null,{class:'metrics panel'});
      stats.append(metric('表示範囲の参加数',rows.length),metric('1大会平均獲得pt',rows.length?pt(Math.round(rows.reduce((s,r)=>s+r.total_points,0)/rows.length)):'—'),
        metric('優勝 / 上位8位',rows.filter(r=>r.placement===1).length+' / '+rows.filter(r=>r.placement!=null&&r.placement<=8).length));
      if(provisionalVisible) stats.append(metric('表示範囲の採用pt',pt(accepted)),metric('完了週の平均pt',pt(average==null?null:Math.round(average))),
        metric('必要週間平均pt',pt(needed)),metric('個人期末pt見込み',pt(projected)));
      const asSeries=(list,key,field,name)=>({...trend(list,key,field),name});
      content.replaceChildren(stats,el('h2','ポイント推移'),chart([asSeries(provisional,'points','observed_at','暫定'),asSeries(official,'points','aggregation_at','公式')],'暫定と公式ポイントの推移'),
        el('h2','順位推移'),chart([asSeries(provisional,'rank','observed_at','暫定'),asSeries(official,'rank','aggregation_at','公式')],'暫定と公式順位の推移',{invert:true}));
      if(provisionalVisible){
        const weeklyTable=el('details');weeklyTable.append(el('summary','週間ポイントの表'),table(['週（月曜）','採用pt','状態'],
          [...selectedWeeks].reverse().map(r=>[r.key,r.recorded?pt(r.points):'—',!r.recorded?'未取得':r.key===week&&data.season.ends_on>=today?'集計途中':'完了'])));
        content.append(el('h2','週間ポイント'),chart([{values:selectedWeeks.map(r=>r.points),labels:selectedWeeks.map(r=>dateLabel(r.key)),
          partial:selectedWeeks.map(r=>r.key===week&&data.season.ends_on>=today),bar:true,name:'週間pt'}],'週別採用ポイント',{average}),weeklyTable);
      }
      content.append(el('h2','大会成績'),el('p','公式参考は個人成績等の採用フラグです。公式ランキングへの反映確認とは別に表示しています。',{class:'muted'}));
      const byWeek=Map.groupBy(rows,r=>{
        const date=new Date(r.event_date+'T00:00:00Z');date.setUTCDate(date.getUTCDate()-((date.getUTCDay()+6)%7));return date.toISOString().slice(0,10);
      });
      if(!byWeek.size) content.append(el('p','表示範囲に大会成績がありません。'));
      for(const [key,events] of byWeek){
        const end=new Date(Date.parse(key)+6*86400000).toISOString().slice(0,10);
        content.append(el('h3',dateLabel(key)+'〜'+dateLabel(end)+(provisionalVisible?' ／ 採用 '+(weeklyMap.has(key)?pt(weeklyMap.get(key))+' pt':'未取得'):'')),
          table(['日付','大会','枠','順位','獲得pt','暫定採用','公式参考'],events.map(r=>[dateLabel(r.event_date),link(r.event_name,'event/'+r.id),
            ({weekly:'通常',extra:'別枠',zero:'対象外'}[data.grade_rules?.[r.grade]]??r.grade),r.placement,el('span',pt(r.total_points),{class:r.provisional_counted?'active-point':'inactive-point'}),
            r.provisional_counted?'✓ 採用':r.provisional_counted===false?'不採用':'—',
            r.official_counted==null?'不明':r.official_counted?'対象':'対象外']),'player-events'));
      }
    };
    for(const field of [range,from,to,only,target])field.onchange=()=>{state.playerFilters[id]={range:range.value,from:from.value,to:to.value,only:only.checked};state.target[id]=target.value;remember('dmp-target',state.target);draw();};
    frag.append(el('p','期末pt見込みは現在の暫定ptに、完了週の平均×残りの週数と、今週の平均までの不足分を加えた値です。',{class:'muted'}),controls,content);
    draw();
    return frag;
  }
  function settings(){
    const frag=heading('設定','表示設定とウォッチリストは、このブラウザに保存されます。');
    const form=el('form',null,{class:'settings-form'});
    const n=input('number',state.border,'border');n.min=1;n.max=200;n.required=true;
    const limit=choices([['50','50人'],['100','100人'],['200','200人'],['all','全件']],state.limit,'limit');
    for(const [title,field,help] of [['ボーダー順位',n,'ボーダー画面と選手詳細で参照する順位です。'],
      ['ランキング表示件数',limit,'ランキングの初期表示件数です。']]){
      const item=el('div');item.append(label(title,field),el('small',help));form.append(item);
    }
    form.append(el('button','設定を保存',{type:'submit'}));
    form.onsubmit=e=>{e.preventDefault();state.border=Number(n.value);state.limit=limit.value;remember('dmp-border',state.border);remember('dmp-limit',state.limit);warn('設定を保存しました。');};
    frag.append(form,el('h2','管理者向け'),el('a','管理画面を開く',{href:'/admin'}));return frag;
  }
  async function render(preserve=false){
    const token=++generation;
    const [page,id]=route();
    const section=page==='event'?'events':page==='player'?'ranking':page||'ranking';
    status.hidden=!['ranking','events'].includes(section)||page==='player'||page==='event';
    for(const a of document.querySelectorAll('.nav a')){
      if(a.hash==='#'+section)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');
    }
    const scroll=window.scrollY;
    const left=[...view.querySelectorAll('.table-wrap')].map(e=>e.scrollLeft);
    try {
      const result=await (page==='border'?borders():page==='events'?events():page==='event'?eventDetail(id):
        page==='player'?player(id):page==='settings'?settings():rankings(page==='watch'));
      if(token!==generation)return;
      view.replaceChildren(result);
      if(preserve){window.scrollTo(0,scroll);[...view.querySelectorAll('.table-wrap')].forEach((e,i)=>{e.scrollLeft=left[i]??0;});}
    }catch(error){if(token===generation)warn(error.message);}
  }
  async function check(force=false){
    if(versionBusy||document.hidden&&!force)return;
    versionBusy=true;
    try{
      refreshWatch(false);
      const current=await api('/api/version');
      await updateStatus();
      if(force||current.version!==state.version){state.version=current.version;await render(true);}
    }catch(error){warn(error.message);}finally{versionBusy=false;}
  }
  select.onchange=()=>{state.season=select.value;state.compare='';remember('dmp-season',state.season);state.offset=0;check(true);refreshWatch();};
  window.addEventListener('hashchange',()=>{warn('');window.scrollTo(0,0);render();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)check();});
  setInterval(()=>check(),60000);
  check(true);
}

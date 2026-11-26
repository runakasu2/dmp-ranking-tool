import {comparisonName} from './handle-name.js';
import {createHash} from 'node:crypto';
import { load } from 'cheerio';
import iconv from 'iconv-lite';
import { setTimeout as wait } from 'node:timers/promises';

export const origin = 'https://www.dmp-ranking.com';
const routes = {
  schedule: '/schedule.asp', event: '/Deckbuild/Event/EventResult.aspx/GetResultRanking',
  official: '/Deckbuild/Event/Ranking.aspx/GetRanking', clock: '/ranking.asp', personal: '/userresult.asp'
};
export const grades = ['CS', 'CSE', 'GP', 'BN'];
export function date(value) {
  const parts = String(value).match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?=$|[ T(（])/);
  if (!parts) throw new Error('Invalid date');
  const normalized = [parts[1], parts[2].padStart(2, '0'), parts[3].padStart(2, '0')].join('-');
  const parsed = new Date(normalized);
  if (!Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== normalized) throw new Error('Invalid date');
  return normalized;
}
export function jstTimestamp(value) {
  const match = String(value).match(/^(\d{4}[-/]\d{1,2}[-/]\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})$/);
  if (!match) throw new Error('Invalid DMP timestamp');
  return new Date(date(match[1]) + 'T' + match[2].padStart(2, '0') + ':' + match[3] + ':' + match[4] + '+09:00').toISOString();
}
export const shDate = value => date(value).replaceAll('-', '/');
export function int(value, minimum = 0) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value.trim()))) throw new Error('Invalid integer');
  const n = Number(value);
  if (!Number.isInteger(n) || n < minimum || n > 2147483647) throw new Error('Integer out of bounds');
  return n;
}
function pts(value) {
  if(value==null||typeof value==='string'&&value.trim()==='') return null;
  if(typeof value==='string'&&value.includes(',')) {
    if(!/^\d{1,3}(?:,\d{3})+$/.test(value.trim())) throw new Error('Invalid integer');
    return int(value.trim().replaceAll(',',''));
  }
  return int(value);
}
function required(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Missing text field');
  return value;
}
export function formHN(name) {
  const bytes = iconv.encode(required(name), 'cp932');
  if (iconv.decode(bytes, 'cp932') !== name) throw new Error('HN cannot round-trip through CP932');
  return [...bytes].map(byte => '%' + byte.toString(16).padStart(2, '0').toUpperCase()).join('');
}
export function unwrap(body) {
  const outer = JSON.parse(body);
  if (typeof outer?.d !== 'string') throw new Error('Invalid ASP.NET envelope');
  const rows = JSON.parse(outer.d);
  if (!Array.isArray(rows)) throw new Error('Expected result array');
  return rows;
}
const eventFields = {
  dmpId: ['MemberID','UserID','会員ID'], name: ['HandleName','HN','ハンドルネーム'],
  shopId: ['ShopID','店舗ID'], eventId: ['EventID','大会ID'], heldId: ['HeldID','Seq','開催ID'],
  resultId: ['ResultID','成績ID'], placement: ['Rank','Ranking','順位'],
  rankPoints: ['RankPoint','順位ポイント'], judgeBonus: ['JudgePoint','ジャッジ加算'],
  officialCounted: ['IsTarget','集計対象'], updatedAt: ['UpdateDate','最終更新日時'],
  prefecture: ['PrefName','都道府県名'], region: ['AreaName','エリア名'],
  nationalRank: ['NationalRank','全国順位'], prefectureRank: ['PrefRank','都道府県順位'],
  regionRank: ['AreaRank','エリア順位'], judgeCount: ['JudgeCount','ジャッジ人数'], pointId: ['PointID','ポイントID']
};
function field(row, fields) {
  const key = fields.find(key => Object.hasOwn(row, key));
  return key === undefined ? undefined : row[key];
}
export function eventRow(row, key, fields = eventFields) {
  const get = name => field(row, fields[name] ?? []);
  const rawPlacement=get('placement');
  const blankPlacement=rawPlacement===null||typeof rawPlacement==='string'&&rawPlacement.trim()==='';
  let totalPoints;
  const parse=(name,parser,value=get(name))=>{
    try {return parser(value);}
    catch(error) {
      if(!['Invalid integer','Integer out of bounds'].includes(error.message)) throw error;
      const raw=typeof value==='string'?value:typeof value==='number'?String(value):null;
      const shown=raw!==null&&/^[0-9０-９\s.,+−－-]{0,24}$/u.test(raw)?JSON.stringify(raw)
        :raw!==null?'text(len='+raw.length+',hash='+createHash('sha256').update(raw).digest('hex').slice(0,8)+')'
        :value===null?'null':typeof value;
      throw Object.assign(new Error('Invalid integer ['+name+'] value='+shown+
        (name==='placement'&&blankPlacement?' points='+(totalPoints>0?'positive':'unconfirmed'):'')),{eventInteger:true});
    }
  };
  for (const name of ['shopId','eventId','heldId']) {
    if (parse(name,int) !== Number(key[name])) throw new Error('Unexpected event identity');
  }
  if (get('rankPoints') === undefined || get('judgeBonus') === undefined) throw new Error('Missing point fields');
  const rankPoints = parse('rankPoints',pts);
  const judgeBonus = parse('judgeBonus',pts);
  const flag = get('officialCounted');
  totalPoints=parse('totalPoints',int,(rankPoints??0)+(judgeBonus??0));
  const explicitZero=totalPoints===0&&(rankPoints===0||judgeBonus===0);
  const placement=parse('placement',value=>{
    if(!blankPlacement) return int(value,1);
    if(explicitZero) return null;
    throw new Error('Invalid integer');
  });
  return {
    dmpId: parse('dmpId',value=>int(value,1)), name: required(get('name')), resultId: String(get('resultId') ?? '') || null,
    placement, rankPoints, judgeBonus, totalPoints,
    officialCounted: [true,1,'1','true'].includes(flag) ? true : [false,0,'0','false'].includes(flag) ? false : null,
    updatedAt: get('updatedAt') ? jstTimestamp(get('updatedAt')) : null,
    prefecture: get('prefecture') || null, region: get('region') || null,
    nationalRank: parse('nationalRank',pts), prefectureRank: parse('prefectureRank',pts),
    regionRank: parse('regionRank',pts), judgeCount: parse('judgeCount',pts), pointId: get('pointId') ?? null
  };
}
export function officialRows(rows, mapping = {...eventFields, rank:['Rank','全国順位'], points:['Point','Points','ポイント']}) {
  const seen = new Set();
  let lastRank = 0;
  let lastPoints = null;
  return rows.map((row, i) => {
    const get = key => field(row, mapping[key] ?? []);
    const result = {dmpId:int(get('dmpId'),1), name:required(get('name')), rank:int(get('rank'),1),
      points:int(pts(get('points'))), prefecture:get('prefecture') ?? null, region:get('region') ?? null,
      prefectureRank:pts(get('prefectureRank')),regionRank:pts(get('regionRank'))};
    if (seen.has(result.dmpId) || (lastPoints !== null && lastPoints < result.points)
      || result.rank !== (result.points === lastPoints ? lastRank : i+1)) throw new Error('Inconsistent official order');
    seen.add(result.dmpId);
    lastRank = result.rank;
    lastPoints = result.points;
    return result;
  });
}
export function officialClock(html) {
  const text = load(html).root().text();
  const match = text.match(/前回集計日時\s*[：:]\s*(\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}:\d{2})/);
  if (!match) throw new Error('Missing official timestamp');
  return jstTimestamp(match[1].replace(/\s+/g, ' '));
}
function eventKey(value) {
  const link = String(value).match(/(?:result|event)\.asp\?([^'"\s);]+)/i);
  if (!link) return null;
  const params = new URLSearchParams(link[1]);
  const keys = Object.fromEntries([...params].map(([k,v]) => [k.toLowerCase(),v]));
  return {shopId:int(keys.shopid,1), eventId:int(keys.eventid,1), heldId:int(keys.seq)};
}
const cleanHeading = value => value.trim().replace(/\s+/g,'');
function tableRows(html, selector, parse, requiredFields) {
  const $ = load(html);
  const table = $(selector);
  if (table.length !== 1) throw new Error('Expected one ' + selector);
  let headers;
  const rows = [];
  for (const tr of table.find('tr').toArray()) {
    const cells = $(tr).children('th,td');
    if (!cells.length) continue;
    const lookup = Object.fromEntries(cells.toArray().map((cell,i) => [cleanHeading($(cell).text()),i]));
    if (requiredFields.every(field => Object.hasOwn(lookup,cleanHeading(field)))) {
      headers = lookup;
      continue;
    }
    if (!headers) continue;
    if (/^(該当.*ありません|データ.*ありません|結果.*ありません)$/.test(cells.text().trim())) continue;
    const onclick = [tr,...$(tr).find('[onclick]').toArray()].map(element => $(element).attr('onclick')).filter(Boolean).join(' ');
    rows.push(parse(field => cells.eq(headers[cleanHeading(field)] ?? cells.length).text().trim(),eventKey(onclick),$(tr)));
  }
  if (!headers) throw new Error('Unrecognized table headers in ' + selector);
  return rows;
}
const scheduleHeaders = {date:'開催日', name:'大会名', prefecture:'開催地', shop:'店舗/団体', format:'フォーマット', team:'参加形式', multiplier:'倍率', approval:'承認'};
function scheduleDate(raw, from, to) {
  if (!/^\d{2}\//.test(raw)) return date(raw);
  if (!from || !to) throw new Error('Two-digit date needs a request window');
  const matches = [];
  for (let year=Number(from.slice(0,4));year<=Number(to.slice(0,4));year++) {
    if (String(year).slice(-2)!==raw.slice(0,2)) continue;
    const candidate=date(String(year)+raw.slice(2));
    if(candidate>=from&&candidate<=to) matches.push(candidate);
  }
  if(matches.length!==1) throw new Error('Unexpected schedule date');
  return matches[0];
}
export function scheduleRows(html, grade, names = scheduleHeaders, {from,to,upcoming=false}={}) {
  if (!grades.includes(grade)) throw new Error('Invalid grade');
  return tableRows(html,'table#main',(get,key) => {
    const eventDate = scheduleDate(get(names.date),from,to);
    const raw = upcoming ? '' : get(names.multiplier);
    const decimal = raw.normalize('NFKC').replace(/^[×x]\s*/i,'').replace(/倍$/,'');
    if (raw && !/^\d+(?:\.\d+)?$/.test(decimal)) throw new Error('Invalid multiplier');
    const team = get(names.team);
    if (!/個人|チーム/.test(team)) throw new Error('Unknown team format');
    if (!key) throw new Error('Missing event identity');
    return {...key,eventDate,name:required(get(names.name)),grade,prefecture:get(names.prefecture),shop:get(names.shop),
      format:get(names.format),isTeam:team.includes('チーム'),multiplier:raw ? decimal : null,approval:get(names.approval),upcoming};
  },Object.entries(names).filter(([k])=>!upcoming||k!=='multiplier').map(([,v])=>v));
}
export function personalRows(html, names, season) {
  const variants=names?[names]:['大会','大会名'].map(name=>({date:'開催日',name,rank:'順位',points:'ポイント'}));
  let failure;
  for(const columns of variants) {
    try{
      return tableRows(html,'table#result',(get,key,row) => {
        const eventDate=date(get(columns.date));
        if(season&&(eventDate<season.starts_on||eventDate>season.ends_on)) return null;
        const totalPoints=pts(get(columns.points).replace(/\s*(?:pts?|ポイント)$/i,''))??0;
        const raw=get(columns.rank).replace(/位$/,'');
        const placement=/^[-－―—]?$/.test(raw)&&totalPoints===0?null:int(raw,1);
        return {key,eventDate,name:required(get(columns.name)),placement,totalPoints,
          officialCounted:[row,...row.find('[style]').toArray().map(el => row.find(el))].some(el => /(?:^|;)\s*color\s*:\s*#ffff00\b/i.test(el.attr('style')??''))};
      },Object.values(columns)).filter(Boolean);
    }catch(error){
      if(!error.message.startsWith('Unrecognized table headers')) throw error;
      failure=error;
    }
  }
  throw failure;
}
export class UpstreamError extends Error {
  constructor(code, retryAt = null) { super('DMP HTTP ' + code); this.retryAt = retryAt; }
}
export function retryAfter(value, now = Date.now()) {
  if (value == null) return null;
  const timestamp = /^\d+$/.test(value) ? now + Number(value)*1000 : Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(timestamp,now) : null;
}
export class DmpClient {
  constructor({ fetcher = fetch, dispatch, recordRetryAt = async () => {}, meter = () => {}, recordTraffic = async () => {}, enabled = false } = {}) {
    this.fetcher = fetcher;
    this.dispatch = dispatch;
    this.recordRetryAt = recordRetryAt;
    this.meter = meter;
    this.recordTraffic = recordTraffic;
    this.enabled = enabled;
  }
  async request(route, {query, body, json} = {}) {
    if (!this.enabled || !this.dispatch || !Object.hasOwn(routes,route)) throw new Error('DMP requests are disabled');
    const url = new URL(routes[route],origin);
    if (query) url.search = new URLSearchParams(query);
    const payload = json ? JSON.stringify(body) : body;
    const response = await this.dispatch(signal=>this.fetcher(url,{
      method: payload === undefined ? 'GET' : 'POST', redirect:'error', signal:signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000),
      headers:payload === undefined ? {} : {'Content-Type':json ? 'application/json; charset=UTF-8' : 'application/x-www-form-urlencoded'},
      body:payload
    }));
    const retryAt=response.ok?null:retryAfter(response.headers.get('retry-after'))
      ?? (response.status===429?Date.now()+60000:null);
    if(retryAt) await this.recordRetryAt(retryAt);
    const chunks = [];
    let bytes = 0;
    this.meter(Buffer.byteLength(payload ?? ''));
    try {
      for await (const chunk of response.body ?? []) {
        bytes += chunk.length;
        this.meter(chunk.length);
        if (bytes > 8*1024*1024) throw new Error('DMP response too large');
        chunks.push(chunk);
      }
    } finally {
      await this.recordTraffic(bytes,response.status);
    }
    if (!response.ok) throw new UpstreamError(response.status,retryAt);
    const contentType = response.headers.get('content-type') ?? '';
    if (!(json ? /application\/json/i : /text\/html/i).test(contentType)) throw new Error('Unexpected DMP content type');
    return iconv.decode(Buffer.concat(chunks),json || /charset\s*=\s*"?utf-8/i.test(contentType) ? 'utf8' : 'cp932');
  }
  async schedule(grade, from, to, mode = 'Result', mapping) {
    const body = new URLSearchParams({Mode:mode,Search:'Search',Grade:grade,EventFrom:shDate(from),EventTo:shDate(to),
      EventDendo:'',Meisho:'',JudgeMei:'',Pref1:'',Pref2:'',Pref3:'',Venue:''});
    return scheduleRows(await this.request('schedule',{body:body.toString()}),grade,mapping,{from,to,upcoming:mode!=='Result'});
  }
  async event(key, offset, mapping) {
    const body = {year:shDate(key.eventDate)+' 0:00:00',shopID:String(key.shopId),eventID:String(key.eventId),heldID:String(key.heldId),offset};
    return unwrap(await this.request('event',{body,json:true})).map(row=>{
      try {return eventRow(row,key,mapping);}
      catch(error) {
        if(error.eventInteger) error.message='Invalid integer event='+key.shopId+'/'+key.eventId+'/'+key.heldId+
          ' offset='+offset+' '+error.message.slice('Invalid integer '.length);
        throw error;
      }
    });
  }
  async officialTime(code) {
    return officialClock(await this.request('clock',{query:{HyojiNendo:code,Pref:'0'}}));
  }
  async official(season, previous, {rank = '0', mapping} = {}) {
    const before = await this.officialTime(season.legacy_term);
    if (before === previous) return null;
    const rows = officialRows(unwrap(await this.request('official',{json:true,body:{_term:season.source_term,_region:'0',_type:-1,_rank:rank}})),mapping);
    if (!rows.length || !rows.some(row => row.rank >= 200) || rows.at(-1).rank <= 200) throw new Error('Unverified official top-200 boundary');
    if (before !== await this.officialTime(season.legacy_term)) throw new Error('Official snapshot changed during retrieval');
    return {time:before, rows};
  }
  async personal(player,season,mapping,{nameCollision}={}) {
    const raw=player.handle_name.trim();
    const expected=comparisonName(raw);
    const identityError='Unexpected personal history identity: dmp='+(player.dmp_id??'?');
    if(expected===null) throw new Error(identityError+' invalid character reference');
    if((!nameCollision&&expected!==raw)||await nameCollision?.(expected)) {
      throw new Error(identityError+' ambiguous name');
    }
    const body = 'UserID='+formHN(player.handle_name)+'&'+new URLSearchParams({HyojiNendo:season.legacy_term,Pref:'0',RankingMode:'',Range:'1'});
    const html=await this.request('personal',{body});
    const $=load(html,{sourceCodeLocationInfo:true});
    const headings=$('span.tx1618 > b').toArray();
    const names=headings.map(el=>$(el).text().trim());
    const location=headings[0]?.sourceCodeLocation;
    const rawHeading=location?.startTag&&location?.endTag
      ? html.slice(location.startTag.endOffset,location.endTag.startOffset):null;
    if(names.length!==1||names[0]!==expected||rawHeading===null||comparisonName(rawHeading,{htmlHeading:true})===null) {
      const fingerprint=name=>createHash('sha256').update(name).digest('hex').slice(0,8);
      const normalizedMatch=names.some(name=>name.normalize('NFKC')===expected.normalize('NFKC'));
      throw new Error(`Unexpected personal history identity: dmp=${player.dmp_id??'?'} headings=${names.length} table=${$('#result').length} expected=${fingerprint(expected)} got=${names.slice(0,3).map(fingerprint).join(',')||'-'} normalized=${normalizedMatch}`);
    }
    return personalRows(html,mapping,season);
  }
}
export async function scanEvent(client, key, {offset = 0, pages = 80, save, mapping} = {}) {
  for (let i = 0; i < pages; i++, offset += 30) {
    const rows = await client.event(key,offset,mapping);
    if (!rows.length) return {complete:true,offset};
    if(await save(offset,rows,offset+30)===false) return {complete:false,offset:offset+30};
  }
  return {complete:false,offset};
}
export {wait};

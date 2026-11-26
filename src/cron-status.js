const healthWindowMs=2*60*60*1000;
const statusKey='cron_receipt';

export async function recordCronReceipt(db,receivedAt,outcome) {
  const timestamp=receivedAt.toISOString();
  const result={received_at:timestamp,outcome};
  result[outcome==='ok'?'last_succeeded_at':'last_failed_at']=new Date().toISOString();
  await db.query(`INSERT INTO app_settings(key,value) VALUES($1,$2)
    ON CONFLICT(key) DO UPDATE SET value=app_settings.value||excluded.value,updated_at=now()
    WHERE app_settings.value->>'received_at'<=excluded.value->>'received_at'`,[statusKey,result]);
}

export function cronStatus(receipt,paused,now=new Date()) {
  const received=receipt?.received_at??null;
  const lastSuccess=receipt?.last_succeeded_at??null;
  let status='unverified';
  if(paused) status='paused';
  else if(received) {
    if(receipt.outcome==='failed') status='error';
    else if(+now-Date.parse(received)>healthWindowMs) status='overdue';
    else status='healthy';
  }
  return {status,last_received_at:received,last_succeeded_at:lastSuccess,last_failed_at:receipt?.last_failed_at??null};
}

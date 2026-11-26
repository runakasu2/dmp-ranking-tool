import {connect,transaction} from './db.js';
import {backup} from './backup.js';
import {schedule,startWorker} from './jobs.js';
const pool=connect();
const worker=startWorker(pool,{backup:force=>backup(pool,force)});
const kick=()=>worker.kick().catch(()=>console.error('Worker cycle failed'));
const timer=setInterval(kick,30000);
if(process.env.ALLOW_DMP_FETCH==='true') await transaction(pool,schedule);
kick();
for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{
  clearInterval(timer);
  worker.stop().then(()=>pool.end()).catch(()=>console.error('Shutdown failed'));
});

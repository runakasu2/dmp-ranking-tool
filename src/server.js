import {connect,migrate,transaction} from './db.js';
import {bootstrap,createApp} from './api.js';
import {backup} from './backup.js';
import {schedule,startWorker} from './jobs.js';
const pool=connect();
await transaction(pool,migrate);
await bootstrap(pool,process.env.ADMIN_LOGIN,process.env.ADMIN_PASSWORD);
const worker=process.env.RUN_WORKER!=='false'?startWorker(pool,{backup:force=>backup(pool,force)}):null;
const app=createApp(pool,{worker});
const server=app.listen(Number(process.env.PORT??3000),'0.0.0.0',()=>console.log('DMP Ranking Tracker ready'));
let closing=false;
const halt=()=>{
  if(closing) return;
  closing=true;
  Promise.all([worker?.stop(),new Promise(resolve=>server.close(resolve))])
    .then(()=>pool.end()).catch(()=>console.error('Shutdown failed'));
};
process.once('SIGTERM',halt);
process.once('SIGINT',halt);
if(process.env.ALLOW_DMP_FETCH==='true'&&worker) {
  transaction(pool,schedule).then(()=>worker.kick()).catch(()=>console.error('Startup acquisition failed'));
}

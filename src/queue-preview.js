import {connect,transaction} from './db.js';
import {queueMigration} from './acquisition.js';

const pool=connect();
try {
  const changes=await transaction(pool,async db=>{
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return queueMigration(db);
  });
  const counts=Object.fromEntries(Object.entries(Object.groupBy(changes,r=>r.status+' / P'+r.priority+' / '+r.reason))
    .map(([key,group])=>[key,group.length]));
  console.log(JSON.stringify({total:changes.length,counts,changes},null,2));
} catch(error) {
  console.error('Queue preview failed:',error.code??error.name);
  process.exitCode=1;
} finally {
  await pool.end();
}

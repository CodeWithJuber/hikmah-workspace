import { cp, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
const root=resolve('.');
const directory=await mkdtemp(join(tmpdir(),'hikmah-standalone-'));
let server, logs='';
const environment={...process.env,NODE_ENV:'production',HOSTNAME:'127.0.0.1',PORT:'3210',BETTER_AUTH_URL:'http://127.0.0.1:3210',BETTER_AUTH_SECRET:randomBytes(32).toString('hex'),HIKMAH_DATA_DIR:join(directory,'data'),HIKMAH_OWNER_EMAIL:'owner@example.test',SMOKE_EMAIL:'owner@example.test',SMOKE_PASSWORD:randomBytes(24).toString('base64url'),SMOKE_URL:'http://127.0.0.1:3210',SMOKE_COOKIE_FILE:join(directory,'cookie')};
const run=(cmd,args)=>new Promise((resolve,reject)=>{const child=spawn(cmd,args,{cwd:root,env:environment,stdio:'inherit'});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(`${cmd} exited ${code}`)));});
function start(){server=spawn(process.execPath,['scripts/start.mjs'],{cwd:directory,env:environment,stdio:['ignore','pipe','pipe']});for(const pipe of [server.stdout,server.stderr])pipe.on('data',chunk=>{logs=(logs+chunk).slice(-5000);});}
async function stop(){if(!server||server.exitCode!==null)return;const ended=once(server,'exit');server.kill('SIGTERM');const timer=setTimeout(()=>server.kill('SIGKILL'),5000);try{await ended;}finally{clearTimeout(timer);}}
try {
  await cp('.next/standalone',directory,{recursive:true,dereference:true});
  for(const folder of ['public','server','drizzle'])await cp(folder,join(directory,folder),{recursive:true,dereference:true});
  await cp('.next/static',join(directory,'.next/static'),{recursive:true,dereference:true});
  await mkdir(join(directory,'scripts'),{recursive:true});
  await cp('scripts/start.mjs',join(directory,'scripts/start.mjs'));
  await mkdir(environment.HIKMAH_DATA_DIR,{mode:0o700});
  await writeFile(join(environment.HIKMAH_DATA_DIR,'bootstrap-owner-password'),environment.SMOKE_PASSWORD,{mode:0o600});
  start();await run(process.execPath,['scripts/smoke-http.mjs','write']);
  await stop();start();await run(process.execPath,['scripts/smoke-http.mjs','read']);
  console.info('Isolated standalone production server passed, including a real process restart.');
} catch(error){console.error(logs);throw error;}
finally{await stop();await rm(directory,{recursive:true,force:true});}

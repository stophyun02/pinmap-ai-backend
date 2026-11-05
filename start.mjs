import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
if(fs.existsSync(path.join(here,'.env')))process.loadEnvFile(path.join(here,'.env'));
const port=Number(process.env.PORT||8101),url=`http://127.0.0.1:${port}`;
const ready=async()=>{try{const r=await fetch(url+'/health',{signal:AbortSignal.timeout(1000)});const b=await r.json();return r.ok&&b.service==='pinmap-ai-analysis';}catch{return false;}};
if(await ready()){console.log(url);process.exit(0);}
const data=path.join(here,'.data');fs.mkdirSync(data,{recursive:true,mode:0o700});
const log=fs.openSync(path.join(data,'server.log'),'a',0o600);
const child=spawn(process.execPath,['--env-file-if-exists=.env','server.mjs'],{cwd:here,detached:true,stdio:['ignore',log,log],env:process.env});
child.on('error',()=>{console.error('서버를 시작하지 못했습니다. .data/server.log를 확인하세요.');process.exitCode=1;});
child.unref();fs.closeSync(log);
let started=false;for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,250));if(await ready()){started=true;break;}}
if(!started){console.error('서버 시작을 확인하지 못했습니다. 포트 8101과 .data/server.log를 확인하세요.');process.exitCode=1;}else console.log(url);

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createMultiuserApp} from '../service/api.mjs';
import {claimJob,markExpiredJobs} from '../service/jobs.mjs';
import {processJob} from '../service/worker.mjs';
import {openDatabase} from '../service/db.mjs';
import {VllmClient} from '../service/vllm-client.mjs';
import {migrateLegacy} from '../service/migrate-legacy.mjs';

const fixture=path.resolve('fixtures/instagram-export/instagram-080.014-2026-11-04-bV80AR5s.zip');
const sampleResult={title:'시험',summary:'캡션 기반 요약',summary_evidence_ids:['caption'],topics:[],visible_text:[],facts:[],inferences:[],limitations:[]};
test('accounts isolate ZIP posts, assets, jobs, and results',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-multi-'));
  const app=await createMultiuserApp({dataDir,env:{MULTIUSER_PORT:'0',PINMAP_INVITE_CODE:'invite-test-code',MULTIUSER_AI_PROVIDER:'ollama'}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;
  const request=async(route,{method='GET',body,cookie}={})=>{const headers={...(method==='POST'?{'X-Pinmap-CSRF':'1'}:{}),...(cookie?{Cookie:cookie}:{})};if(body&&!(body instanceof FormData))headers['Content-Type']='application/json';const res=await fetch(base+route,{method,headers,body:body instanceof FormData?body:body?JSON.stringify(body):undefined});return{status:res.status,cookie:res.headers.get('set-cookie')?.split(';')[0],body:await res.json()};};
  try{
    const a=await request('/api/auth/register',{method:'POST',body:{email:'a@example.com',password:'password-123456',invite_code:'invite-test-code'}});
    const b=await request('/api/auth/register',{method:'POST',body:{email:'b@example.com',password:'password-123456',invite_code:'invite-test-code'}});
    assert.equal(a.status,201);assert.equal(b.status,201);
    const form=new FormData();form.append('file',new Blob([await fs.readFile(fixture)],{type:'application/zip'}),'export.zip');
    const imported=await request('/api/import/instagram',{method:'POST',body:form,cookie:a.cookie});assert.equal(imported.status,201);assert.equal(imported.body.imported,349);
    const own=await request('/api/posts?limit=1',{cookie:a.cookie}),other=await request('/api/posts',{cookie:b.cookie});assert.equal(own.body.total,349);assert.equal(other.body.total,0);
    const postId=own.body.posts[0].id;assert.equal((await request(`/api/posts/${postId}`,{cookie:b.cookie})).status,404);
    assert.equal((await request('/api/jobs',{method:'POST',body:{post_id:postId},cookie:b.cookie})).status,404);
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=','base64');
    const media=new FormData();media.append('file',new Blob([png],{type:'image/png'}),'tiny.png');media.append('complete','true');
    const upload=await request(`/api/posts/${postId}/assets`,{method:'POST',body:media,cookie:a.cookie});assert.equal(upload.status,201);
    const assetId=upload.body.id;assert.equal((await fetch(base+`/api/assets/${assetId}`,{headers:{Cookie:b.cookie}})).status,404);
    assert.equal((await fetch(base+`/api/assets/${assetId}`,{headers:{Cookie:a.cookie}})).status,200);
    const queued=await request('/api/jobs',{method:'POST',body:{post_id:postId},cookie:a.cookie});assert.equal(queued.status,202);
    const jobId=queued.body.job.id;assert.equal((await request(`/api/jobs/${jobId}`,{cookie:b.cookie})).status,404);
    assert.equal((await request('/api/jobs',{cookie:b.cookie})).body.jobs.length,0);
    const claimed=claimJob(app.db,'test-worker');assert.equal(claimed.id,jobId);
    await processJob(app.db,claimed,{dataDir,provider:{supportsAudio:false,async summarize(prepared){assert.ok(prepared.evidence.some(x=>x.id==='caption'));return{result:sampleResult,evidence:prepared.evidence,usage:{input_tokens:10,output_tokens:20},model:'fake'};}}});
    const done=await request(`/api/jobs/${jobId}`,{cookie:a.cookie});assert.equal(done.body.status,'completed');assert.equal(done.body.result.summary,'캡션 기반 요약');
    assert.equal((await request('/api/results',{cookie:b.cookie})).body.results.length,0);
    const repeated=await request('/api/jobs',{method:'POST',body:{post_id:postId},cookie:a.cookie});assert.equal(repeated.body.reused,true);
    for(let n=0;n<5;n++)assert.equal((await request('/api/auth/login',{method:'POST',body:{email:'a@example.com',password:'incorrect-password'}})).status,401);
    assert.equal((await request('/api/auth/login',{method:'POST',body:{email:'a@example.com',password:'incorrect-password'}})).status,429);
  }finally{await new Promise(resolve=>app.server.close(resolve));app.db.close();await fs.rm(dataDir,{recursive:true,force:true});}
});
test('two worker connections claim distinct users and preserve running jobs on disk',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-queue-')),file=path.join(folder,'queue.sqlite');
  const first=openDatabase(file),second=openDatabase(file),date=new Date().toISOString();
  try{
    for(const user of ['u1','u2']){
      first.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run(user,`${user}@example.com`,'test',date);
      first.prepare('INSERT INTO posts(id,user_id,source_url,title,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(`p-${user}`,user,`https://www.instagram.com/p/${user}/`,'test',date,date);
      for(let n=1;n<=2;n++)first.prepare('INSERT INTO jobs(id,user_id,post_id,fingerprint,status,source_url,material_json,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(`${user}-job-${n}`,user,`p-${user}`,`f${n}`,'queued',`https://www.instagram.com/p/${user}/`,'{}','{}',date,date);
    }
    const a=claimJob(first,'worker-a'),b=claimJob(second,'worker-b');
    assert.notEqual(a.id,b.id);assert.notEqual(a.user_id,b.user_id);
    assert.equal(first.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='queued'").get().n,2);
    first.close();const restarted=openDatabase(file);
    assert.equal(restarted.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='preparing'").get().n,2);
    restarted.prepare('UPDATE jobs SET lease_until=? WHERE id=?').run(Date.now()-1,a.id);
    assert.equal(markExpiredJobs(restarted),1);
    assert.equal(restarted.prepare('SELECT status FROM jobs WHERE id=?').get(a.id).status,'needs_review');
    restarted.close();
  }finally{if(first.open)first.close();second.close();await fs.rm(folder,{recursive:true,force:true});}
});
test('vLLM adapter uses structured vision request and validates evidence',async()=>{
  let endpoint,body;
  const client=new VllmClient({baseUrl:'http://127.0.0.1:8000/v1',model:'vision-model',fetchImpl:async(url,options)=>{endpoint=String(url);body=JSON.parse(options.body);return{ok:true,headers:{get:()=>null},json:async()=>({id:'response-1',model:'vision-model',choices:[{finish_reason:'stop',message:{content:JSON.stringify(sampleResult)}}],usage:{prompt_tokens:12,completion_tokens:8}})};}});
  const result=await client.summarize({evidence:[{id:'caption',kind:'caption',text:'시험'}],images:[],coverage:{kind:'caption_only'}},{sourceUrl:'https://www.instagram.com/p/abc/'});
  assert.equal(endpoint,'http://127.0.0.1:8000/v1/chat/completions');assert.equal(body.response_format.type,'json_schema');assert.equal(result.result.title,'시험');
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-vllm-')),image=path.join(folder,'image.png');
  try{await fs.writeFile(image,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=','base64'));
    await client.summarize({evidence:[{id:'caption',kind:'caption',text:'시험'},{id:'image',kind:'image'}],images:[{id:'image',kind:'image',mime:'image/png',path:image}],coverage:{kind:'uploaded_images'}},{sourceUrl:'https://www.instagram.com/p/abc/'});
    assert.match(body.messages[1].content.at(-1).image_url.url,/^data:image\/png;base64,/);
  }finally{await fs.rm(folder,{recursive:true,force:true});}
});
test('legacy migration assigns historical results only to the chosen account and is repeatable',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-migrate-')),dataDir=path.join(folder,'new'),legacyRoot=path.join(folder,'old'),db=openDatabase(path.join(dataDir,'pinmap.sqlite'));
  try{
    const date=new Date().toISOString(),first=JSON.parse(await fs.readFile('fixtures/instagram-export/pinmap-items.json','utf8'))[0];
    db.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run('owner','owner@example.com','test',date);
    db.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run('other','other@example.com','test',date);
    await fs.mkdir(path.join(legacyRoot,'jobs'),{recursive:true});
    await fs.writeFile(path.join(legacyRoot,'jobs','historical.json'),JSON.stringify({status:'completed',item_id:first.id,fingerprint:'old-fingerprint',source_url:first.url,created_at:date,completed_at:date,material:{caption:first.sourceCaption},provider:{name:'ollama',model:'test'},result:sampleResult,evidence:[{id:'caption',kind:'caption'}],coverage:{kind:'caption_only'},usage:{}}));
    const options={db,dataDir,email:'owner@example.com',sourceRoot:path.resolve('fixtures/instagram-export'),legacyRoot};
    const migrated=await migrateLegacy(options);assert.equal(migrated.imported_posts,349);assert.equal(migrated.imported_results,1);
    const again=await migrateLegacy(options);assert.equal(again.imported_posts,0);assert.equal(again.imported_results,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM posts WHERE user_id=?').get('other').n,0);
  }finally{db.close();await fs.rm(folder,{recursive:true,force:true});}
});

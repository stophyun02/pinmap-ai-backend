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
import {normalizeTranscription,transcriberFromEnv} from '../service/transcription.mjs';

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
    await processJob(app.db,claimed,{dataDir,provider:{async describeImage(img){return{scene:'작은 테스트 이미지',visible_text:[],objects:[],actions:[],uncertainties:[],model:'fake'};},async summarize(prepared){assert.ok(prepared.evidence.some(x=>x.id==='caption'));assert.equal(prepared.images.length,0);assert.equal(prepared.media_text.visual[0].scene,'작은 테스트 이미지');return{result:sampleResult,evidence:prepared.evidence,usage:{input_tokens:10,output_tokens:20},model:'fake'};}}});
    const done=await request(`/api/jobs/${jobId}`,{cookie:a.cookie});assert.equal(done.body.status,'completed');assert.equal(done.body.result.summary,'캡션 기반 요약');assert.equal(done.body.media_text.visual[0].evidence_id,assetId);
    assert.equal((await request(`/api/jobs/${jobId}`,{cookie:b.cookie})).status,404);
    assert.equal((await request('/api/results',{cookie:b.cookie})).body.results.length,0);
    const repeated=await request('/api/jobs',{method:'POST',body:{post_id:postId},cookie:a.cookie});assert.equal(repeated.body.reused,true);
    for(let n=0;n<5;n++)assert.equal((await request('/api/auth/login',{method:'POST',body:{email:'a@example.com',password:'incorrect-password'}})).status,401);
    assert.equal((await request('/api/auth/login',{method:'POST',body:{email:'a@example.com',password:'incorrect-password'}})).status,429);
  }finally{await new Promise(resolve=>app.server.close(resolve));app.db.close();await fs.rm(dataDir,{recursive:true,force:true});}
});
test('media text persists before synthesis and audio transcription keeps segment times',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-media-text-')),db=openDatabase(path.join(folder,'pinmap.sqlite')),date=new Date().toISOString();
  try{
    db.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run('u','u@example.com','test',date);
    db.prepare('INSERT INTO posts(id,user_id,source_url,title,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('p','u','https://www.instagram.com/p/example/','',date,date);
    db.prepare('INSERT INTO jobs(id,user_id,post_id,fingerprint,status,source_url,material_json,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('j','u','p','f','queued','https://www.instagram.com/p/example/',JSON.stringify({caption:'',assets:[]}),JSON.stringify({model:'fake',maxImages:2,maxOutputTokens:500,maxVideoSeconds:10}),date,date);
    const job=claimJob(db,'worker');
    const prepared={evidence:[{id:'frame:1',kind:'video_frame',time_seconds:1}],images:[{id:'frame:1',kind:'video_frame',time_seconds:1,path:'/unused.png',mime:'image/png'}],audio:[{id:'audio:1',path:'/unused.mp3',mime:'audio/mpeg',duration_seconds:2}],coverage:{kind:'sampled_video',partial:true,audio_status:'pending_transcription'}};
    await processJob(db,job,{dataDir:folder,prepare:async()=>prepared,provider:{async describeImage(){return{scene:'사람이 걷는다',visible_text:['서울'],objects:['사람'],actions:['걷기'],uncertainties:[],model:'fake'};},async summarize(input){assert.equal(input.images.length,0);assert.equal(input.media_text.visual[0].time_seconds,1);assert.equal(input.media_text.audio[0].segments[0].start_seconds,0.2);assert.equal(input.evidence.at(-1).kind,'audio_transcript');return{result:{...sampleResult,summary_evidence_ids:['frame:1']},evidence:input.evidence,usage:null};}},transcriber:{async transcribe(){return normalizeTranscription({text:'안녕하세요',language:'ko',segments:[{start:0.2,end:1.4,text:'안녕하세요'}]});}}});
    const saved=db.prepare('SELECT * FROM jobs WHERE id=?').get('j');assert.equal(saved.status,'completed');assert.equal(JSON.parse(saved.media_text_json).visual[0].visible_text[0],'서울');assert.equal(JSON.parse(saved.coverage_json).audio_status,'transcribed');
    assert.equal(transcriberFromEnv({ASR_PROVIDER:'none'}),null);
  }finally{db.close();await fs.rm(folder,{recursive:true,force:true});}
});
test('audio jobs without ASR stop before summary and keep visual observations',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-asr-gap-')),db=openDatabase(path.join(folder,'pinmap.sqlite')),date=new Date().toISOString();
  try{
    db.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run('u','u@example.com','test',date);
    db.prepare('INSERT INTO posts(id,user_id,source_url,title,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('p','u','https://www.instagram.com/p/example/','',date,date);
    db.prepare('INSERT INTO jobs(id,user_id,post_id,fingerprint,status,source_url,material_json,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('j','u','p','f','queued','https://www.instagram.com/p/example/','{"caption":"","assets":[]}','{"model":"fake"}',date,date);
    const job=claimJob(db,'worker');
    await processJob(db,job,{dataDir:folder,prepare:async()=>({evidence:[{id:'image',kind:'image'}],images:[{id:'image',kind:'image',path:'/unused.png'}],audio:[{id:'audio',path:'/unused.mp3'}],coverage:{partial:true}}),transcriber:null,provider:{async describeImage(){return{scene:'꽃',visible_text:[],objects:['꽃'],actions:[],uncertainties:[]};},async summarize(){throw Error('summary must not run');}}});
    const saved=db.prepare('SELECT status,error_json,media_text_json FROM jobs WHERE id=?').get('j');assert.equal(saved.status,'failed');assert.equal(JSON.parse(saved.error_json).code,'asr_not_configured');assert.equal(JSON.parse(saved.media_text_json).visual[0].scene,'꽃');
  }finally{db.close();await fs.rm(folder,{recursive:true,force:true});}
});
test('vLLM speech endpoint returns transcript and timecoded segments',async()=>{
  let endpoint,form;
  const transcriber=transcriberFromEnv({ASR_PROVIDER:'vllm',ASR_BASE_URL:'http://127.0.0.1:8001/v1',ASR_MODEL:'whisper-test'},async(url,options)=>{endpoint=String(url);form=options.body;return Response.json({text:'안녕',language:'ko',segments:[{start:0.1,end:0.8,text:'안녕'}]});});
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-asr-http-')),file=path.join(folder,'audio.mp3');
  try{await fs.writeFile(file,Buffer.from('fake-audio'));const result=await transcriber.transcribe({path:file,mime:'audio/mpeg'});assert.equal(endpoint,'http://127.0.0.1:8001/v1/audio/transcriptions');assert.equal(form.get('model'),'whisper-test');assert.equal(result.segments[0].start_seconds,0.1);}
  finally{await fs.rm(folder,{recursive:true,force:true});}
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
test('vLLM converts one image into structured text before synthesis',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-visual-http-')),file=path.join(folder,'image.png');
  try{
    await fs.writeFile(file,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=','base64'));
    let body;const client=new VllmClient({baseUrl:'http://127.0.0.1:8000/v1',model:'vision-test',fetchImpl:async(url,options)=>{body=JSON.parse(options.body);return Response.json({model:'vision-test',choices:[{finish_reason:'stop',message:{content:JSON.stringify({scene:'사람이 걷는 장면',visible_text:['서울'],objects:['사람'],actions:['걷기'],uncertainties:[]})}}]});}});
    const result=await client.describeImage({id:'frame:1',kind:'video_frame',path:file,mime:'image/png',time_seconds:2});
    assert.equal(body.response_format.json_schema.name,'pinmap_visual_text');assert.equal(body.messages[1].content[0].text.includes('frame:1'),true);assert.equal(result.visible_text[0],'서울');
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

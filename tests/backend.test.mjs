import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';
import {OpenAIClient} from '../lib/openai-client.mjs';
import {Store} from '../lib/store.mjs';
import {AnalysisEngine} from '../lib/engine.mjs';
import {loadCatalog,hash} from '../lib/catalog.mjs';
import {RESULT_SCHEMA,validateResult} from '../lib/contract.mjs';
import {prepareMedia,runFfmpeg,identifyMedia} from '../lib/media.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=','base64');
const settings=()=>({apiKey:'test_secret_do_not_persist',model:'gpt-4.1-mini',transcriptionModel:'gpt-4o-mini-transcribe',maxImages:4,maxOutputTokens:1200,maxVideoSeconds:20});
const output=(ids=['caption'])=>({title:'서버 테스트 응답',summary:'합성 테스트 입력의 요약입니다.',summary_evidence_ids:ids,topics:['테스트'],visible_text:[],facts:[],inferences:[],limitations:['테스트용 모의 응답']});
const apiResponse=result=>new Response(JSON.stringify({id:'resp_test',status:'completed',model:'test_model',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(result)}]}],usage:{input_tokens:11,output_tokens:22,total_tokens:33}}),{status:200,headers:{'Content-Type':'application/json','x-request-id':'req_test'}});
async function fixture(){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-ai-')),evidence=path.join(dir,'collector/results/evidence');await fs.mkdir(evidence,{recursive:true});
 const posts=[{id:'1',url:'https://www.instagram.com/p/One/',title:'첫째',sourceCaption:'raw-caption-sentinel',memo:'DO_NOT_SEND_MEMO',sourceCollections:['DO_NOT_SEND_COLLECTION']},{id:'2',url:'https://www.instagram.com/p/Two/',title:'둘째',sourceCaption:'caption-two'},{id:'3',url:'https://www.instagram.com/p/Three/',title:'셋째',sourceCaption:'caption-three'}];
 await fs.writeFile(path.join(dir,'pinmap-items.json'),JSON.stringify(posts));
 await fs.writeFile(path.join(dir,'collector/results/latest.json'),JSON.stringify([{url:posts[0].url,status:'collected',method:'browser',fields:{}},{url:posts[1].url,status:'wrong_page',method:'browser',fields:{}}]));
 for(const code of ['One','Two']){await fs.writeFile(path.join(evidence,code+'.png'),png);await fs.writeFile(path.join(evidence,code+'.json'),JSON.stringify({url:'https://www.instagram.com/p/'+code+'/',canonical:'https://www.instagram.com/p/'+code+'/'}));}
 return{dir,posts,cleanup:()=>fs.rm(dir,{recursive:true,force:true})};
}
async function serve(f,{key=true,fetchImpl}={}){const app=await createApp({sourceRoot:f.dir,dataRoot:path.join(f.dir,'.test-data'),initialSettings:{...settings(),apiKey:key?settings().apiKey:''},fetchImpl});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));return{...app,base:'http://127.0.0.1:'+app.server.address().port,close:async()=>{app.engine.pause();await app.engine.waitForIdle();await new Promise(r=>app.server.close(r));}};}
const post=(base,url,data,extra={})=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json',...extra},body:JSON.stringify(data)});

test('JSON contract rejects invented evidence and marks invalid structured output as failure',()=>{
 assert.equal(validateResult(output(),[{id:'caption'}]).title,'서버 테스트 응답');
 assert.throws(()=>validateResult(output(['imaginary-frame']),[{id:'caption'}]),e=>e.code==='unknown_evidence');
 assert.throws(()=>validateResult({...output(),summary:5},[{id:'caption'}]),e=>e.code==='invalid_model_output');
 assert.equal(RESULT_SCHEMA.additionalProperties,false);
});

test('catalog rejects screenshots from wrong pages and excludes manually written examples',async()=>{
 const f=await fixture();try{const store=new Store(path.join(f.dir,'.data'));await store.init();await fs.mkdir(path.join(f.dir,'media-analysis'));await fs.writeFile(path.join(f.dir,'media-analysis/analysis-samples.json'),'{"summary":"DO_NOT_USE_HANDWRITTEN_SAMPLE"}');const p=await loadCatalog(f.dir,store);assert.equal(p.length,3);assert.equal(p[0].assets.length,1);assert.equal(p[1].assets.length,0);assert.equal(p[2].assets.length,0);assert.ok(!JSON.stringify(p).includes('DO_NOT_USE_HANDWRITTEN_SAMPLE'));assert.ok(!JSON.stringify(p).includes('DO_NOT_SEND_MEMO'));}finally{await f.cleanup();}
});

test('Responses call sends actual image bytes and strict JSON schema, with no Meta request',async()=>{
 const f=await fixture();try{let sent;const cfg=settings(),client=new OpenAIClient({settings:cfg,fetchImpl:async(url,init)=>{assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(init.headers.Authorization,'Bearer '+cfg.apiKey);sent=JSON.parse(init.body);return apiResponse(output(['image-1']));}});const prepared={coverage:{partial:true},evidence:[{id:'caption',kind:'caption',text:'original-caption'},{id:'image-1',kind:'page_capture'}],images:[{id:'image-1',kind:'page_capture',mime:'image/png',path:path.join(f.dir,'collector/results/evidence/One.png'),time_seconds:null}]};const r=await client.summarize(prepared,{sourceUrl:'https://www.instagram.com/p/One/'});assert.equal(sent.store,false);assert.equal(sent.text.format.type,'json_schema');assert.equal(sent.text.format.strict,true);assert.ok(sent.input[0].content.some(x=>x.type==='input_image'&&x.image_url.endsWith(png.toString('base64'))));assert.equal(r.usage.total_tokens,33);assert.equal(r.request_id,'req_test');}finally{await f.cleanup();}
});

test('incomplete responses, refusals and invalid JSON never become completed output',async()=>{
 const p={coverage:{partial:true},evidence:[{id:'caption'}],images:[]};
 for(const [body,code]of [[{status:'incomplete',output:[]},'incomplete_response'],[{status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'cannot'}]}]},'model_refusal'],[{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'not-json'}]}]},'invalid_model_output']]){const client=new OpenAIClient({settings:settings(),fetchImpl:async()=>Response.json(body)});await assert.rejects(client.summarize(p,{sourceUrl:'https://www.instagram.com/p/One/'}),e=>e.code===code);}
});

test('provider errors redact credentials and expose rate-limit status without blind retries',async()=>{
 let calls=0;const cfg=settings(),client=new OpenAIClient({settings:cfg,fetchImpl:async()=>{calls++;return Response.json({error:{code:'insufficient_quota',message:'error '+cfg.apiKey}},{status:429,headers:{'retry-after':'60'}});}});
 await assert.rejects(client.summarize({coverage:{},evidence:[],images:[]},{sourceUrl:'https://www.instagram.com/p/One/'}),e=>e.status===429&&e.retryAfterMs===60000&&!e.message.includes(cfg.apiKey));assert.equal(calls,1);
});

test('HTTP backend queues jobs, reuses identical inputs and persists only actual provider results',async()=>{
 const f=await fixture();let calls=0,providerInput;const app=await serve(f,{fetchImpl:async(url,init)=>{calls++;providerInput=init.body;return apiResponse(output());}});
 try{const [a,b]=await Promise.all([post(app.base,'/api/jobs',{post_ids:['1'],limit:1}),post(app.base,'/api/jobs',{post_ids:['1'],limit:1})]);assert.equal(a.status,202);assert.equal(b.status,202);const aa=await a.json(),bb=await b.json();assert.equal(aa.jobs[0].id,bb.jobs[0].id);await app.engine.waitForIdle();assert.equal(calls,1);assert.ok(providerInput.includes('raw-caption-sentinel'));assert.ok(!providerInput.includes('DO_NOT_SEND_MEMO'));assert.ok(!providerInput.includes('DO_NOT_SEND_COLLECTION'));
 const result=await(await fetch(app.base+'/api/results')).json();assert.equal(result.results.length,1);assert.equal(result.results[0].provider.request_id,'req_test');assert.equal(result.results[0].coverage.kind,'partial_page_capture');assert.equal(result.results[0].coverage.partial,true);
 const state=JSON.stringify(await(await fetch(app.base+'/api/state')).json()),jobs=JSON.stringify(await(await fetch(app.base+'/api/jobs')).json());assert.ok(!state.includes(settings().apiKey));assert.ok(!jobs.includes(settings().apiKey));assert.ok(!jobs.includes('"material"'));
 for(const name of await fs.readdir(path.join(app.store.root,'jobs')))assert.ok(!(await fs.readFile(path.join(app.store.root,'jobs',name),'utf8')).includes(settings().apiKey));
 const skipped=await(await post(app.base,'/api/jobs',{post_ids:['3'],limit:1,require_visual:true})).json();assert.equal(skipped.jobs.length,0);assert.equal(skipped.skipped.length,1);assert.equal(calls,1);
 }finally{await app.close();await f.cleanup();}
});

test('HTTP security keeps credentials server-side, blocks foreign origins and never serves private files',async()=>{
 const f=await fixture(),app=await serve(f,{key:false,fetchImpl:async()=>{throw new Error('must not call');}});
 try{assert.equal((await post(app.base,'/api/jobs',{limit:1})).status,503);assert.equal((await post(app.base,'/api/settings',{api_key:'test_private_key'},{Origin:'https://outside.invalid'})).status,403);const r=await post(app.base,'/api/settings',{api_key:'test_private_key'});assert.equal(r.status,200);assert.ok(!(await r.text()).includes('test_private_key'));assert.equal((await fetch(app.base+'/.env')).status,404);assert.equal((await fetch(app.base+'/.data/jobs')).status,404);assert.equal((await post(app.base,'/api/jobs',{limit:350})).status,400);}finally{await app.close();await f.cleanup();}
});

test('image uploads become the actual model input instead of old page captures',async()=>{
 const f=await fixture(),app=await serve(f,{fetchImpl:async()=>apiResponse(output())});try{const data=new FormData();data.append('files',new Blob([png],{type:'image/png'}),'new-photo.png');data.append('complete','true');const r=await fetch(app.base+'/api/posts/1/assets',{method:'POST',body:data});assert.equal(r.status,201);const item=app.getCatalog().find(p=>p.id==='1');assert.equal(item.assets.length,1);assert.equal(item.assets[0].kind,'image');assert.equal(item.assets[0].complete,true);assert.ok(!item.assets[0].path.includes('evidence'));assert.throws(()=>identifyMedia(Buffer.from('<html>bad</html>'),'fake.png'),e=>e.code==='unsupported_media');}finally{await app.close();await f.cleanup();}
});

test('video preparation uses real frames with timestamps and extracts an audio track',async()=>{
 const f=await fixture();try{const file=path.join(f.dir,'sample.mp4');await runFfmpeg(['-f','lavfi','-i','color=c=blue:s=320x240:r=10','-f','lavfi','-i','sine=frequency=660:sample_rate=16000','-t','2','-c:v','mpeg4','-c:a','aac','-shortest',file]);const bytes=await fs.readFile(file),material={caption:'video-caption',assets:[{id:'test-video',kind:'video',name:'sample.mp4',mime:'video/mp4',path:file,sha256:hash(bytes),complete:true}]};const prepared=await prepareMedia(material,path.join(f.dir,'work'),settings());assert.ok(prepared.images.length>=2);assert.ok(prepared.images.length<=4);assert.equal(prepared.audio.length,1);assert.equal(prepared.coverage.kind,'sampled_video');assert.equal(prepared.coverage.partial,true);for(const e of prepared.images)assert.ok(e.time_seconds>=0&&e.time_seconds<=2.1);assert.ok((await fs.stat(prepared.audio[0].path)).size>0);await assert.rejects(prepareMedia(material,path.join(f.dir,'too-long'),{...settings(),maxVideoSeconds:1}),e=>e.code==='video_duration_limit');}finally{await f.cleanup();}
});

test('input mutation is detected before any model call',async()=>{
 const f=await fixture();try{const file=path.join(f.dir,'collector/results/evidence/One.png');const material={caption:'',assets:[{id:'img',kind:'image',mime:'image/png',path:file,name:'a.png',sha256:hash(png)}]};await fs.writeFile(file,Buffer.concat([png,Buffer.from('changed')]));await assert.rejects(prepareMedia(material,path.join(f.dir,'work'),settings()),e=>e.code==='input_changed');}finally{await f.cleanup();}
});

test('uploaded video is transcribed before frames and transcript are sent to the summary API',async()=>{
 const f=await fixture(),calls=[];let summaryBody;
 const app=await serve(f,{fetchImpl:async(url,init)=>{
   calls.push(url);
   if(url.endsWith('/audio/transcriptions')){assert.ok(init.body instanceof FormData);assert.equal(init.body.get('model'),'gpt-4o-mini-transcribe');assert.ok(init.body.get('file').size>0);return Response.json({text:'synthetic-transcript-sentinel',usage:{type:'duration',seconds:2}},{headers:{'x-request-id':'req_audio'}});}
   summaryBody=JSON.parse(init.body);const text=JSON.parse(summaryBody.input[0].content[0].text);const transcript=text.evidence.find(e=>e.kind==='audio_transcript');assert.equal(transcript.text,'synthetic-transcript-sentinel');assert.equal(transcript.timing_precision,'whole_audio');assert.equal(text.coverage.audio_status,'transcribed');return apiResponse(output([transcript.id]));
 }});
 try{const video=path.join(f.dir,'video-with-audio.mp4');await runFfmpeg(['-f','lavfi','-i','color=c=green:s=320x240:r=10','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','2','-c:v','mpeg4','-c:a','aac','-shortest',video]);const form=new FormData();form.append('files',new Blob([await fs.readFile(video)],{type:'video/mp4'}),'video.mp4');assert.equal((await fetch(app.base+'/api/posts/3/assets',{method:'POST',body:form})).status,201);assert.equal((await post(app.base,'/api/jobs',{post_ids:['3'],limit:1})).status,202);await app.engine.waitForIdle();const job=app.engine.list()[0];assert.equal(job.status,'completed');assert.deepEqual(calls,['https://api.openai.com/v1/audio/transcriptions','https://api.openai.com/v1/responses']);assert.ok(summaryBody.input[0].content.filter(c=>c.type==='input_image').length>=2);assert.equal(job.transcriptions[0].request_id,'req_audio');assert.equal(job.usage.transcriptions[0].usage.seconds,2);assert.equal(job.coverage.kind,'sampled_video');assert.equal(job.coverage.audio_status,'transcribed');assert.equal(job.result.summary_evidence_ids[0],job.transcriptions[0].id);
 }finally{await app.close();await f.cleanup();}
});

test('queue pauses after quota exhaustion and does not issue requests for the remaining jobs',async()=>{
 const f=await fixture();let calls=0;const app=await serve(f,{fetchImpl:async()=>{calls++;return Response.json({error:{code:'insufficient_quota',message:'quota exceeded'}},{status:429});}});try{await post(app.base,'/api/jobs',{post_ids:['1','3'],limit:2,require_visual:false});await app.engine.waitForIdle();assert.equal(calls,1);assert.equal(app.engine.paused,true);assert.equal(app.engine.list().filter(j=>j.status==='queued').length,1);assert.equal(app.engine.list().filter(j=>j.status==='failed').length,1);}finally{await app.close();await f.cleanup();}
});

test('interrupted paid calls are not silently replayed after restart',async()=>{
 const f=await fixture();try{const store=new Store(path.join(f.dir,'.data'));await store.init();await store.saveJob({id:'00000000-0000-0000-0000-000000000001',item_id:'1',created_at:'2026-11-05T00:00:00Z',status:'summarizing'});const engine=new AnalysisEngine({store,settings:settings(),provider:{summarize:()=>{throw new Error('must not replay');}}});await engine.init();assert.equal(engine.list()[0].status,'interrupted');assert.equal(engine.state().queued,0);}finally{await f.cleanup();}
});

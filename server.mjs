import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store} from './lib/store.mjs';
import {loadCatalog,catalogView,resolveSourceRoot} from './lib/catalog.mjs';
import {OpenAIClient} from './lib/openai-client.mjs';
import {AnalysisEngine,publicJob} from './lib/engine.mjs';
import {saveUpload,ffmpeg} from './lib/media.mjs';
import {AppError,safeError} from './lib/errors.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
export async function createApp({sourceRoot,dataRoot=path.join(here,'.data'),fetchImpl=fetch,initialSettings={}}={}){
  sourceRoot=sourceRoot||await resolveSourceRoot(here);
  const settings={apiKey:process.env.OPENAI_API_KEY||'',model:process.env.OPENAI_MODEL||'gpt-4.1-mini',transcriptionModel:process.env.OPENAI_TRANSCRIPTION_MODEL||'gpt-4o-mini-transcribe',maxImages:24,maxOutputTokens:2400,maxVideoSeconds:600,...initialSettings};
  const store=new Store(dataRoot);await store.init();let catalog=await loadCatalog(sourceRoot,store);
  const provider=new OpenAIClient({settings,fetchImpl}),engine=new AnalysisEngine({store,settings,provider});await engine.init();
  const staticFiles={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};
  const safeSettings=()=>({configured:!!settings.apiKey,model:settings.model,transcription_model:settings.transcriptionModel,max_images:settings.maxImages,max_video_seconds:settings.maxVideoSeconds,max_output_tokens:settings.maxOutputTokens});
  const respond=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));};
  const readBody=async(req,limit=1024*1024)=>{let size=0;const buffers=[];for await(const b of req){size+=b.length;if(size>limit)throw new AppError('요청 크기 제한을 초과했습니다.',{code:'request_too_large',status:413});buffers.push(b);}return Buffer.concat(buffers);};
  const requireJson=async req=>{if(!(req.headers['content-type']||'').startsWith('application/json'))throw new AppError('JSON 형식의 입력이 필요합니다.',{status:415});try{return JSON.parse((await readBody(req)).toString()||'{}');}catch(e){if(e instanceof AppError)throw e;throw new AppError('JSON 입력이 올바르지 않습니다.');}};
  const server=http.createServer(async(req,res)=>{
    try{
      const port=server.address()?.port,allowedHosts=new Set([`127.0.0.1:${port}`,`localhost:${port}`]);
      if(!allowedHosts.has(req.headers.host))throw new AppError('로컬 주소에서만 사용할 수 있습니다.',{status:403});
      if(req.headers.origin&&!['http://127.0.0.1:'+port,'http://localhost:'+port].includes(req.headers.origin))throw new AppError('다른 사이트에서 실행할 수 없습니다.',{status:403});
      const url=new URL(req.url,'http://127.0.0.1:'+port);
      if(req.method==='GET'&&staticFiles[url.pathname]){const file=staticFiles[url.pathname];res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"});res.end(await fs.readFile(path.join(here,'web',file)));return;}
      if(req.method==='GET'&&(url.pathname==='/health'||url.pathname==='/api/state')){respond(res,200,{ok:true,service:'pinmap-ai-analysis',meta_api_enabled:false,settings:safeSettings(),media_processor:!!ffmpeg,catalog:{total:catalog.length,visual_ready:catalog.filter(p=>p.assets.some(a=>a.kind!=='audio')).length,caption_available:catalog.filter(p=>p.caption.trim()).length,original_video_files:catalog.reduce((n,p)=>n+p.assets.filter(a=>a.kind==='video').length,0)},queue:engine.state()});return;}
      if(req.method==='GET'&&url.pathname==='/api/posts'){const q=(url.searchParams.get('q')||'').toLowerCase(),ready=url.searchParams.get('ready')==='true';respond(res,200,{posts:catalog.filter(p=>(!q||[p.id,p.code,p.title].some(x=>x?.toLowerCase().includes(q)))&&(!ready||p.assets.some(a=>a.kind!=='audio'))).map(catalogView)});return;}
      if(req.method==='GET'&&url.pathname==='/api/jobs'){respond(res,200,{jobs:engine.list()});return;}
      if(req.method==='GET'&&url.pathname==='/api/results'){respond(res,200,{results:engine.list().filter(j=>j.status==='completed').map(j=>({job_id:j.id,item_id:j.item_id,source_url:j.source_url,coverage:j.coverage,evidence:j.evidence,result:j.result,usage:j.usage,provider:j.provider,completed_at:j.completed_at}))});return;}
      const jobRoute=url.pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})(?:\/(cancel))?$/);
      if(req.method==='GET'&&jobRoute&&!jobRoute[2]){const job=engine.jobs.get(jobRoute[1]);if(!job)throw new AppError('작업을 찾지 못했습니다.',{status:404});respond(res,200,publicJob(job));return;}
      const assetRoute=url.pathname.match(/^\/api\/posts\/([A-Za-z0-9_-]{1,100})\/assets$/);
      if(req.method==='POST'&&assetRoute){
        const post=catalog.find(p=>p.id===assetRoute[1]);if(!post)throw new AppError('게시물 ID를 확인하세요.',{status:404});
        const contentType=req.headers['content-type']||'';if(!contentType.startsWith('multipart/form-data'))throw new AppError('multipart/form-data로 파일을 보내세요.',{status:415});
        const buffer=await readBody(req,160*1024*1024);let form;try{form=await new Request('http://localhost/upload',{method:'POST',headers:{'Content-Type':contentType},body:buffer}).formData();}catch{throw new AppError('파일 업로드 형식이 올바르지 않습니다.');}
        const files=form.getAll('files').filter(x=>typeof x!=='string');if(!files.length||files.length>40)throw new AppError('한 번에 1~40개의 파일을 입력하세요.');
        const assets=[];for(const f of files)assets.push(await saveUpload(store,post.id,f,{complete:form.get('complete')==='true'}));await store.addUploads(post.id,assets);catalog=await loadCatalog(sourceRoot,store);respond(res,201,{item_id:post.id,assets:assets.map(({path,...a})=>a)});return;
      }
      if(req.method==='POST'){
        const body=await requireJson(req);
        if(url.pathname==='/api/settings'){
          if(engine.processing)throw new AppError('현재 작업이 끝난 뒤 연결 정보를 바꾸세요.',{status:409});
          if(typeof body.api_key!=='string'||!body.api_key.trim()||/\s/.test(body.api_key.trim()))throw new AppError('OpenAI API 키를 확인해 주세요.');
          for(const k of ['model','transcription_model'])if(body[k]&&!/^[A-Za-z0-9._:-]{1,100}$/.test(body[k]))throw new AppError('모델 이름이 올바르지 않습니다.');
          settings.apiKey=body.api_key.trim();if(body.model)settings.model=body.model;if(body.transcription_model)settings.transcriptionModel=body.transcription_model;
          respond(res,200,{...safeSettings(),message:'AI 키는 이 서버의 메모리에만 적용했습니다.'});return;
        }
        if(url.pathname==='/api/catalog/refresh'){catalog=await loadCatalog(sourceRoot,store);respond(res,200,{total:catalog.length});return;}
        if(url.pathname==='/api/jobs'){
          const limit=body.limit??1;if(!Number.isInteger(limit)||limit<1||limit>349)throw new AppError('처리 개수는 1~349개입니다.');
          if(body.post_ids!==undefined&&(!Array.isArray(body.post_ids)||!body.post_ids.length||body.post_ids.some(id=>typeof id!=='string')))throw new AppError('post_ids에는 게시물 ID 목록을 입력하세요.');
          let posts=catalog;if(body.post_ids){const ids=new Set(body.post_ids);posts=catalog.filter(p=>ids.has(p.id));if(posts.length!==ids.size)throw new AppError('존재하지 않는 게시물 ID가 있습니다.');}
          const requireVisual=body.require_visual!==false;if(requireVisual&&!body.post_ids)posts=posts.filter(p=>p.assets.some(a=>a.kind!=='audio'));
          posts=posts.slice(0,limit);if(!posts.length)throw new AppError('분석 가능한 입력 자료가 없습니다.',{code:'missing_input'});
          const r=await engine.enqueue(posts,{force:body.force===true,requireVisual});respond(res,202,r);return;
        }
        if(url.pathname==='/api/queue/pause'){engine.pause();respond(res,200,engine.state());return;}
        if(url.pathname==='/api/queue/resume'){engine.resume();respond(res,200,engine.state());return;}
        if(jobRoute?.[2]==='cancel'){await engine.cancel(jobRoute[1]);respond(res,200,{cancel_requested:true});return;}
      }
      throw new AppError('요청한 경로를 찾지 못했습니다.',{status:404});
    }catch(e){respond(res,e.status>=400&&e.status<=599?e.status:500,{error:{code:e.code||'server_error',message:safeError(e,settings.apiKey)}});}
  });
  server.requestTimeout=300000;server.headersTimeout=30000;
  return{server,engine,settings,store,getCatalog:()=>catalog};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=await createApp(),port=Number(process.env.PORT||8101);
  app.server.listen(port,'127.0.0.1',()=>{console.log(`AI 게시물 요약: http://127.0.0.1:${app.server.address().port}`);app.engine.kick();});
  for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{app.engine.pause();app.server.close(()=>process.exit(0));});
}

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
import Busboy from 'busboy';
import {identifyMedia} from '../lib/media.mjs';
import {AppError,safeError} from '../lib/errors.mjs';
import {openDatabase,now,publicPost,publicJob} from './db.mjs';
import {normalizeEmail,hashPassword,verifyPassword,newSession,sessionUser,logout,sessionCookie,clearCookie} from './auth.mjs';
import {parseInstagramZip,instagramUrl} from './import.mjs';
import {getPost,postAssets,enqueueJob,jobForUser,cancelJob} from './jobs.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const json=(res,status,body,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(JSON.stringify(body));};
async function readBody(req,max=1024*1024){let size=0;const chunks=[];for await(const part of req){size+=part.length;if(size>max)throw new AppError('요청 크기를 초과했습니다.',{status:413});chunks.push(part);}return Buffer.concat(chunks);}
async function readJson(req){if(!String(req.headers['content-type']||'').startsWith('application/json'))throw new AppError('JSON 입력이 필요합니다.',{status:415});try{return JSON.parse((await readBody(req)).toString('utf8')||'{}');}catch(e){if(e instanceof AppError)throw e;throw new AppError('JSON 형식이 올바르지 않습니다.',{status:400});}}
async function multipartFile(req,tempDir,maxBytes){
  if(!String(req.headers['content-type']||'').startsWith('multipart/form-data'))throw new AppError('파일 업로드 형식이 필요합니다.',{status:415});
  await fsp.mkdir(tempDir,{recursive:true,mode:0o700});const temp=path.join(tempDir,crypto.randomUUID());
  const fields={},fileInfo={name:'',bytes:0};let pipeTask=null,tooLarge=false,tooMany=false,seen=0;
  try{
    const busboy=Busboy({headers:req.headers,limits:{files:1,fileSize:maxBytes,fields:3,fieldSize:1024}});
    busboy.on('field',(name,value)=>{fields[name]=value;});
    busboy.on('filesLimit',()=>{tooMany=true;});
    busboy.on('file',(_,stream,info)=>{seen++;fileInfo.name=path.basename(info.filename||'upload').slice(0,180);stream.on('limit',()=>{tooLarge=true;});pipeTask=pipeline(stream,fs.createWriteStream(temp,{flags:'wx',mode:0o600}));});
    const ended=new Promise((resolve,reject)=>{busboy.on('finish',resolve);busboy.on('error',reject);req.on('error',reject);});req.pipe(busboy);await ended;
    if(pipeTask)await pipeTask;
    if(tooLarge)throw new AppError('파일 크기 제한을 초과했습니다.',{status:413});
    if(tooMany)throw new AppError('파일은 한 개씩 업로드하세요.',{status:400});
    if(seen!==1)throw new AppError('파일은 한 개씩 업로드하세요.',{status:400});
    fileInfo.bytes=(await fsp.stat(temp)).size;if(!fileInfo.bytes)throw new AppError('빈 파일입니다.',{status:400});
    return{temp,fields,...fileInfo};
  }catch(e){await fsp.unlink(temp).catch(()=>{});throw e;}
}
function settingsFromEnv(env){const providerName=env.MULTIUSER_AI_PROVIDER||'ollama';if(!['ollama','vllm'].includes(providerName))throw Error('MULTIUSER_AI_PROVIDER must be ollama or vllm');const settings={providerName,model:env.MULTIUSER_MODEL||(providerName==='ollama'?'qwen2.5vl:3b':''),maxImages:Number(env.MULTIUSER_MAX_IMAGES||4),maxOutputTokens:Number(env.MULTIUSER_MAX_OUTPUT_TOKENS||1400),maxVideoSeconds:Number(env.MULTIUSER_MAX_VIDEO_SECONDS||600),dailyJobLimit:Number(env.MULTIUSER_DAILY_JOB_LIMIT||50)};if(!settings.model||!Number.isInteger(settings.maxImages)||settings.maxImages<1||settings.maxImages>24||!Number.isInteger(settings.maxOutputTokens)||settings.maxOutputTokens<128||settings.maxOutputTokens>8192||!Number.isInteger(settings.maxVideoSeconds)||settings.maxVideoSeconds<1||settings.maxVideoSeconds>600||!Number.isInteger(settings.dailyJobLimit)||settings.dailyJobLimit<1||settings.dailyJobLimit>500)throw Error('Invalid multiuser model limits');return settings;}
export async function createMultiuserApp({dataDir=path.resolve(process.env.MULTIUSER_DATA_DIR||'.multiuser-data'),env=process.env,db=openDatabase(path.join(dataDir,'pinmap.sqlite'))}={}){
  const settings=settingsFromEnv(env),secure=env.PUBLIC_ORIGIN?.startsWith('https://')||false;
  const allowedOrigin=env.PUBLIC_ORIGIN||'http://127.0.0.1:'+String(env.MULTIUSER_PORT||8200);
  if((env.MULTIUSER_HOST||'127.0.0.1')!=='127.0.0.1'&&(env.MULTIUSER_HOST||'127.0.0.1')!=='localhost'&&!secure)throw Error('PUBLIC_ORIGIN must use HTTPS when bound beyond localhost');
  const inviteCode=env.PINMAP_INVITE_CODE||'';
  const dummyHash=await hashPassword('dummy-password-for-timing');
  const server=http.createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://local');
      res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
      if(req.method==='GET'&&url.pathname==='/health'){json(res,200,{ok:true,service:'pinmap-multiuser'});return;}
      if(req.method==='GET'&&['/','/app.js','/style.css'].includes(url.pathname)){
        const name=url.pathname==='/'?'index.html':url.pathname.slice(1),file=path.join(here,'web',name);
        res.writeHead(200,{'Content-Type':name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"});res.end(await fsp.readFile(file));return;
      }
      if(!url.pathname.startsWith('/api/'))throw new AppError('경로를 찾지 못했습니다.',{status:404});
      if(!['GET','POST'].includes(req.method))throw new AppError('지원하지 않는 요청입니다.',{status:405});
      if(req.method==='POST'){
        if(req.headers.origin&&req.headers.origin!==allowedOrigin)throw new AppError('다른 사이트에서 요청할 수 없습니다.',{status:403});
        if(req.headers['x-pinmap-csrf']!=='1')throw new AppError('요청 확인 헤더가 필요합니다.',{status:403});
      }
      if(req.method==='POST'&&url.pathname==='/api/auth/register'){
        if(!inviteCode)throw new AppError('관리자가 가입 초대 코드를 설정해야 합니다.',{status:503});
        const body=await readJson(req),email=normalizeEmail(body.email);
        const supplied=Buffer.from(typeof body.invite_code==='string'?body.invite_code:''),expected=Buffer.from(inviteCode);
        if(supplied.length!==expected.length||!crypto.timingSafeEqual(supplied,expected))throw new AppError('초대 코드가 올바르지 않습니다.',{status:403});
        const passwordHash=await hashPassword(body.password),id=crypto.randomUUID();
        try{db.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run(id,email,passwordHash,now());}catch(e){if(e.code==='SQLITE_CONSTRAINT_UNIQUE')throw new AppError('이미 등록된 이메일입니다.',{status:409});throw e;}
        const session=newSession(db,id);json(res,201,{user:{id,email}},{'Set-Cookie':sessionCookie(session.token,secure)});return;
      }
      if(req.method==='POST'&&url.pathname==='/api/auth/login'){
        const body=await readJson(req),email=normalizeEmail(body.email),user=db.prepare('SELECT * FROM users WHERE email=?').get(email);
        db.prepare('DELETE FROM login_attempts WHERE window_until<?').run(Date.now()-24*60*60*1000);
        const attempts=db.prepare('SELECT * FROM login_attempts WHERE email=?').get(email);
        if(attempts&&attempts.window_until>Date.now()&&attempts.attempts>=5)throw new AppError('잠시 후 다시 로그인하세요.',{status:429});
        if(!await verifyPassword(body.password,user?.password_hash||dummyHash)||!user){
          const windowUntil=attempts?.window_until>Date.now()?attempts.window_until:Date.now()+15*60*1000;
          const count=attempts?.window_until>Date.now()?attempts.attempts+1:1;
          db.prepare('INSERT INTO login_attempts(email,attempts,window_until) VALUES(?,?,?) ON CONFLICT(email) DO UPDATE SET attempts=excluded.attempts,window_until=excluded.window_until').run(email,count,windowUntil);
          throw new AppError('로그인 정보를 확인하세요.',{status:401});
        }
        db.prepare('DELETE FROM login_attempts WHERE email=?').run(email);
        const session=newSession(db,user.id);json(res,200,{user:{id:user.id,email}},{'Set-Cookie':sessionCookie(session.token,secure)});return;
      }
      const user=sessionUser(db,req);if(!user)throw new AppError('로그인이 필요합니다.',{status:401});
      if(req.method==='GET'&&url.pathname==='/api/me'){json(res,200,{user,settings:{provider:settings.providerName,model:settings.model,max_images:settings.maxImages}});return;}
      if(req.method==='POST'&&url.pathname==='/api/auth/logout'){logout(db,req);json(res,200,{ok:true},{'Set-Cookie':clearCookie(secure)});return;}
      if(req.method==='POST'&&url.pathname==='/api/import/instagram'){
        const uploaded=await multipartFile(req,path.join(dataDir,'tmp'),40*1024*1024);let posts;
        try{posts=await parseInstagramZip(await fsp.readFile(uploaded.temp));}finally{await fsp.unlink(uploaded.temp).catch(()=>{});}
        const insert=db.prepare('INSERT OR IGNORE INTO posts(id,user_id,external_id,source_url,title,caption,export_timestamp,export_fbid,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
        const imported=db.transaction(()=>{let added=0;for(const item of posts){const date=now();added+=insert.run(crypto.randomUUID(),user.id,item.externalId,item.url,item.title,item.caption,item.exportTimestamp,item.exportFbid,date,date).changes;}return added;})();
        json(res,201,{parsed:posts.length,imported,already_present:posts.length-imported,media_in_zip:false});return;
      }
      if(req.method==='POST'&&url.pathname==='/api/posts'){
        const body=await readJson(req),source=instagramUrl(body.source_url);
        const title=typeof body.title==='string'?body.title.slice(0,300):'',caption=typeof body.caption==='string'?body.caption.slice(0,100000):'';
        const id=crypto.randomUUID(),date=now();try{db.prepare('INSERT INTO posts(id,user_id,external_id,source_url,title,caption,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id,user.id,source.externalId,source.url,title,caption,date,date);}catch(e){if(e.code==='SQLITE_CONSTRAINT_UNIQUE')throw new AppError('이미 등록한 게시물입니다.',{status:409});throw e;}
        json(res,201,publicPost(getPost(db,user.id,id)));return;
      }
      if(req.method==='GET'&&url.pathname==='/api/posts'){
        const limit=Math.max(1,Math.min(100,Number(url.searchParams.get('limit')||50)||50)),offset=Math.max(0,Number(url.searchParams.get('offset')||0)||0);
        const rows=db.prepare('SELECT * FROM posts WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').all(user.id,limit,offset);
        json(res,200,{total:db.prepare('SELECT COUNT(*) AS n FROM posts WHERE user_id=?').get(user.id).n,posts:rows.map(row=>publicPost(row,postAssets(db,user.id,row.id))),limit,offset});return;
      }
      const postRoute=url.pathname.match(/^\/api\/posts\/([a-f0-9-]{36})(?:\/assets)?$/);
      if(req.method==='GET'&&postRoute&&!url.pathname.endsWith('/assets')){const post=getPost(db,user.id,postRoute[1]);if(!post)throw new AppError('게시물을 찾지 못했습니다.',{status:404});json(res,200,publicPost(post,postAssets(db,user.id,post.id)));return;}
      if(req.method==='POST'&&postRoute&&url.pathname.endsWith('/assets')){
        const post=getPost(db,user.id,postRoute[1]);if(!post)throw new AppError('게시물을 찾지 못했습니다.',{status:404});
        if(postAssets(db,user.id,post.id).length>=40)throw new AppError('게시물당 파일은 40개까지입니다.',{status:429});
        const upload=await multipartFile(req,path.join(dataDir,'tmp'),150*1024*1024);
        try{
          const fh=await fsp.open(upload.temp,'r'),first=Buffer.alloc(16);await fh.read(first,0,16,0);await fh.close();
          const type=identifyMedia(first,upload.name);if(type.kind==='image'&&upload.bytes>20*1024*1024)throw new AppError('이미지는 20MB 이하로 입력하세요.',{status:413});
          const used=db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM assets WHERE user_id=?').get(user.id).n;
          if(used+upload.bytes>2*1024*1024*1024)throw new AppError('계정당 저장 공간은 2GB까지입니다.',{status:429});
          const id=crypto.randomUUID(),folder=path.join(dataDir,'assets',user.id,post.id),destination=path.join(folder,id+type.extension);
          const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(upload.temp))hash.update(chunk);
          await fsp.mkdir(folder,{recursive:true,mode:0o700});await fsp.rename(upload.temp,destination);
          const asset={id,user_id:user.id,post_id:post.id,kind:type.kind,mime:type.mime,path:destination,name:upload.name,bytes:upload.bytes,sha256:hash.digest('hex'),complete:upload.fields.complete==='true'?1:0,created_at:now()};
          try{db.prepare('INSERT INTO assets(id,user_id,post_id,kind,mime,path,name,bytes,sha256,complete,created_at) VALUES(@id,@user_id,@post_id,@kind,@mime,@path,@name,@bytes,@sha256,@complete,@created_at)').run(asset);}catch(e){await fsp.unlink(destination).catch(()=>{});throw e;}
          json(res,201,{id:asset.id,kind:asset.kind,mime:asset.mime,name:asset.name,bytes:asset.bytes,complete:!!asset.complete});return;
        }finally{await fsp.unlink(upload.temp).catch(()=>{});}
      }
      const assetRoute=url.pathname.match(/^\/api\/assets\/([a-f0-9-]{36})$/);
      if(req.method==='GET'&&assetRoute){
        const asset=db.prepare('SELECT * FROM assets WHERE id=? AND user_id=?').get(assetRoute[1],user.id);if(!asset)throw new AppError('파일을 찾지 못했습니다.',{status:404});
        const stat=await fsp.stat(asset.path);let start=0,end=stat.size-1,status=200;
        const range=String(req.headers.range||'').match(/^bytes=(\d+)-(\d*)$/);if(req.headers.range&&!range)throw new AppError('요청한 파일 범위를 처리할 수 없습니다.',{status:416});
        if(range){start=Number(range[1]);end=range[2]?Number(range[2]):end;if(start>end||end>=stat.size)throw new AppError('요청한 파일 범위가 없습니다.',{status:416});status=206;}
        res.writeHead(status,{'Content-Type':asset.mime,'Cache-Control':'private, no-store','Accept-Ranges':'bytes','Content-Length':end-start+1,...(status===206?{'Content-Range':`bytes ${start}-${end}/${stat.size}`}:{})});fs.createReadStream(asset.path,{start,end}).pipe(res);return;
      }
      if(req.method==='POST'&&url.pathname==='/api/jobs'){
        const body=await readJson(req);if(typeof body.post_id!=='string')throw new AppError('post_id를 입력하세요.',{status:400});
        const created=await enqueueJob(db,user.id,body.post_id,settings,{requireVisual:body.require_visual===true,force:body.force===true});json(res,202,created);return;
      }
      if(req.method==='GET'&&url.pathname==='/api/jobs'){
        const rows=db.prepare('SELECT * FROM jobs WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(user.id);json(res,200,{jobs:rows.map(publicJob)});return;
      }
      const jobRoute=url.pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})(\/cancel)?$/);
      if(req.method==='GET'&&jobRoute&&!jobRoute[2]){json(res,200,jobForUser(db,user.id,jobRoute[1]));return;}
      if(req.method==='POST'&&jobRoute?.[2]){cancelJob(db,user.id,jobRoute[1]);json(res,200,{cancelled:true});return;}
      if(req.method==='GET'&&url.pathname==='/api/results'){
        const rows=db.prepare("SELECT * FROM jobs WHERE user_id=? AND status='completed' ORDER BY completed_at DESC LIMIT 100").all(user.id);json(res,200,{results:rows.map(publicJob)});return;
      }
      throw new AppError('경로를 찾지 못했습니다.',{status:404});
    }catch(e){const status=e.status>=400&&e.status<=599?e.status:500;json(res,status,{error:{code:status===500?'server_error':e.code||'bad_request',message:status===500?'서버 처리 중 오류가 발생했습니다.':safeError(e)}});}
  });
  server.requestTimeout=180000;server.headersTimeout=30000;
  return{server,db,settings,dataDir};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=await createMultiuserApp(),port=Number(process.env.MULTIUSER_PORT||8200),host=process.env.MULTIUSER_HOST||'127.0.0.1';
  app.server.listen(port,host,()=>console.log(`Pinmap multiuser API listening on ${host}:${port}`));
  for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>app.server.close(()=>{app.db.close();process.exit(0);}));
}

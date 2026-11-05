import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {AppError} from './errors.mjs';
export const hash=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
export function postCode(url){try{return new URL(url).pathname.match(/\/(?:p|reel|tv)\/([^/]+)/)?.[1]||null;}catch{return null;}}
const json=async(file,fallback)=>JSON.parse(await fs.readFile(file,'utf8').catch(()=>JSON.stringify(fallback)));
export async function resolveSourceRoot(appRoot,explicit=process.env.SOURCE_ROOT){
  if(explicit?.trim())return path.resolve(explicit.trim());
  const legacy=path.dirname(appRoot);
  try{await fs.access(path.join(legacy,'pinmap-items.json'));return legacy;}catch{}
  return path.join(appRoot,'fixtures','instagram-export');
}
export async function loadCatalog(sourceRoot,store){
  const original=await json(path.join(sourceRoot,'pinmap-items.json'),[]);
  const observations=await json(path.join(sourceRoot,'collector/results/latest.json'),[]);
  const byCode=new Map(observations.map(r=>[postCode(r.url),r]));
  const dir=path.join(sourceRoot,'collector/results/evidence'),captures=new Map();
  for(const name of await fs.readdir(dir).catch(()=>[])){
    if(!name.endsWith('.png'))continue;
    const code=name.replace(/_\d{4}-\d\d-\d\dT.*\.png$/,'.png').slice(0,-4),observation=byCode.get(code);
    if(!observation||observation.status!=='collected'||(observation.browser_status&&observation.browser_status!=='collected'))continue;
    const file=path.join(dir,name),snapshot=await json(file.replace(/\.png$/,'.json'),null);
    if(!snapshot||postCode(snapshot.canonical||snapshot.url)!==code)continue;
    const stat=await fs.stat(file),old=captures.get(code);
    if(!old||stat.mtimeMs>old.modified)captures.set(code,{id:'capture:'+code,kind:'page_capture',path:file,mime:'image/png',name,modified:stat.mtimeMs});
  }
  const posts=[];
  for(const item of original){
    const id=String(item.id);if(!/^[A-Za-z0-9_-]{1,100}$/.test(id))throw new Error('원본 게시물 ID가 올바르지 않습니다.');
    const code=postCode(item.url),uploaded=await store.uploads(id),capture=captures.get(code);
    posts.push({id,code,url:item.url,title:item.title||'',caption:typeof item.sourceCaption==='string'?item.sourceCaption:'',observed_format:byCode.get(code)?.fields?.media_format||'unknown',assets:uploaded.length?uploaded:capture?[capture]:[]});
  }
  return posts;
}
export async function snapshotInput(post,settings){
  const assets=[];
  for(const asset of post.assets){const buffer=await fs.readFile(asset.path);assets.push({...asset,sha256:hash(buffer),bytes:buffer.length});}
  if(!assets.length&&!post.caption.trim())throw new AppError('분석할 이미지·영상·캡션이 없습니다.',{code:'missing_input'});
  const material={caption:post.caption,assets};
  const fingerprint=hash(JSON.stringify({id:post.id,caption:post.caption,assets:assets.map(a=>({sha256:a.sha256,kind:a.kind,complete:a.complete||false})),model:settings.model,transcription_model:settings.transcriptionModel,max_images:settings.maxImages,max_video_seconds:settings.maxVideoSeconds,max_output_tokens:settings.maxOutputTokens,prompt_version:settings.promptVersion}));
  return {material,fingerprint};
}
export function catalogView(post){return{id:post.id,code:post.code,url:post.url,title:post.title,has_caption:!!post.caption.trim(),observed_format:post.observed_format,visual_ready:post.assets.some(a=>a.kind!=='audio'),assets:post.assets.map(a=>({id:a.id,kind:a.kind,name:a.name,bytes:a.bytes||null,complete:a.complete||false})),coverage:post.assets.some(a=>a.kind==='page_capture')?'partial_capture':post.assets.length?'uploaded_media':'caption_only'};}

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Store} from '../lib/store.mjs';
import {loadCatalog,resolveSourceRoot,hash} from '../lib/catalog.mjs';
import {openDatabase,now} from './db.mjs';
import {normalizeEmail} from './auth.mjs';
import {instagramUrl} from './import.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),root=path.dirname(here);
export async function migrateLegacy({db,dataDir,email,sourceRoot,legacyRoot=path.join(root,'.data-ollama')}){
  const user=db.prepare('SELECT id FROM users WHERE email=?').get(normalizeEmail(email));
  if(!user)throw new Error('먼저 새 서버 화면에서 이 이메일로 가입하세요.');
  sourceRoot=sourceRoot||await resolveSourceRoot(root);
  const originals=JSON.parse(await fs.readFile(path.join(sourceRoot,'pinmap-items.json'),'utf8'));
  const originalById=new Map(originals.map(x=>[String(x.id),x]));
  const store=new Store(legacyRoot);await store.init();
  const catalog=await loadCatalog(sourceRoot,store),postIds=new Map();
  const insert=db.prepare('INSERT OR IGNORE INTO posts(id,user_id,external_id,source_url,title,caption,export_timestamp,export_fbid,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
  let importedPosts=0,importedAssets=0,importedResults=0;
  for(const item of catalog){
    const raw=originalById.get(item.id)||{},source=instagramUrl(item.url),date=now();
    importedPosts+=insert.run(crypto.randomUUID(),user.id,source.externalId,source.url,item.title,item.caption,raw.exportTimestamp?new Date(raw.exportTimestamp*1000).toISOString():null,raw.exportFbid||null,date,date).changes;
    const post=db.prepare('SELECT id FROM posts WHERE user_id=? AND source_url=?').get(user.id,source.url);postIds.set(item.id,post.id);
    for(const asset of item.assets){
      const bytes=await fs.readFile(asset.path),sha256=hash(bytes);
      if(db.prepare('SELECT 1 FROM assets WHERE user_id=? AND post_id=? AND sha256=? AND kind=?').get(user.id,post.id,sha256,asset.kind))continue;
      const id=crypto.randomUUID(),folder=path.join(dataDir,'assets',user.id,post.id),file=path.join(folder,id+path.extname(asset.path));
      await fs.mkdir(folder,{recursive:true,mode:0o700});await fs.writeFile(file,bytes,{mode:0o600});
      try{db.prepare('INSERT INTO assets(id,user_id,post_id,kind,mime,path,name,bytes,sha256,complete,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,user.id,post.id,asset.kind,asset.mime,file,path.basename(asset.name||asset.path),bytes.length,sha256,asset.complete?1:0,now());importedAssets++;}catch(e){await fs.unlink(file).catch(()=>{});throw e;}
    }
  }
  for(const old of await store.jobs()){
    if(old.status!=='completed'||!old.result||!postIds.has(old.item_id))continue;
    const postId=postIds.get(old.item_id);
    if(db.prepare("SELECT 1 FROM jobs WHERE user_id=? AND post_id=? AND fingerprint=? AND status='completed'").get(user.id,postId,old.fingerprint))continue;
    const id=crypto.randomUUID(),date=now(),settings={providerName:old.provider?.name||'ollama',model:old.provider?.model||null,maxImages:old.limits?.maxImages||4,maxOutputTokens:old.limits?.maxOutputTokens||1400,maxVideoSeconds:old.limits?.maxVideoSeconds||600};
    db.prepare(`INSERT INTO jobs(id,user_id,post_id,fingerprint,status,source_url,material_json,settings_json,result_json,coverage_json,evidence_json,usage_json,created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,user.id,postId,old.fingerprint,'completed',old.source_url,JSON.stringify({caption:old.material?.caption||'',assets:[]}),JSON.stringify(settings),JSON.stringify(old.result),JSON.stringify(old.coverage),JSON.stringify(old.evidence||[]),JSON.stringify(old.usage||null),old.created_at||date,date,old.completed_at||date);
    importedResults++;
  }
  return{catalog_posts:catalog.length,imported_posts:importedPosts,imported_assets:importedAssets,imported_results:importedResults};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const email=process.argv[2];if(!email){console.error('Usage: npm run migrate:legacy -- user@example.com');process.exit(2);}
  const dataDir=path.resolve(process.env.MULTIUSER_DATA_DIR||'.multiuser-data'),db=openDatabase(path.join(dataDir,'pinmap.sqlite'));
  try{console.log(await migrateLegacy({db,dataDir,email}));}finally{db.close();}
}

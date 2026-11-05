import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {createApp} from '../server.mjs';
import {resolveSourceRoot} from '../lib/catalog.mjs';
const exec=promisify(execFile),root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),fixture=path.join(root,'fixtures','instagram-export');

test('bundled original export has the recorded checksum and converts reproducibly without AI',async()=>{
 const manifest=JSON.parse(await fs.readFile(path.join(fixture,'manifest.json'),'utf8'));
 const archive=await fs.readFile(path.join(fixture,manifest.archive));
 assert.equal(createHash('sha256').update(archive).digest('hex'),manifest.archive_sha256);
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-export-'));
 try{
  await exec('python3',[path.join(root,'scripts/import-instagram-export.py'),'--output',temp]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(temp,'pinmap-items.json'),'utf8')),JSON.parse(await fs.readFile(path.join(fixture,'pinmap-items.json'),'utf8')));
  assert.equal(manifest.post_count,349);assert.equal(manifest.caption_available,341);assert.equal(manifest.media_entries,0);assert.equal(manifest.ai_calls,0);
 }finally{await fs.rm(temp,{recursive:true,force:true});}
});

test('export data loads as a 349-post catalog without accessing Meta or OpenAI',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-fixture-app-'));let calls=0;
 try{
  const app=await createApp({sourceRoot:fixture,dataRoot:temp,initialSettings:{apiKey:''},fetchImpl:async()=>{calls++;throw new Error('network must not be called');}});
  const posts=app.getCatalog();assert.equal(posts.length,349);assert.equal(posts.filter(x=>x.caption.trim()).length,341);assert.ok(posts.every(x=>x.assets.length===0));assert.equal(calls,0);assert.equal(app.engine.list().length,0);
  assert.equal(await resolveSourceRoot(root,fixture),fixture);
  assert.equal(await resolveSourceRoot(path.join(temp,'standalone-app'),''),path.join(temp,'standalone-app','fixtures','instagram-export'));
 }finally{await fs.rm(temp,{recursive:true,force:true});}
});

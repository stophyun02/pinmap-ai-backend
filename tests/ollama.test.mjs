import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';

test('local Ollama analyzes actual image bytes without a key or external API',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-ollama-'));
  const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=','base64');
  const url='https://www.instagram.com/p/One/';
  let chats=0,app;
  try{
    const dir=path.join(root,'collector/results/evidence');await fs.mkdir(dir,{recursive:true});
    await fs.writeFile(path.join(root,'pinmap-items.json'),JSON.stringify([{id:'1',url,title:'test',sourceCaption:'source caption',memo:'DO_NOT_SEND_MEMO'}]));
    await fs.writeFile(path.join(root,'collector/results/latest.json'),JSON.stringify([{url,status:'collected',fields:{}}]));
    await fs.writeFile(path.join(dir,'One.png'),image);
    await fs.writeFile(path.join(dir,'One.json'),JSON.stringify({url,canonical:url}));
    app=await createApp({sourceRoot:root,dataRoot:path.join(root,'.data'),initialSettings:{providerName:'ollama',model:'qwen2.5vl:3b',apiKey:''},fetchImpl:async(endpoint,init)=>{
      assert.ok(endpoint.startsWith('http://127.0.0.1:11434/'));
      if(endpoint.endsWith('/api/tags'))return Response.json({models:[{name:'qwen2.5vl:3b'}]});
      assert.equal(endpoint,'http://127.0.0.1:11434/api/chat');chats++;
      const payload=JSON.parse(init.body);assert.equal(payload.model,'qwen2.5vl:3b');assert.equal(payload.stream,false);assert.equal(payload.messages[1].images[0],image.toString('base64'));assert.equal(payload.format.additionalProperties,false);assert.ok(!init.body.includes('DO_NOT_SEND_MEMO'));
      return Response.json({done:true,model:'qwen2.5vl:3b',message:{content:JSON.stringify({title:'test title',summary:'test summary',summary_evidence_ids:['caption'],topics:[],visible_text:[],facts:[],inferences:[],limitations:[]})},prompt_eval_count:12,eval_count:34});
    }});
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
    const base='http://127.0.0.1:'+app.server.address().port;
    const state=await(await fetch(base+'/api/state')).json();assert.equal(state.settings.provider,'ollama');assert.equal(state.settings.configured,true);
    const queued=await fetch(base+'/api/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({post_ids:['1'],limit:1})});assert.equal(queued.status,202);
    await app.engine.waitForIdle();
    const result=await(await fetch(base+'/api/results')).json();assert.equal(result.results.length,1);assert.equal(result.results[0].provider.name,'ollama');assert.equal(result.results[0].usage.summary.total_tokens,46);assert.equal(chats,1);
  }finally{if(app){app.engine.pause();await app.engine.waitForIdle();await new Promise(resolve=>app.server.close(resolve));}await fs.rm(root,{recursive:true,force:true});}
});

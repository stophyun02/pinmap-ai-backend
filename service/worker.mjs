import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareMedia} from '../lib/media.mjs';
import {OllamaClient} from '../lib/ollama-client.mjs';
import {AppError,safeError} from '../lib/errors.mjs';
import {openDatabase} from './db.mjs';
import {claimJob,markExpiredJobs,materialFromJob,updateJob} from './jobs.mjs';
import {VllmClient} from './vllm-client.mjs';
import {transcriberFromEnv} from './transcription.mjs';

export function providerFromEnv(settings,env=process.env){
  if(settings.providerName==='ollama')return new OllamaClient({settings,baseUrl:env.OLLAMA_BASE_URL||'http://127.0.0.1:11434'});
  if(settings.providerName==='vllm')return new VllmClient({baseUrl:env.VLLM_BASE_URL,model:settings.model,apiKey:env.VLLM_API_KEY});
  throw new Error('MULTIUSER_AI_PROVIDER must be ollama or vllm');
}
export async function processJob(db,job,{dataDir,provider,transcriber,prepare=prepareMedia,leaseMs=20*60*1000}={}){
  const settings=JSON.parse(job.settings_json),workerId=job.worker_id;
  const heartbeat=setInterval(()=>updateJob(db,job.id,workerId,{lease_until:Date.now()+leaseMs}),30000);heartbeat.unref();
  try{
    const prepared=await prepare(materialFromJob(job),path.join(dataDir,'work',job.user_id,job.id),settings);
    const mediaText={version:1,visual:[],audio:[]};
    updateJob(db,job.id,workerId,{coverage_json:JSON.stringify(prepared.coverage),evidence_json:JSON.stringify(prepared.evidence),media_text_json:JSON.stringify(mediaText)});
    if(prepared.images.length&&!provider.describeImage)throw new AppError('이미지를 텍스트로 변환하는 모델이 설정되지 않았습니다.',{code:'visual_text_unavailable'});
    for(const img of prepared.images){
      const observation=await provider.describeImage(img,{model:settings.model});
      mediaText.visual.push({evidence_id:img.id,kind:img.kind,time_seconds:img.time_seconds,scene:observation.scene,visible_text:observation.visible_text,objects:observation.objects,actions:observation.actions,uncertainties:observation.uncertainties,model:observation.model||settings.model});
      updateJob(db,job.id,workerId,{media_text_json:JSON.stringify(mediaText)});
    }
    const asr=prepared.audio.length?(transcriber===undefined?transcriberFromEnv():transcriber):null;
    if(prepared.audio.length&&!asr)throw new AppError('음성 전사 모델이 설정되지 않았습니다. ASR_PROVIDER를 설정하세요.',{code:'asr_not_configured'});
    for(const audio of prepared.audio){
      const transcript=await asr.transcribe(audio);
      mediaText.audio.push({evidence_id:audio.id,kind:'audio_transcript',text:transcript.text,segments:transcript.segments,language:transcript.language,model:transcript.model,duration_seconds:audio.duration_seconds});
      prepared.evidence.push({id:audio.id,kind:'audio_transcript',text:transcript.text,language:transcript.language,timing_precision:transcript.segments.length?'segment':'whole_audio'});
      updateJob(db,job.id,workerId,{media_text_json:JSON.stringify(mediaText),evidence_json:JSON.stringify(prepared.evidence)});
    }
    prepared.coverage.audio_status=prepared.audio.length?(mediaText.audio.some(a=>a.text)?'transcribed':'no_speech_detected'):'not_present';
    prepared.media_text=mediaText;
    prepared.images=[];
    updateJob(db,job.id,workerId,{status:'summarizing',coverage_json:JSON.stringify(prepared.coverage)});
    const result=await provider.summarize(prepared,{sourceUrl:job.source_url,model:settings.model,maxOutputTokens:settings.maxOutputTokens});
    if(prepared.coverage.partial)result.result.limitations.push('제공된 원본과 추출한 프레임 범위만 분석했습니다.');
    updateJob(db,job.id,workerId,{status:'completed',result_json:JSON.stringify(result.result),coverage_json:JSON.stringify(prepared.coverage),evidence_json:JSON.stringify(result.evidence),media_text_json:JSON.stringify(mediaText),usage_json:JSON.stringify(result.usage),completed_at:new Date().toISOString(),lease_until:null,worker_id:null});
  }catch(e){
    updateJob(db,job.id,workerId,{status:'failed',error_json:JSON.stringify({code:e.code||'processing_error',message:e instanceof AppError?safeError(e):'AI 작업 중 오류가 발생했습니다.'}),lease_until:null,worker_id:null});
  }finally{clearInterval(heartbeat);}
}
export async function runWorker({db,dataDir,providerFactory=providerFromEnv,concurrency=Number(process.env.WORKER_CONCURRENCY||1),pollMs=1000,signal}={}){
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>8)throw new Error('WORKER_CONCURRENCY must be 1-8');
  const workerId=crypto.randomUUID(),active=new Set();
  while(!signal?.aborted){
    markExpiredJobs(db);
    while(active.size<concurrency){
      const job=claimJob(db,workerId);if(!job)break;
      let provider;try{provider=providerFactory(JSON.parse(job.settings_json));}catch(e){updateJob(db,job.id,workerId,{status:'failed',error_json:JSON.stringify({code:'provider_config',message:'AI 서버 설정을 확인하세요.'}),lease_until:null,worker_id:null});continue;}
      const task=processJob(db,job,{dataDir,provider}).finally(()=>active.delete(task));active.add(task);
    }
    await new Promise(resolve=>setTimeout(resolve,pollMs));
  }
  await Promise.allSettled(active);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const dataDir=path.resolve(process.env.MULTIUSER_DATA_DIR||'.multiuser-data'),db=openDatabase(path.join(dataDir,'pinmap.sqlite'));
  const controller=new AbortController();for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>controller.abort());
  await runWorker({db,dataDir,signal:controller.signal});db.close();
}

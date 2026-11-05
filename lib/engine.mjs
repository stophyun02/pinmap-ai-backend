import path from 'node:path';
import crypto from 'node:crypto';
import {snapshotInput,catalogView} from './catalog.mjs';
import {prepareMedia} from './media.mjs';
import {PROMPT_VERSION} from './contract.mjs';
import {AppError,safeError} from './errors.mjs';
const active=new Set(['queued','preparing','transcribing','summarizing']);
export function publicJob(job){const {material,...out}=job;return out;}
export class AnalysisEngine {
  constructor({store,settings,provider,prepare=prepareMedia}){Object.assign(this,{store,settings,provider,prepare});this.jobs=new Map();this.paused=false;this.pauseReason=null;this.processing=false;this.current=null;this.controller=null;this.enqueueTail=Promise.resolve();}
  async init(){
    await this.store.init();
    for(const job of await this.store.jobs()){
      if(active.has(job.status)&&job.status!=='queued'){job.status='interrupted';job.error={code:'interrupted',message:'이전 실행이 중단됐습니다. AI 호출의 중복 과금을 피하려고 자동 재시도하지 않았습니다.'};await this.store.saveJob(job);}
      this.jobs.set(job.id,job);
    }
  }
  list(){return [...this.jobs.values()].sort((a,b)=>b.created_at.localeCompare(a.created_at)).map(publicJob);}
  state(){return{running:this.processing,paused:this.paused,pause_reason:this.pauseReason,current_job:this.current,queued:[...this.jobs.values()].filter(j=>j.status==='queued').length,completed:[...this.jobs.values()].filter(j=>j.status==='completed').length,failed:[...this.jobs.values()].filter(j=>['failed','interrupted'].includes(j.status)).length};}
  enqueue(posts,{force=false,requireVisual=true}={}){
    const task=this.enqueueTail.then(async()=>{
      if(!(this.settings.configured??!!this.settings.apiKey))throw new AppError(this.settings.providerName==='ollama'?'Ollama 서버와 이미지 모델을 먼저 준비하세요.':'먼저 OpenAI API 키를 로컬 화면에 적용하세요.',{code:'ai_not_configured',status:503});
      const out={jobs:[],skipped:[]};
      for(const post of posts){
        if(requireVisual&&!post.assets.some(a=>['image','page_capture','video'].includes(a.kind))){out.skipped.push({item_id:post.id,reason:'이미지·영상 입력이 없습니다.'});continue;}
        const {material,fingerprint}=await snapshotInput(post,{...this.settings,promptVersion:PROMPT_VERSION});
        const previous=[...this.jobs.values()].find(j=>j.item_id===post.id&&j.fingerprint===fingerprint&&(active.has(j.status)||j.status==='completed'));
        if(previous&&(!force||active.has(previous.status))){out.jobs.push({id:previous.id,item_id:post.id,status:previous.status,reused:true});continue;}
        const job={id:crypto.randomUUID(),item_id:post.id,source_url:post.url,fingerprint,created_at:new Date().toISOString(),status:'queued',material,limits:{maxImages:this.settings.maxImages,maxOutputTokens:this.settings.maxOutputTokens,maxVideoSeconds:this.settings.maxVideoSeconds},provider:{name:this.settings.providerName||'openai',model:this.settings.model,transcription_model:this.settings.providerName==='ollama'?null:this.settings.transcriptionModel,prompt_version:PROMPT_VERSION},coverage:null,evidence:[],transcriptions:[],usage:null,result:null,error:null};
        this.jobs.set(job.id,job);await this.store.saveJob(job);out.jobs.push({id:job.id,item_id:post.id,status:job.status,reused:false});
      }
      this.kick();return out;
    });
    this.enqueueTail=task.catch(()=>{});return task;
  }
  async stage(job,status){job.status=status;job.updated_at=new Date().toISOString();await this.store.saveJob(job);}
  kick(){if(this.processing||this.paused||!(this.settings.configured??!!this.settings.apiKey))return;this.processing=true;void this.drain().catch(()=>{this.paused=true;this.pauseReason='작업 기록 저장 중 오류가 발생했습니다.';}).finally(()=>{this.processing=false;this.current=null;});}
  async drain(){
    while(!this.paused){
      const job=[...this.jobs.values()].find(j=>j.status==='queued');if(!job)break;
      this.current=job.id;this.controller=new AbortController();const signal=this.controller.signal;
      try{
        await this.stage(job,'preparing');
        const prepared=await this.prepare(job.material,path.join(this.store.root,'work',job.id),job.limits||this.settings,signal);job.coverage=prepared.coverage;await this.store.saveJob(job);
        if(prepared.audio.length&&this.provider.supportsAudio===false){prepared.coverage.audio_status='not_transcribed_local_model';prepared.coverage.partial=true;}
        else if(prepared.audio.length){
          await this.stage(job,'transcribing');
          for(const audio of prepared.audio){const t=await this.provider.transcribe(audio,{signal,model:job.provider.transcription_model});const record={id:t.id,kind:'audio_transcript',text:t.text,name:t.name,time_range_seconds:t.time_range_seconds,timing_precision:t.timing_precision,request_id:t.request_id,usage:t.usage};job.transcriptions.push(record);prepared.evidence.push(record);await this.store.saveJob(job);}
          prepared.coverage.audio_status='transcribed';
        }
        await this.stage(job,'summarizing');
        const result=await this.provider.summarize(prepared,{sourceUrl:job.source_url,signal,model:job.provider.model,maxOutputTokens:job.limits?.maxOutputTokens});
        job.result=result.result;if(prepared.coverage.audio_status==='not_transcribed_local_model')job.result.limitations.push('영상·음성의 소리는 분석하지 않았습니다.');job.evidence=result.evidence;job.coverage=prepared.coverage;job.usage={summary:result.usage,transcriptions:job.transcriptions.map(t=>({evidence_id:t.id,usage:t.usage}))};job.provider={...job.provider,actual_model:result.model,response_id:result.response_id,request_id:result.request_id};job.completed_at=new Date().toISOString();
        await this.store.saveResult(job);await this.stage(job,'completed');
      }catch(error){
        job.error={code:error.code||'processing_error',message:safeError(error,this.settings.apiKey),request_id:error.requestId||null,retry_after_ms:error.retryAfterMs||null};
        await this.stage(job,signal.aborted||error.code==='cancelled'?'cancelled':'failed');
        if([401,403,429].includes(error.status)){this.paused=true;this.pauseReason=job.error.message;}
      }finally{this.controller=null;this.current=null;}
    }
  }
  pause(){this.paused=true;this.pauseReason='사용자가 대기열을 일시 정지했습니다.';}
  resume(){this.paused=false;this.pauseReason=null;this.kick();}
  async cancel(id){const job=this.jobs.get(id);if(!job)throw new AppError('작업을 찾지 못했습니다.',{status:404});if(this.current===id){this.controller?.abort();return;}if(job.status==='queued')await this.stage(job,'cancelled');}
  async waitForIdle(){while(this.processing)await new Promise(r=>setTimeout(r,10));}
}

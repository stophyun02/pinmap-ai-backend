import fs from 'node:fs/promises';
import {AppError} from './errors.mjs';
import {RESULT_SCHEMA,SYSTEM_PROMPT,VISUAL_TEXT_SCHEMA,VISUAL_TEXT_PROMPT,validateResult,validateVisualText} from './contract.mjs';

export class OllamaClient {
  constructor({settings,fetchImpl=fetch,baseUrl='http://127.0.0.1:11434'}={}){this.settings=settings;this.fetch=fetchImpl;this.baseUrl=baseUrl.replace(/\/$/,'');this.supportsAudio=false;}
  async available(model=this.settings.model){
    try{
      const response=await this.fetch(this.baseUrl+'/api/tags',{signal:AbortSignal.timeout(3000)});
      if(!response.ok)return false;
      const body=await response.json();return Array.isArray(body.models)&&body.models.some(x=>x.name===model||x.model===model);
    }catch{return false;}
  }
  async describeImage(img,{signal,model=this.settings.model}={}){
    const bytes=await fs.readFile(img.path);
    let response;
    try{response=await this.fetch(this.baseUrl+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,stream:false,keep_alive:'5m',format:VISUAL_TEXT_SCHEMA,options:{temperature:0,num_predict:700,num_ctx:4096},messages:[{role:'system',content:VISUAL_TEXT_PROMPT},{role:'user',content:JSON.stringify({evidence_id:img.id,kind:img.kind,time_seconds:img.time_seconds}),images:[bytes.toString('base64')]}]}),signal:AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(900000)])});}
    catch{throw new AppError('이미지 분석 서버와 연결이 끊겼습니다.',{code:'local_model_unavailable',status:503});}
    let body;try{body=await response.json();}catch{throw new AppError('이미지 분석 응답을 읽지 못했습니다.',{code:'invalid_provider_response',status:502});}
    if(!response.ok||body.error||body.done!==true)throw new AppError('이미지 분석 요청이 완료되지 않았습니다.',{code:'visual_provider_error',status:response.status||502});
    let value;try{value=JSON.parse(body.message?.content||'');}catch{throw new AppError('이미지 설명이 JSON이 아닙니다.',{code:'invalid_visual_text',status:502});}
    return{...validateVisualText(value),model:body.model||model,usage:{input_tokens:body.prompt_eval_count??null,output_tokens:body.eval_count??null}};
  }
  async summarize(prepared,{sourceUrl,signal,model=this.settings.model,maxOutputTokens=this.settings.maxOutputTokens}={}){
    if(!prepared.images.length&&!prepared.media_text?.visual?.length&&!prepared.media_text?.audio?.length&&!prepared.evidence.some(e=>e.kind==='caption'))throw new AppError('분석할 사진·프레임·캡션이 없습니다.',{code:'missing_input'});
    const evidence=prepared.evidence.map(e=>({...e}));
    const images=[];
    for(const img of prepared.images)images.push((await fs.readFile(img.path)).toString('base64'));
    const promptEvidence=evidence.map(e=>e.kind==='audio_transcript'&&prepared.media_text?.audio?.length?{...e,text:undefined}:e);
    const prompt=JSON.stringify({source_url:sourceUrl,coverage:prepared.coverage,evidence:promptEvidence,media_text:prepared.media_text,visual_input_order:prepared.images.map(x=>({evidence_id:x.id,kind:x.kind,time_seconds:x.time_seconds}))});
    let response;
    try{response=await this.fetch(this.baseUrl+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,stream:false,keep_alive:'5m',format:RESULT_SCHEMA,options:{temperature:0,num_predict:maxOutputTokens,num_ctx:16384},messages:[{role:'system',content:SYSTEM_PROMPT},{role:'user',content:prompt,images}]}),signal:AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(900000)])});}
    catch(e){if(signal?.aborted)throw new AppError('작업을 취소했습니다.',{code:'cancelled',status:409});throw new AppError('로컬 Ollama 연결이 끊겼습니다. 실행 상태를 확인하세요.',{code:'local_model_unavailable',status:503});}
    let body;try{body=await response.json();}catch{throw new AppError('Ollama 응답을 읽지 못했습니다.',{code:'invalid_provider_response',status:502});}
    if(!response.ok||body.error)throw new AppError(String(body.error||'Ollama 요청 실패').slice(0,500),{code:'ollama_error',status:response.status||502});
    if(body.done!==true)throw new AppError('Ollama 응답이 완료되지 않았습니다.',{code:'incomplete_response',status:502});
    let result;try{result=JSON.parse(body.message?.content||'');}catch{throw new AppError('Ollama 응답이 JSON이 아닙니다.',{code:'invalid_model_output',status:502});}
    validateResult(result,evidence);
    return{result,evidence,response_id:null,request_id:null,usage:{input_tokens:body.prompt_eval_count??null,output_tokens:body.eval_count??null,total_tokens:(body.prompt_eval_count!=null&&body.eval_count!=null)?body.prompt_eval_count+body.eval_count:null,total_duration_ns:body.total_duration??null},model:body.model||model};
  }
}

import fs from 'node:fs/promises';
import {AppError,safeError} from './errors.mjs';
import {RESULT_SCHEMA,SYSTEM_PROMPT,validateResult} from './contract.mjs';
export class OpenAIClient {
  constructor({settings,fetchImpl=fetch}={}){this.settings=settings;this.fetch=fetchImpl;}
  async request(endpoint,body,{multipart=false,signal}={}){
    const key=this.settings.apiKey;if(!key)throw new AppError('OpenAI API 키를 로컬 연결 화면에 입력하세요.',{code:'ai_not_configured',status:503});
    let response;
    try{response=await this.fetch('https://api.openai.com/v1/'+endpoint,{method:'POST',headers:{Authorization:`Bearer ${key}`,...(!multipart?{'Content-Type':'application/json'}:{})},body:multipart?body:JSON.stringify(body),redirect:'error',signal:AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(180000)])});}
    catch(e){if(signal?.aborted)throw new AppError('작업을 취소했습니다.',{code:'cancelled',status:409});throw new AppError('AI 서버 연결이 끊겼습니다. 중복 과금을 막기 위해 자동 재호출하지 않습니다.',{code:'ambiguous_network_failure',status:502});}
    const requestId=response.headers.get('x-request-id');let result;try{result=await response.json();}catch{throw new AppError('AI 서버에서 올바른 응답을 받지 못했습니다.',{code:'invalid_provider_response',status:502,requestId});}
    if(!response.ok||result.error){const code=result.error?.code||'provider_error';const message=safeError(new Error(result.error?.message||'AI 요청 실패'),key);const delay=response.headers.get('retry-after');const seconds=Number(delay);const retryAfterMs=delay?(Number.isFinite(seconds)?seconds*1000:Math.max(0,Date.parse(delay)-Date.now())):30000;throw new AppError(message,{code,status:response.status,retryable:response.status===429&&code!=='insufficient_quota',retryAfterMs,requestId});}
    return{body:result,requestId};
  }
  async transcribe(audio,{signal,model=this.settings.transcriptionModel}={}){
    const buffer=await fs.readFile(audio.path);if(buffer.length>24*1024*1024)throw new AppError('전사할 음성 파일이 너무 큽니다.',{code:'audio_too_large'});
    const data=new FormData();data.append('model',model);data.append('response_format','json');data.append('file',new Blob([buffer],{type:audio.mime}),'audio.mp3');
    const r=await this.request('audio/transcriptions',data,{multipart:true,signal});
    if(typeof r.body.text!=='string')throw new AppError('음성 전사 결과가 비어 있습니다.',{code:'invalid_transcript',status:502});
    return{...audio,kind:'audio_transcript',text:r.body.text,request_id:r.requestId,usage:r.body.usage||null,time_range_seconds:[0,audio.duration_seconds],timing_precision:'whole_audio'};
  }
  async summarize(prepared,{sourceUrl,signal,model=this.settings.model,maxOutputTokens=this.settings.maxOutputTokens}={}){
    const evidence=prepared.evidence.map(e=>({...e}));const content=[{type:'input_text',text:JSON.stringify({source_url:sourceUrl,coverage:prepared.coverage,evidence})}];
    for(const img of prepared.images){const b=await fs.readFile(img.path);content.push({type:'input_text',text:JSON.stringify({evidence_id:img.id,kind:img.kind,time_seconds:img.time_seconds})},{type:'input_image',image_url:`data:${img.mime};base64,${b.toString('base64')}`,detail:'high'});}
    const r=await this.request('responses',{model,store:false,max_output_tokens:maxOutputTokens,instructions:SYSTEM_PROMPT,input:[{role:'user',content}],text:{format:{type:'json_schema',name:'pinmap_post_summary',strict:true,schema:RESULT_SCHEMA}}},{signal});
    const body=r.body;if(body.status&&body.status!=='completed')throw new AppError('AI 응답이 끝까지 생성되지 않았습니다. 결과를 완료로 저장하지 않았습니다.',{code:'incomplete_response',status:502,requestId:r.requestId});
    const pieces=(body.output||[]).flatMap(o=>o.type==='message'?o.content||[]:[]);
    if(pieces.some(x=>x.type==='refusal'))throw new AppError('AI가 이 자료의 분석을 거절했습니다.',{code:'model_refusal',status:422,requestId:r.requestId});
    const text=pieces.filter(x=>x.type==='output_text').map(x=>x.text).join('');let result;
    try{result=JSON.parse(text);}catch{throw new AppError('AI 응답이 JSON이 아닙니다.',{code:'invalid_model_output',status:502,requestId:r.requestId});}
    validateResult(result,evidence);
    return{result,evidence,response_id:body.id||null,request_id:r.requestId,usage:body.usage||null,model:body.model||model};
  }
}

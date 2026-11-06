import fs from 'node:fs/promises';
import {AppError} from '../lib/errors.mjs';
import {RESULT_SCHEMA,SYSTEM_PROMPT,validateResult} from '../lib/contract.mjs';

export class VllmClient {
  constructor({baseUrl,model,apiKey,fetchImpl=fetch}){
    if(!baseUrl||!model)throw new Error('VLLM_BASE_URL and VLLM_MODEL are required');
    const url=new URL(baseUrl);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('Invalid VLLM_BASE_URL');
    const root=url.href.replace(/\/?$/,'/');
    this.endpoint=new URL('chat/completions',root+(url.pathname.replace(/\/$/,'').endsWith('/v1')?'':'v1/'));
    this.model=model;this.apiKey=apiKey;this.fetch=fetchImpl;this.supportsAudio=false;
  }
  async summarize(prepared,{sourceUrl,signal,model=this.model,maxOutputTokens=2400}={}){
    if(!prepared.images.length&&!prepared.evidence.some(e=>e.kind==='caption'))throw new AppError('분석할 자료가 없습니다.',{code:'missing_input'});
    const evidence=prepared.evidence.map(x=>({...x}));
    const content=[{type:'text',text:JSON.stringify({source_url:sourceUrl,coverage:prepared.coverage,evidence,visual_input_order:prepared.images.map(x=>({evidence_id:x.id,kind:x.kind,time_seconds:x.time_seconds}))})}];
    for(const img of prepared.images){const bytes=await fs.readFile(img.path);content.push({type:'text',text:`evidence_id=${img.id}`},{type:'image_url',image_url:{url:`data:${img.mime};base64,${bytes.toString('base64')}`}});}
    let response;
    try{response=await this.fetch(this.endpoint,{method:'POST',headers:{'Content-Type':'application/json',...(this.apiKey?{Authorization:`Bearer ${this.apiKey}`}:{})},body:JSON.stringify({model,messages:[{role:'system',content:SYSTEM_PROMPT},{role:'user',content}],temperature:0,max_tokens:maxOutputTokens,response_format:{type:'json_schema',json_schema:{name:'pinmap_post_summary',schema:RESULT_SCHEMA,strict:true}}}),signal:AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(900000)]),redirect:'error'});}
    catch(e){if(signal?.aborted)throw new AppError('작업을 취소했습니다.',{code:'cancelled',status:409});throw new AppError('AI 서버와 연결이 끊겼습니다. 중복 실행을 피하려고 자동 재호출하지 않습니다.',{code:'ambiguous_network_failure',status:502});}
    let body;try{body=await response.json();}catch{throw new AppError('AI 서버 응답을 읽지 못했습니다.',{code:'invalid_provider_response',status:502});}
    if(!response.ok||body.error)throw new AppError('AI 서버 요청이 실패했습니다.',{code:'provider_error',status:response.status||502});
    const choice=body.choices?.[0];if(choice?.finish_reason!=='stop')throw new AppError('AI 응답이 끝까지 생성되지 않았습니다.',{code:'incomplete_response',status:502});
    let result;try{result=JSON.parse(choice.message?.content||'');}catch{throw new AppError('AI 응답이 JSON이 아닙니다.',{code:'invalid_model_output',status:502});}
    validateResult(result,evidence);
    return{result,evidence,response_id:body.id||null,request_id:response.headers?.get?.('x-request-id')||null,usage:body.usage||null,model:body.model||model};
  }
}

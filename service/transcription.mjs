import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {AppError} from '../lib/errors.mjs';
import {runFfmpeg} from '../lib/media.mjs';

const exec=promisify(execFile);
export function normalizeTranscription(body){
  const segments=(body.segments||body.transcription||[]).map(s=>({
    start_seconds:Number.isFinite(s.start)?s.start:Number.isFinite(s.offsets?.from)?s.offsets.from/1000:null,
    end_seconds:Number.isFinite(s.end)?s.end:Number.isFinite(s.offsets?.to)?s.offsets.to/1000:null,
    text:String(s.text||'').trim()
  })).filter(s=>s.text);
  const text=String(body.text||segments.map(s=>s.text).join(' ')).trim();
  return{text,segments,language:body.language||body.result?.language||null};
}
export function transcriberFromEnv(env=process.env,fetchImpl=fetch){
  const kind=env.ASR_PROVIDER||'none';
  if(kind==='none')return null;
  if(kind==='whisper_cli'){
    if(!env.WHISPER_MODEL_PATH)throw new Error('WHISPER_MODEL_PATH is required');
    const model=path.resolve(env.WHISPER_MODEL_PATH),binary=env.WHISPER_CLI_PATH||'whisper-cli';
    return{async transcribe(audio){
      try{await fs.access(model);}catch{throw new AppError('Whisper 음성 모델 파일을 찾지 못했습니다.',{code:'asr_model_missing'});}
      const wav=audio.path+'.wav',prefix=audio.path+'.transcript';
      await runFfmpeg(['-y','-i',audio.path,'-ar','16000','-ac','1','-c:a','pcm_s16le',wav]);
      try{
        try{await exec(binary,['-m',model,'-f',wav,'-l','auto','-oj','-of',prefix],{timeout:30*60*1000,maxBuffer:1024*1024});}
        catch{throw new AppError('Whisper 음성 전사가 실패했습니다. 실행 파일과 모델을 확인하세요.',{code:'asr_failed'});}
        let body;try{body=JSON.parse(await fs.readFile(prefix+'.json','utf8'));}catch{throw new AppError('Whisper 전사 결과를 읽지 못했습니다.',{code:'invalid_asr_response'});}
        return{...normalizeTranscription(body),model:path.basename(model)};
      }finally{await fs.rm(wav,{force:true});await fs.rm(prefix+'.json',{force:true});}
    }};
  }
  if(kind==='vllm'){
    if(!env.ASR_BASE_URL||!env.ASR_MODEL)throw new Error('ASR_BASE_URL and ASR_MODEL are required');
    const url=new URL(env.ASR_BASE_URL);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('Invalid ASR_BASE_URL');
    const base=url.href.replace(/\/?$/,'/');const endpoint=new URL('audio/transcriptions',base+(url.pathname.replace(/\/$/,'').endsWith('/v1')?'':'v1/'));
    return{async transcribe(audio){
      const form=new FormData();form.append('model',env.ASR_MODEL);form.append('response_format','verbose_json');form.append('file',new Blob([await fs.readFile(audio.path)],{type:audio.mime}),path.basename(audio.path));
      let response;try{response=await fetchImpl(endpoint,{method:'POST',headers:env.ASR_API_KEY?{Authorization:`Bearer ${env.ASR_API_KEY}`}:{},body:form,redirect:'error',signal:AbortSignal.timeout(30*60*1000)});}catch{throw new AppError('음성 전사 서버와 연결이 끊겼습니다.',{code:'asr_unavailable',status:502});}
      if(!response.ok)throw new AppError('음성 전사 요청이 실패했습니다.',{code:'asr_error',status:response.status});
      let body;try{body=await response.json();}catch{throw new AppError('음성 전사 응답을 읽지 못했습니다.',{code:'invalid_asr_response',status:502});}
      return{...normalizeTranscription(body),model:env.ASR_MODEL};
    }};
  }
  throw new Error('ASR_PROVIDER must be none, whisper_cli, or vllm');
}

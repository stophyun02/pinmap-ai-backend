import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import bundledFfmpeg from 'ffmpeg-static';
import {AppError} from './errors.mjs';
import {hash} from './catalog.mjs';
const exec=promisify(execFile);
export const ffmpeg=process.env.FFMPEG_PATH||bundledFfmpeg;
const options=signal=>({signal,timeout:180000,maxBuffer:12*1024*1024});
export async function runFfmpeg(args,signal){return exec(ffmpeg,['-nostdin','-hide_banner','-protocol_whitelist','file,pipe',...args],options(signal));}
export function identifyMedia(buffer,name){
  const ext=path.extname(name).toLowerCase();
  if(buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return{kind:'image',mime:'image/png',extension:'.png'};
  if(buffer[0]===255&&buffer[1]===216&&buffer[2]===255)return{kind:'image',mime:'image/jpeg',extension:'.jpg'};
  if(buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP')return{kind:'image',mime:'image/webp',extension:'.webp'};
  if(['.mp4','.mov','.m4v','.webm'].includes(ext)&&((buffer.toString('ascii',4,8)==='ftyp')||buffer.subarray(0,4).equals(Buffer.from([26,69,223,163]))))return{kind:'video',mime:ext==='.webm'?'video/webm':'video/mp4',extension:ext};
  if(['.mp3','.wav','.m4a','.ogg'].includes(ext)&&((buffer.toString('ascii',0,3)==='ID3')||(buffer[0]===255&&(buffer[1]&224)===224)||buffer.toString('ascii',0,4)==='RIFF'||buffer.toString('ascii',4,8)==='ftyp'||buffer.toString('ascii',0,4)==='OggS'))return{kind:'audio',mime:ext==='.wav'?'audio/wav':ext==='.m4a'?'audio/mp4':ext==='.ogg'?'audio/ogg':'audio/mpeg',extension:ext};
  throw new AppError('지원하지 않는 파일입니다. PNG·JPG·WEBP 또는 MP4·MOV·WEBM·음성 파일을 사용하세요.',{code:'unsupported_media',status:415});
}
export async function saveUpload(store,itemId,file,{complete=false}={}){
  const buffer=Buffer.from(await file.arrayBuffer()),type=identifyMedia(buffer,file.name);
  const limit=type.kind==='image'?20*1024*1024:150*1024*1024;
  if(!buffer.length||buffer.length>limit)throw new AppError('이미지는 20MB, 영상은 150MB 이하로 입력하세요.',{code:'media_too_large',status:413});
  const id=crypto.randomUUID(),dir=path.join(store.root,'assets',itemId),filePath=path.join(dir,id+type.extension);
  await fs.mkdir(dir,{recursive:true,mode:0o700});await fs.writeFile(filePath,buffer,{mode:0o600});
  return{id,kind:type.kind,mime:type.mime,path:filePath,name:path.basename(file.name).slice(0,180),bytes:buffer.length,sha256:hash(buffer),complete:!!complete};
}
export async function probeMedia(file,signal){
  let stderr='';try{stderr=(await runFfmpeg(['-i',file],signal)).stderr;}catch(e){if(signal?.aborted)throw e;stderr=e.stderr||'';}
  const m=stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration=m?Number(m[1])*3600+Number(m[2])*60+Number(m[3]):null;
  if(!duration||!Number.isFinite(duration))throw new AppError('미디어 재생 길이를 확인하지 못했습니다.',{code:'invalid_media'});
  return{duration_seconds:duration,has_video:/Video:/.test(stderr),has_audio:/Audio:/.test(stderr)};
}
export async function prepareMedia(material,workDir,settings,signal){
  await fs.mkdir(workDir,{recursive:true,mode:0o700});
  const evidence=[],images=[],audio=[],coverage={kind:'caption_only',partial:true,images_supplied:0,images_analyzed:0,video_files:[],audio_status:'not_supplied',omitted_assets:[]};
  if(material.caption.trim())evidence.push({id:'caption',kind:'caption',text:material.caption.slice(0,40000),truncated:material.caption.length>40000});
  for(const asset of material.assets){const b=await fs.readFile(asset.path);if(hash(b)!==asset.sha256)throw new AppError('입력 파일이 작업 등록 후 변경됐습니다. 다시 등록하세요.',{code:'input_changed'});}
  const direct=material.assets.filter(a=>a.kind==='image'||a.kind==='page_capture');
  const videos=material.assets.filter(a=>a.kind==='video'),audioFiles=material.assets.filter(a=>a.kind==='audio');
  coverage.images_supplied=direct.length;
  for(const asset of direct){
    if(images.length>=settings.maxImages){coverage.omitted_assets.push(asset.id);continue;}
    const b=await fs.readFile(asset.path);if(b.length>20*1024*1024)throw new AppError('이미지 입력 크기를 초과했습니다.',{code:'media_too_large'});
    const descriptor={id:asset.id,kind:asset.kind,name:asset.name,time_seconds:null};evidence.push(descriptor);
    images.push({...descriptor,mime:asset.mime,path:asset.path});
  }
  let totalDuration=0;
  for(let i=0;i<videos.length;i++){
    const asset=videos[i],info=await probeMedia(asset.path,signal);totalDuration+=info.duration_seconds;
    if(totalDuration>settings.maxVideoSeconds)throw new AppError(`게시물당 영상 길이는 총 ${settings.maxVideoSeconds}초까지 처리합니다.`,{code:'video_duration_limit'});
    if(!info.has_video)throw new AppError('영상 트랙이 없는 파일입니다.',{code:'invalid_media'});
    const maxFrames=Math.min(24,Math.floor((settings.maxImages-images.length)/(videos.length-i)));
    if(maxFrames<1){coverage.omitted_assets.push(asset.id);continue;}
    const interval=Math.max(.25,info.duration_seconds/Math.max(1,maxFrames-1));
    const frameDir=path.join(workDir,asset.id);await fs.mkdir(frameDir,{recursive:true});
    const filter=`select='isnan(prev_selected_t)+gte(t-prev_selected_t,${interval})',scale=1280:1280:force_original_aspect_ratio=decrease,showinfo`;
    const rendered=await runFfmpeg(['-i',asset.path,'-an','-vf',filter,'-fps_mode','vfr','-frames:v',String(maxFrames),'-q:v','3',path.join(frameDir,'frame-%04d.jpg')],signal);
    const times=[...rendered.stderr.matchAll(/\bpts_time:([\d.]+)/g)].map(m=>Number(m[1]));
    const files=(await fs.readdir(frameDir)).filter(f=>f.endsWith('.jpg')).sort();
    if(!files.length)throw new AppError('영상에서 분석할 프레임을 추출하지 못했습니다.',{code:'no_video_frames'});
    const frameTimes=[];
    for(let n=0;n<files.length;n++){
      if(!Number.isFinite(times[n]))throw new AppError('영상 프레임의 실제 시각을 확인하지 못했습니다.',{code:'missing_frame_time'});
      const descriptor={id:`${asset.id}:frame:${n+1}`,kind:'video_frame',name:asset.name,time_seconds:times[n]};evidence.push(descriptor);frameTimes.push(times[n]);images.push({...descriptor,mime:'image/jpeg',path:path.join(frameDir,files[n])});
    }
    coverage.video_files.push({asset_id:asset.id,duration_seconds:info.duration_seconds,frame_times_seconds:frameTimes,visual_sampling:true,has_audio:info.has_audio});
    if(info.has_audio){const file=path.join(frameDir,'audio.mp3');await runFfmpeg(['-i',asset.path,'-vn','-ac','1','-ar','16000','-c:a','libmp3lame','-b:a','64k','-map_metadata','-1',file],signal);audio.push({id:asset.id+':audio',path:file,mime:'audio/mpeg',name:asset.name,duration_seconds:info.duration_seconds});}
  }
  for(const asset of audioFiles){const info=await probeMedia(asset.path,signal);totalDuration+=info.duration_seconds;if(totalDuration>settings.maxVideoSeconds)throw new AppError('전체 음성·영상 길이 제한을 초과했습니다.',{code:'video_duration_limit'});if(!info.has_audio)throw new AppError('음성 트랙을 확인하지 못했습니다.',{code:'invalid_media'});const file=path.join(workDir,asset.id+'.mp3');await runFfmpeg(['-i',asset.path,'-vn','-ac','1','-ar','16000','-c:a','libmp3lame','-b:a','64k',file],signal);audio.push({...asset,path:file,mime:'audio/mpeg',duration_seconds:info.duration_seconds});}
  coverage.images_analyzed=images.length;
  coverage.kind=videos.length?'sampled_video':direct.some(a=>a.kind==='page_capture')?'partial_page_capture':images.length?'uploaded_images':audio.length?'audio':'caption_only';
  coverage.partial=coverage.kind==='caption_only'||!!videos.length||direct.some(a=>a.kind==='page_capture')||!!coverage.omitted_assets.length||!material.assets.every(a=>a.complete);
  coverage.audio_status=audio.length?'pending_transcription':'not_present';
  return{evidence,images,audio,coverage};
}

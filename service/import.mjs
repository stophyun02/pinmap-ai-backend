import yauzl from 'yauzl';
import {AppError} from '../lib/errors.mjs';

const ENTRY='your_instagram_activity/saved/saved_posts.json';
function repair(value){if(typeof value!=='string')return '';const decoded=Buffer.from(value,'latin1').toString('utf8');return Buffer.from(decoded,'utf8').toString('latin1')===value?decoded:value;}
export function instagramUrl(value){
  if(typeof value!=='string')throw new AppError('Instagram 게시물 URL이 필요합니다.',{status:400});
  let url;try{url=new URL(value);}catch{throw new AppError('Instagram 게시물 URL이 올바르지 않습니다.',{status:400});}
  const match=url.pathname.match(/^\/(p|reel|tv)\/([A-Za-z0-9_-]+)\/?$/);
  if(url.protocol!=='https:'||!['instagram.com','www.instagram.com'].includes(url.hostname)||!match)throw new AppError('Instagram 게시물 링크만 등록할 수 있습니다.',{status:400});
  return{url:`https://www.instagram.com/${match[1]}/${match[2]}/`,externalId:'ig_'+match[2]};
}
export async function parseInstagramZip(buffer){
  if(!Buffer.isBuffer(buffer)||buffer.length>40*1024*1024)throw new AppError('ZIP은 40MB 이하로 입력하세요.',{status:413});
  const records=await new Promise((resolve,reject)=>{
    yauzl.fromBuffer(buffer,{lazyEntries:true,validateEntrySizes:true},(error,zip)=>{
      if(error)return reject(new AppError('ZIP을 읽을 수 없습니다.',{status:400}));
      let found=false,finished=false;
      const fail=e=>{if(finished)return;finished=true;zip.close();reject(e instanceof AppError?e:new AppError('ZIP 안의 게시물 목록을 읽을 수 없습니다.',{status:400}));};
      zip.on('error',fail);
      zip.on('entry',entry=>{
        if(entry.fileName!==ENTRY){zip.readEntry();return;}
        if(found)return fail(new AppError('ZIP에 게시물 목록이 중복되어 있습니다.',{status:400}));
        found=true;if(entry.uncompressedSize>32*1024*1024)return fail(new AppError('게시물 목록이 너무 큽니다.',{status:413}));
        zip.openReadStream(entry,(err,stream)=>{
          if(err)return fail(err);
          const chunks=[];let size=0;
          stream.on('data',part=>{size+=part.length;if(size>32*1024*1024){stream.destroy(new Error('too large'));return;}chunks.push(part);});
          stream.on('error',fail);
          stream.on('end',()=>{if(finished)return;try{const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!Array.isArray(data))throw Error('not an array');finished=true;zip.close();resolve(data);}catch{fail(new AppError('게시물 JSON 형식이 올바르지 않습니다.',{status:400}));}});
        });
      });
      zip.on('end',()=>{if(!found)fail(new AppError('ZIP에 saved_posts.json이 없습니다.',{status:400}));});
      zip.readEntry();
    });
  });
  if(records.length>10000)throw new AppError('한 번에 가져올 게시물은 1만 건 이하로 제한합니다.',{status:413});
  const posts=[],seen=new Set();
  for(const record of records){
    if(!record||typeof record!=='object')continue;
    const fields=new Map();for(const item of record.label_values||[]){const label=repair(item?.label);if(label)fields.set(label,[...(fields.get(label)||[]),item]);}
    const source=(fields.get('URL')||[]).map(x=>x.href||x.value).find(Boolean);if(!source)continue;
    const {url,externalId}=instagramUrl(source);if(seen.has(url))continue;seen.add(url);
    const caption=(fields.get('캡션')||[]).map(x=>repair(x.value)).filter(Boolean).join('\n\n').slice(0,100000);
    const title=(fields.get('제목')||[]).map(x=>repair(x.value)).find(Boolean)||caption.trim().split('\n')[0].slice(0,100)||'Instagram 저장 게시물';
    posts.push({externalId,url,title:title.slice(0,300),caption,exportTimestamp:Number.isInteger(record.timestamp)?new Date(record.timestamp*1000).toISOString():null,exportFbid:record.fbid==null?null:String(record.fbid)});
  }
  return posts;
}

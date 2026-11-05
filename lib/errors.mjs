export class AppError extends Error {
  constructor(message,{code='bad_request',status=400,retryable=false,retryAfterMs=0,requestId=null}={}){
    super(message);Object.assign(this,{code,status,retryable,retryAfterMs,requestId});
  }
}
export function safeError(error,key=''){
  let message=String(error?.message||'처리 중 오류가 발생했습니다.');
  if(key)message=message.replaceAll(key,'[인증키]');
  return message.replace(/sk-[A-Za-z0-9_-]{8,}/g,'[인증키]').slice(0,500);
}

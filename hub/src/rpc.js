import { isTaskRequest } from '../../extension/protocol.js';

// Shared by the Node hub and the Worker. No browser task may outlive a lost
// synchronous RPC merely because its HTTP caller did not use our SDK.
export function sendRpc(socket, pending, request, {signal, timeoutMs=30000}={}) {
  const path=new URL(request.path,'http://relay.local');
  const tracked=isTaskRequest(request.method,path.pathname);
  const taskId=tracked ? (request.method==='GET'?path.searchParams.get('taskId'):request.body?.taskId) || `job_${crypto.randomUUID()}` : undefined;
  const sessionId=request.method==='GET'?path.searchParams.get('sessionId'):request.body?.sessionId;
  const body=tracked && request.method!=='GET'?{...request.body,taskId}:request.body;
  if(tracked && request.method==='GET')path.searchParams.set('taskId',taskId);
  const id=request.id || `rpc_${crypto.randomUUID()}`;
  const frame={type:'rpc.request',id,method:request.method,path:path.pathname+path.search,headers:request.headers||{},body:body??null};
  return new Promise((resolve,reject)=>{
    let timer, sent=false, settled=false;
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);pending.delete(id);};
    const finish=(fn,value)=>{if(settled)return;settled=true;cleanup();fn(value);};
    const fail=(code,message,status)=>{
      if(settled)return;
      const payload={ok:false,code,message,error:message,status,retryable:!tracked && code!=='request_cancelled'};
      if(tracked) {
        Object.assign(payload,{taskId,sessionId,cancellationRequested:false});
        if(sent) {
          try {
            socket.send(JSON.stringify({type:'rpc.request',id:`cancel_${crypto.randomUUID()}`,method:'POST',path:`/api/tasks/${encodeURIComponent(taskId)}/cancel`,headers:{},body:{sessionId}}));
            payload.cancellationRequested=true;
          } catch {payload.cancellationError='remote_send_failed';}
        }
      }
      finish(reject,payload);
    };
    const abort=()=>fail('request_cancelled','Remote request cancelled; completed actions were not undone',409);
    if(pending.has(id)) {reject({ok:false,code:'duplicate_rpc',message:'RPC id is already pending',status:409,retryable:false});return;}
    if(signal?.aborted) {abort();return;}
    pending.set(id,{resolve:value=>finish(resolve,value),reject:value=>finish(reject,tracked?{...value,taskId,sessionId,retryable:false}:value)});
    signal?.addEventListener('abort',abort,{once:true});
    timer=setTimeout(()=>fail('remote_request_timeout','Remote device did not respond before timeout',504),timeoutMs);
    try {socket.send(JSON.stringify(frame));sent=true;}
    catch(error) {fail('remote_send_failed',error.message || String(error),502);}
  });
}

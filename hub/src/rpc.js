// Hub correlation is opaque: task identity, deadlines and cancellation belong to endpoints.
export function sendRpc(socket, pending, request, { signal, timeoutMs = 30000 } = {}) {
  const id = request.id;
  return new Promise((resolve, reject) => {
    let timer, settled = false;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); pending.delete(id); };
    const finish = (fn, value) => { if (settled) return; settled = true; cleanup(); fn(value); };
    const fail = (code, message, status) => finish(reject, { ok: false, code, message, status, retryable: false });
    const abort = () => fail('request_cancelled', 'Relay request cancelled; remote outcome may be unknown', 409);
    if (pending.has(id)) { reject({ ok: false, code: 'duplicate_rpc', message: 'RPC id is already pending', status: 409, retryable: false }); return; }
    if (pending.size >= 32) { reject({ ok: false, code: 'remote_device_busy', message: 'Remote device pending limit reached', status: 429, retryable: true }); return; }
    if (signal?.aborted) { abort(); return; }
    pending.set(id, { resolve: value => finish(resolve, value), reject: value => finish(reject, value) });
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => fail('remote_request_timeout', 'Remote device did not respond before timeout', 504), timeoutMs);
    try { socket.send(JSON.stringify({ type: 'rpc.request', id, payload: request.payload })); }
    catch { fail('remote_send_failed', 'Unable to send to remote device', 502); }
  });
}

export function pingSocket(socket, pending, {signal, timeoutMs=2000}={}) {
  const id=`ping_${crypto.randomUUID()}`;
  return new Promise((resolve,reject)=>{
    let timer, settled=false;
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);pending.delete(id);};
    const finish=(fn,value)=>{if(settled)return;settled=true;cleanup();fn(value);};
    const fail=(code,message,status)=>finish(reject,{ok:false,code,message,error:message,status,retryable:true});
    const abort=()=>fail('request_cancelled','Remote request cancelled; completed actions were not undone',409);
    if(pending.has(id)) {reject({ok:false,code:'duplicate_rpc',message:'RPC id is already pending',status:409,retryable:false});return;}
    if(pending.size >= 32) {reject({ok:false,code:'remote_device_busy',message:'Remote device pending limit reached',status:429,retryable:true});return;}
    if(signal?.aborted) {abort();return;}
    if(!socket || socket.readyState !== 1) {fail('remote_device_offline','Remote Browser Relay device is offline',409);return;}
    pending.set(id,{resolve:value=>finish(resolve,value),reject:value=>finish(reject,value)});
    signal?.addEventListener('abort',abort,{once:true});
    timer=setTimeout(()=>fail('remote_request_timeout','Remote device did not respond to ping',504),timeoutMs);
    try {socket.send(JSON.stringify({type:'device.ping',id}));}
    catch(error) {fail('remote_send_failed',error.message || String(error),502);}
  });
}

import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {stat,open,unlink,rename} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';

export async function digestFile(path){const h=createHash('sha256');for await(const b of createReadStream(path,{highWaterMark:65536}))h.update(b);return h.digest('hex');}
async function writeAll(handle,buffer){let offset=0;while(offset<buffer.length){const {bytesWritten}=await handle.write(buffer,offset,buffer.length-offset);if(!bytesWritten)throw new Error('Update write disk failed');offset+=bytesWritten;}}
export async function downloadArtifact({file,target,fetchImpl=fetch,onProgress=()=>{}}){
 const began=performance.now(),draft=target+'.part';let ttfb=null,retries=0,transferred=0;
 if((await stat(target).catch(()=>null))?.size===file.bytes&&await digestFile(target)===file.sha256)return {cacheHit:true,transferred:0,totalMs:performance.now()-began};
 let last;
 for(let attempt=0;attempt<3;attempt++){
  let offset=(await stat(draft).catch(()=>null))?.size||0;
  if(offset>file.bytes){await unlink(draft);offset=0;}
  if(offset===file.bytes){if(await digestFile(draft)!==file.sha256){await unlink(draft);throw new Error('Download package verification failed, not installed');}await unlink(target).catch(e=>{if(e.code!=='ENOENT')throw e;});await rename(draft,target);return {cacheHit:true,resumedComplete:true,transferred,totalMs:performance.now()-began};}
  const controller=new AbortController();let timer=setTimeout(()=>controller.abort(),20000),handle;
  const reset=()=>{clearTimeout(timer);timer=setTimeout(()=>controller.abort(),20000);};
  try{
   const response=await fetchImpl(file.url,{signal:controller.signal,redirect:'error',headers:{'Accept-Encoding':'identity',...(offset?{Range:`bytes=${offset}-`}:{})}});reset();
   if(offset&&response.status===206){if(response.headers.get('content-range')!==`bytes ${offset}-${file.bytes-1}/${file.bytes}`)throw new Error('Breakpoint resume range is incorrect');}
   else if(response.status===200)offset=0;else throw new Error(`Download service returned ${response.status}`);
   const advertised=response.headers.get('content-length');if(advertised!==null&&Number(advertised)!==file.bytes-offset)throw new Error('Download length does not match signature list');
   const hash=createHash('sha256');if(offset)for await(const b of createReadStream(draft,{highWaterMark:65536}))hash.update(b);
   handle=await open(draft,offset?'a':'w');let lastUi=0;
   for await(const chunk of response.body){reset();if(ttfb===null)ttfb=performance.now()-began;const buffer=Buffer.from(chunk);if(offset+buffer.length>file.bytes)throw new Error('Downloaded file exceeds declared size');
    for(let p=0;p<buffer.length;p+=65536){const part=buffer.subarray(p,p+65536);await writeAll(handle,part);hash.update(part);offset+=part.length;transferred+=part.length;}
    if(performance.now()-lastUi>=200){onProgress(offset);lastUi=performance.now();}
   }
   if(offset!==file.bytes)throw new Error('Download not fully completed');await handle.sync();await handle.close();handle=null;
   if(hash.digest('hex')!==file.sha256){await unlink(draft);throw new Error('Download package verification failed, not installed');}
   await unlink(target).catch(e=>{if(e.code!=='ENOENT')throw e;});await rename(draft,target);onProgress(file.bytes);
   return {cacheHit:false,transferred,ttfbMs:ttfb,retries,totalMs:performance.now()-began};
  }catch(error){last=error;retries++;if(/Verification failed/.test(error.message))throw error;}
  finally{controller.abort();clearTimeout(timer);await handle?.close();}
 }
 throw last;
}

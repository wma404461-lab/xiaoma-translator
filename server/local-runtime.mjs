import {spawn} from 'node:child_process';
import {readdir} from 'node:fs/promises';
import {existsSync,createWriteStream} from 'node:fs';
import {resolve} from 'node:path';
import {cacheRoot} from './local-asr.mjs';
import {modelToken} from './model-auth.mjs';
import {createModelSupervisor} from './model-supervisor.mjs';

// Own only the model process started by this app; never stop an existing service.
export async function startLocalRuntime(){
  const health=async()=>{try{const response=await fetch('http://127.0.0.1:4318/health',{signal:AbortSignal.timeout(1500)});const ok=response.ok;await response.body?.cancel();return ok;}catch{return false;}};
  if(await health())return {close(){}};
  const directory=resolve(cacheRoot,'llama-b11382'),model=process.env.FLOWSUB_TRANSLATION_MODEL||resolve(cacheRoot,'Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf');
  const candidates=existsSync(directory)?await readdir(directory,{recursive:true}):[];
  const executable=candidates.find(name=>name.endsWith('llama-server.exe'));
  if(!executable || !existsSync(model))throw new Error('请先运行 setup-local.ps1，完成本地模型安装。');
  const children=new Set();
  const log=createWriteStream(resolve(cacheRoot,'translation-runtime.log'),{flags:'a'});
  const managed=createModelSupervisor({health,spawnWorker:()=>{
    // Boundary and translation retain separate live prefixes in two 2048-token
    // slots. Disable the extra RAM prompt archive (default limit: 8 GiB).
    const child=spawn(resolve(directory,executable),['-m',model,'--host','127.0.0.1','--port','4318','--api-key',modelToken,'--no-webui','--alias','flowsub-qwen','-ngl',process.env.FLOWSUB_GPU_LAYERS||'99','-c','4096','--parallel','2','--no-kv-unified','--cache-ram','0','--jinja','--reasoning-budget','0'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    children.add(child);
    child.on('close',()=>children.delete(child));
    child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
    return child;
  },onEvent:event=>{
    if(event.type==='recovering')console.log('翻译引擎中断或无响应，正在自动恢复。');
    if(event.type==='fatal')console.error('翻译引擎连续失败，请重新运行 start.ps1。');
  }});
  const close=()=>{for(const child of children){child.stdout.unpipe(log);child.stderr.unpipe(log);}managed.close();log.end();};
  let deadline;
  try{
    await Promise.race([managed.ready,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('翻译模型加载超时，请查看本机缓存中的 translation-runtime.log。')),90000);})]);
    return {close,refresh:async()=>{if(managed.isReady()&&await health())return;await managed.restart();},observeInference:({endpoint,signal})=>endpoint==='http://127.0.0.1:4318/v1/chat/completions'?managed.observeInference({signal}):undefined};
  }catch(error){close();throw error;}
  finally{clearTimeout(deadline);}
}

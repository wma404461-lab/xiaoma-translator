import {downloadArtifact} from './update-download.mjs';
import {createHash,verify} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,mkdir,stat,open,rename,unlink,copyFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {homedir} from 'node:os';
const defaultRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const RELEASE_BASE='https://154.9.26.140:8443/tools/flowsub/';
export function newerVersion(next,current){const parse=v=>{if(!/^\d+\.\d+\.\d+$/.test(v))throw new Error('Incorrect version number');return v.split('.').map(Number);};const a=parse(next),b=parse(current);for(let i=0;i<3;i++){if(a[i]!==b[i])return a[i]>b[i];}return false;}
export function validateArtifact(file){
  if(!file||!/[a-z0-9]/i.test(file.name||'')||!/^[A-Za-z0-9._-]+$/.test(file.name)||file.name.includes('..')||!Number.isSafeInteger(file.bytes)||file.bytes<1||file.bytes>536870912||!/^[a-f0-9]{64}$/.test(file.sha256||''))throw new Error('Incorrect update file information');
  if(file.url!==RELEASE_BASE+'files/'+file.name||!file.name.endsWith('.zip'))throw new Error('Incorrect update package source or type');
  return file;
}
export function verifyRelease(envelope,publicKey,{now=Date.now()}={}){
  const bytes=Buffer.isBuffer(envelope)?envelope:Buffer.from(envelope);
  if(bytes.length>65536)throw new Error('Version information is too large');
  const outer=JSON.parse(bytes.toString('utf8')),payload=Buffer.from(outer.payload||'','base64');
  if(!verify('RSA-SHA256',payload,publicKey,Buffer.from(outer.signature||'','base64')))throw new Error('Update signature verification failed');
  const data=JSON.parse(payload.toString('utf8'));
  if(data.schema!==1||data.app!=='FlowSub'||!Number.isSafeInteger(data.expiresAt)||data.expiresAt<now||data.expiresAt>now+180*86400000)throw new Error('Version information is expired or incorrectly formatted');
  newerVersion(data.version,'0.0.0');validateArtifact(data.windows);
  if(data.windowsContent){validateArtifact(data.windowsContent);const inherited=data.windowsContent.inherit;if(!Array.isArray(inherited)||inherited.length<1||inherited.length>2||new Set(inherited.map(x=>x.path)).size!==inherited.length||inherited.some(x=>!['runtime/node.exe','assets/fonts/NotoSansSC.ttf'].includes(x.path)||!Number.isSafeInteger(x.bytes)||x.bytes<1||!/^[a-f0-9]{64}$/.test(x.sha256||'')))throw new Error('Incorrect runtime inheritance information');}
  return data;
}
async function hashFile(path){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
export function createReleaseUpdater({root=defaultRoot,version,cache=resolve(homedir(),'.cache','flowsub','updates'),fetchImpl=fetch,publicKey,launch=spawn,onApply=()=>{}}={}){
  let state={state:'idle',currentVersion:version,progress:0},release,staged,job,selected;
  const status=()=>({...state});
  const key=()=>publicKey?Promise.resolve(publicKey):readFile(resolve(root,'assets','update-public.pem'));
  const check=async()=>{
    if(job)throw new Error('Update task is in progress');state={state:'checking',currentVersion:version,progress:0};
    try{
      const response=await fetchImpl(RELEASE_BASE+'update.json',{signal:AbortSignal.timeout(15000),redirect:'error',headers:{'Cache-Control':'no-cache'}});
      if(!response.ok)throw new Error(`Update service returned ${response.status}`);
      const chunks=[];let length=0;for await(const chunk of response.body){length+=chunk.length;if(length>65536)throw new Error('Version information is too large');chunks.push(Buffer.from(chunk));}
      release=verifyRelease(Buffer.concat(chunks),await key());staged=null;selected=release.windows;
      if(release.windowsContent){let matched=true;for(const inherited of release.windowsContent.inherit){const local=resolve(root,inherited.path);if((await stat(local).catch(()=>null))?.size!==inherited.bytes||await hashFile(local)!==inherited.sha256){matched=false;break;}}if(matched)selected=release.windowsContent;}
      state={state:newerVersion(release.version,version)?'available':'current',currentVersion:version,version:release.version,notes:String(release.notes||'').slice(0,2000),bytes:selected.bytes,packageKind:selected===release.windows?'full':'content',progress:0};return status();
    }catch(error){state={state:'error',currentVersion:version,message:error.message,progress:0};throw error;}
  };
  const download=()=>{
    if(job)return status();if(!release||!newerVersion(release.version,version))throw new Error('Please check the new version first');
    state={...state,state:'downloading',progress:0};
    job=(async()=>{
      await mkdir(cache,{recursive:true});const file=validateArtifact(selected),target=resolve(cache,file.name),draft=target+'.part';
      try{
        const timing=await downloadArtifact({file,target,fetchImpl,onProgress:received=>{state={...state,progress:Math.round(received*100/file.bytes),received};}});
        state={...state,downloadTiming:timing};
        staged=target;state={...state,state:'ready',progress:100};
      }catch(error){state={...state,state:'error',message:error.message};}finally{job=null;}
    })();return status();
  };
  const apply=async()=>{
    if(state.state!=='ready'||!staged||!release)throw new Error('Update package not yet verified');
    if(await hashFile(staged)!==selected.sha256)throw new Error('Update package has changed, please redownload');
    const python=process.env.FLOWSUB_PYTHON||resolve(homedir(),'.cache','flowsub','venv','Scripts','python.exe');
    const installer=resolve(cache,'install-update.py');await copyFile(resolve(root,'desktop','install-update.py'),installer);
    const child=launch(python,[installer,'--root',root,'--archive',staged,'--sha256',selected.sha256,'--pid',String(process.pid),'--version',release.version],{detached:true,windowsHide:true,stdio:'ignore'});
    await new Promise((done,fail)=>{child.once('spawn',done);child.once('error',fail);});child.unref();state={...state,state:'installing'};setTimeout(onApply,750);return status();
  };
  return {status,check,download,apply,settled:()=>job||Promise.resolve()};
}

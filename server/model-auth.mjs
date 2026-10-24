import './env.mjs';
import {randomBytes} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {homedir} from 'node:os';
const cache=process.env.FLOWSUB_CACHE||resolve(homedir(),'.cache','flowsub');mkdirSync(cache,{recursive:true});
const file=resolve(cache,'runtime.token');let token=process.env.FLOWSUB_MODEL_TOKEN;
if(!token){try{token=readFileSync(file,'utf8').trim();}catch(error){if(error.code!=='ENOENT')throw error;token=randomBytes(24).toString('hex');writeFileSync(file,token,{mode:0o600,flag:'wx'});}}
export const modelToken=token;

// Protocol/recovery fixture only; never used as speech-recognition evidence.
import {createInterface} from 'node:readline';
const mode=process.argv[2];
let requests=0;
if(mode==='staged'||mode==='stream-startup-hang')console.log(JSON.stringify({type:'stream_ready'}));
else if(mode!=='startup-hang')console.log(JSON.stringify({type:'ready'}));
if(mode==='staged')setTimeout(()=>console.log(JSON.stringify({type:'ready'})),1000);
createInterface({input:process.stdin}).on('line',raw=>{
  const value=JSON.parse(raw);
  if(value.type==='transcribe'&&(mode==='final-hang'||mode==='final-slow'||mode==='final-error')){
    if(value.final){
      console.log(JSON.stringify({type:'final_started',id:value.id,revision:value.revision}));
      if(mode==='final-slow')setTimeout(()=>console.log(JSON.stringify({type:'transcript',id:value.id,text:value.id,final:true,revision:value.revision})),100);
      if(mode==='final-error')console.log(JSON.stringify({type:'asr_error',id:value.id}));
    }else console.log(JSON.stringify({type:'transcript',id:value.id,text:value.id,final:false,revision:value.revision}));
  }
  if(value.type==='transcribe'&&(mode==='working'||mode==='staged'||mode==='work-then-hang'&&requests++===0))console.log(JSON.stringify({type:'transcript',id:value.id,text:value.id,final:!!value.final,revision:value.revision}));
});

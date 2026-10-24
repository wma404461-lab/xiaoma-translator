import {createInterface} from 'node:readline';
console.log(JSON.stringify({type:'ready'}));
createInterface({input:process.stdin}).on('line',line=>{
  const value=JSON.parse(line);
  if(value.text==='CRASH'){process.exit(2);return;}
  if(value.text==='HOLD')return;
  if(value.text==='LATE'){setTimeout(()=>console.log(JSON.stringify({id:value.id,allow:true})),150);return;}
  console.log(JSON.stringify({id:value.id,allow:value.text!=='NOUN'}));
});

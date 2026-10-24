// Supervision protocol fixture, not captured speech or accuracy evidence.
const mode=process.argv[2];
if(mode!=='startup-hang')console.log(JSON.stringify({type:'capture_ready',waiting:true}));
if(mode==='healthy')setInterval(()=>console.log(JSON.stringify({type:'capture_health'})),100);
process.stdin.resume();

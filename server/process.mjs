import {spawnSync} from 'node:child_process';
// Windows virtual-environment python.exe can spawn a second interpreter.
// Terminate the owned tree so capture/inference cannot remain in the background.
export function stopChild(child){
  if(!child?.pid || child.exitCode!==null)return;
  if(process.platform==='win32')spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:3000});
  else child.kill();
}

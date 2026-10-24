"""Automatically follow an audio application and capture only its process tree."""
import argparse,base64,json,os,pathlib,subprocess,sys,threading,time
sys.coinit_flags=0
import numpy as np
from process_audio import ProcessCapture

def emit(value):print(json.dumps(value,ensure_ascii=False),flush=True)

parser=argparse.ArgumentParser();parser.add_argument('--ignore-tree',type=int);parser.add_argument('--pid',type=int,help='Explicit PID for developer isolation checks only');args=parser.parse_args()
stop=threading.Event()
def commands():
    for line in sys.stdin:
        if line.strip()=='stop':break
    stop.set()
threading.Thread(target=commands,daemon=True).start()
target_state=(args.pid,'QA Player',(args.pid,),0) if args.pid else (None,'',(),0)
monitor=None
def monitor_events():
    global target_state
    try:
        for line in monitor.stdout:
            value=json.loads(line)
            if 'pid' in value:target_state=(value['pid'],value.get('name',''),tuple(value.get('pids',())),value.get('errors',0))
            else:target_state=(*target_state[:3],value.get('errors',0))
    finally:
        if not stop.is_set():target_state=(*target_state[:3],5)
if not args.pid:
    monitor=subprocess.Popen([sys.executable,'-u',str(pathlib.Path(__file__).with_name('source_monitor.py')),'--ignore-tree',str(args.ignore_tree or os.getpid())],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,encoding='utf-8',env={**os.environ,'PYTHONIOENCODING':'utf-8'},creationflags=subprocess.CREATE_NO_WINDOW)
    threading.Thread(target=monitor_events,daemon=True).start()
captures={};buffers={};selected=None;signature=None;next_frame=time.monotonic();last_health=0
try:
    emit({'type':'capture_ready','device':'Auto-follow foreground app','scope':'process','waiting':True})
    while not stop.is_set():
        now=time.monotonic()
        if now-last_health>=1:
            emit({'type':'capture_health'});last_health=now
        target,name,pids,errors=target_state
        if errors>=5:raise RuntimeError('Audio session discovery unavailable')
        wanted=(target,pids)
        if wanted!=signature:
            if len(pids)>16:raise RuntimeError('Too many audio processes in the selected application')
            source_changed=target!=selected or signature is None
            for pid in list(captures):
                if source_changed or pid not in pids:captures.pop(pid).close();buffers.pop(pid,None)
            if source_changed:buffers.clear();next_frame=now+.05
            selected=target;signature=wanted
            for pid in pids:
                if pid not in captures:captures[pid]=ProcessCapture(pid);buffers[pid]=bytearray()
            # Audio child lifecycle must not reset speech/context/display.
            if source_changed:emit({'type':'capture_target','pid':selected,'device':name,'scope':'process','rendererCount':len(pids)})
            if captures:emit({'type':'capture_ready','pid':selected,'device':name,'scope':'process','waiting':False})
        if selected:
            for pid,capture in captures.items():
                buffers[pid].extend(capture.read())
                if len(buffers[pid])>48000*8*2:raise RuntimeError('Process-audio backlog exceeds two seconds')
            # Mix only audio-session processes belonging to this application.
            # A fixed clock keeps silence/VAD timing independent of device packets.
            while now>=next_frame:
                mixed=np.zeros((2400,2),dtype=np.float32)
                for buffer in buffers.values():
                    size=min(len(buffer),2400*8);size-=size%8
                    if size:mixed[:size//8]+=np.frombuffer(bytes(buffer[:size]),dtype='<f4').reshape(-1,2);del buffer[:size]
                samples=mixed.mean(axis=1).reshape(-1,2).mean(axis=1)
                pcm=(np.clip(samples,-1,1)*32767).astype('<i2').tobytes();emit({'type':'audio','pcm':base64.b64encode(pcm).decode(),'targetPid':selected});next_frame+=.05
        stop.wait(.005)
except BrokenPipeError:pass
except Exception as error:emit({'type':'capture_error','message':str(error)[:200]})
finally:
    stop.set()
    for capture in captures.values():capture.close()
    if monitor:
        try:monitor.stdin.write('stop\n');monitor.stdin.flush();monitor.wait(timeout=5)
        except (BrokenPipeError,OSError,subprocess.TimeoutExpired):monitor.stdin.close()

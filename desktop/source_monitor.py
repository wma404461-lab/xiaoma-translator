"""Discover sources in a separate process so COM scans cannot stall PCM capture."""
import argparse,json,sys,threading,time
sys.coinit_flags=0
from audio_target import TargetSelector
parser=argparse.ArgumentParser();parser.add_argument('--ignore-tree',type=int,required=True);args=parser.parse_args()
stop=threading.Event()
def commands():
    for line in sys.stdin:
        if line.strip()=='stop':break
    stop.set()
threading.Thread(target=commands,daemon=True).start()
selector=TargetSelector(args.ignore_tree,settle_seconds=.4);errors=0
while not stop.is_set():
    began=time.monotonic()
    try:
        target,name=selector.poll();errors=0
        print(json.dumps({'pid':target,'name':name,'pids':selector.capture_pids(),'errors':0},ensure_ascii=False),flush=True)
    except BrokenPipeError:break
    except Exception:
        errors+=1;print(json.dumps({'errors':errors}),flush=True)
    # Poll on a fixed cadence; do not add another full wait after a slow COM scan.
    stop.wait(max(.02,.25-(time.monotonic()-began)))

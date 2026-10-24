"""Zipformer incremental drafts, Whisper final correction, both entirely local."""
import base64, collections, json, os, pathlib, sys, threading, time, re
import numpy as np
import sherpa_onnx
from faster_whisper import WhisperModel
from quality import reliable_text
from model_runtime import load_whisper
cache=pathlib.Path(os.environ.get('FLOWSUB_CACHE',pathlib.Path.home()/'.cache'/'flowsub'))
directory=cache/'zipformer-en-giga'
recognizer=sherpa_onnx.OnlineRecognizer.from_transducer(tokens=str(directory/'tokens.txt'),encoder=str(directory/'encoder-epoch-99-avg-1.int8.onnx'),decoder=str(directory/'decoder-epoch-99-avg-1.int8.onnx'),joiner=str(directory/'joiner-epoch-99-avg-1.int8.onnx'),num_threads=2,sample_rate=16000,feature_dim=80,decoding_method='greedy_search',enable_endpoint_detection=False,model_type='zipformer')
condition=threading.Condition();final_condition=threading.Condition();final_model_ready=threading.Event();jobs=collections.OrderedDict();final_jobs=collections.OrderedDict();streams={};closed=False;generation=0
output_lock=threading.Lock()
def emit(value):
    with output_lock:print(json.dumps(value,ensure_ascii=False),flush=True)
def waveform(job):
    samples=np.frombuffer(base64.b64decode(job['audio'],validate=True),dtype='<i2').astype(np.float32)/32768
    if len(samples)>24000*12:raise ValueError('Audio segment exceeds limit')
    return np.interp(np.arange(0,len(samples),1.5),np.arange(len(samples)),samples).astype(np.float32)
def stream_worker():
    while True:
        with condition:
            condition.wait_for(lambda:jobs or closed)
            if closed:return
            _,job=jobs.popitem(last=False)
        try:
            start=time.perf_counter();samples=waveform(job)
            stream,offset=streams[job['id']] if job['id'] in streams else (recognizer.create_stream(),0)
            if len(samples)>offset:stream.accept_waveform(16000,samples[offset:])
            if job.get('final'):stream.accept_waveform(16000,np.zeros(12800,dtype=np.float32));stream.input_finished()
            while recognizer.is_ready(stream):recognizer.decode_stream(stream)
            text=recognizer.get_result(stream).strip()
            if job.get('generation')!=generation:continue
            if reliable_text(text,len(samples)/16000):emit({'type':'transcript','id':job['id'],'sourceSequence':job.get('sourceSequence'),'text':text,'revision':job['revision'],'final':False,'sourceEnded':bool(job.get('final')),'endReason':job.get('endReason'),'reviewLoading':bool(job.get('final')) and not final_model_ready.is_set(),'reviewQueued':bool(job.get('final')),'asrMs':round((time.perf_counter()-start)*1000)})
            if job.get('final'):
                streams.pop(job['id'],None)
                with final_condition:
                    if len(final_jobs)>=24 and job['id'] not in final_jobs:raise ValueError('Final backlog full')
                    final_jobs[job['id']]={**job,'stream_text':text};final_condition.notify()
            else:streams[job['id']]=(stream,len(samples))
        except Exception:
            streams.pop(job['id'],None);emit({'type':'asr_error','id':job['id'],'message':'Streaming recognition failed'})
def final_worker():
    # Live Zipformer decoding need not wait for final-model CUDA warmup.
    # Keep final requests in the existing bounded queue while loading.
    try:
        whisper,whisper_device=load_whisper(cache)
    except Exception:
        emit({'type':'initialization_error','message':'Final recognition initialization failed'})
        os._exit(1)  # The owning supervisor performs the same bounded retries.
    final_model_ready.set()
    emit({'type':'ready','model':'Zipformer streaming + '+whisper.flowsub_label+' final correction','device':whisper_device})
    while True:
        with final_condition:
            final_condition.wait_for(lambda:final_jobs or closed)
            if closed:return
            _,job=final_jobs.popitem(last=False)
        try:
            start=time.perf_counter()
            if job.get('generation')!=generation:continue
            emit({'type':'final_started','id':job['id'],'revision':job['revision']})
            samples=waveform(job);fallback=job.get('stream_text','');corrected=False
            if len(samples)<6400 and fallback:text=fallback
            else:
                segments,_=whisper.transcribe(samples,language='en',beam_size=3,max_new_tokens=96,temperature=0,condition_on_previous_text=False,vad_filter=True,vad_parameters={'min_speech_duration_ms':100,'min_silence_duration_ms':250,'speech_pad_ms':200},initial_prompt=job.get('terms','')[:500],compression_ratio_threshold=2.0,repetition_penalty=1.05)
                segments=list(segments);text=' '.join(x.text.strip() for x in segments).strip()
                abnormal=not reliable_text(text,len(samples)/16000) or any(x.compression_ratio>2.5 for x in segments)
                if abnormal:text=fallback if reliable_text(fallback,len(samples)/16000) else ''
                else:corrected=True
            if job.get('generation')!=generation:continue
            if not reliable_text(text,len(samples)/16000):
                emit({'type':'asr_error','id':job['id'],'message':'No reliable speech recognized'});continue
            emit({'type':'transcript','id':job['id'],'sourceSequence':job.get('sourceSequence'),'text':text,'streamText':fallback,'endReason':job.get('endReason'),'revision':job['revision'],'final':True,'corrected':corrected,'asrMs':round((time.perf_counter()-start)*1000)})
        except Exception:emit({'type':'asr_error','id':job['id'],'message':'Final recognition failed'})
threading.Thread(target=stream_worker,daemon=True).start();threading.Thread(target=final_worker,daemon=True).start()
emit({'type':'stream_ready','model':'Zipformer streaming','finalCorrection':'loading'})
for line in sys.stdin:
    try:
        job=json.loads(line)
        if job.get('type')=='stop':break
        if job.get('type')=='reset':
            with condition:
                generation+=1;jobs.clear();streams.clear()
            with final_condition:final_jobs.clear()
            continue
        if job.get('type')!='transcribe':continue
        job['generation']=generation
        with condition:
            if len(jobs)>=24 and job['id'] not in jobs:emit({'type':'asr_error','id':job['id'],'message':'Backlog full'});continue
            if jobs.get(job['id'],{}).get('final'):continue
            jobs[job['id']]=job;condition.notify()
    except Exception:emit({'type':'asr_error','message':'Invalid request'})
with condition:closed=True;condition.notify()
with final_condition:final_condition.notify()

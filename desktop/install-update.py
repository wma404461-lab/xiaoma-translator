"""Verified package installation with rollback, confined to this FlowSub root."""
import argparse,ctypes,hashlib,json,pathlib,shutil,subprocess,time,zipfile,tempfile
def install(root,archive,digest,version,cache):
    began=time.perf_counter()
    root=pathlib.Path(root).resolve();archive=pathlib.Path(archive).resolve();cache=pathlib.Path(cache).resolve()
    if not (root/'package.json').is_file() or json.loads((root/'package.json').read_text(encoding='utf-8'))['name']!='flowsub':raise ValueError('Target is not FlowSub')
    with archive.open('rb') as source:
        if hashlib.file_digest(source,'sha256').hexdigest()!=digest:raise ValueError('Package hash changed')
    verified=time.perf_counter()
    cache.mkdir(parents=True,exist_ok=True)
    stage=pathlib.Path(tempfile.mkdtemp(prefix='stage-'+version+'-',dir=cache));backup=pathlib.Path(tempfile.mkdtemp(prefix='backup-'+version+'-',dir=cache))
    items=[]
    with zipfile.ZipFile(archive) as pack:
        if sum(x.file_size for x in pack.infolist())>1024**3:raise ValueError('Expanded package too large')
        for item in pack.infolist():
            if item.is_dir():continue
            path=pathlib.PurePosixPath(item.filename)
            if path.parts[0]!='FlowSub' or len(path.parts)<2 or any(x in {'..','.'} for x in path.parts) or '\\' in item.filename or ':' in item.filename or (item.external_attr>>16)&0o170000==0o120000:raise ValueError('Unsafe archive entry')
            relative=pathlib.Path(*path.parts[1:]);target=(root/relative).resolve();source=(stage/relative).resolve()
            if not target.is_relative_to(root) or not source.is_relative_to(stage):raise ValueError('Entry escapes installation directory')
            if relative.parts[0] not in {'server','assets','desktop','asr','scripts','tests','docs','licenses','runtime','node_modules','qa','android','README.md','LICENSE','THIRD_PARTY_NOTICES.md','package.json','pnpm-lock.yaml','.env.example','start.ps1','setup-local.ps1','Start-FlowSub.cmd','Setup-FlowSub.cmd','update-inherit.json'}:raise ValueError('Unexpected package entry')
            source.parent.mkdir(parents=True,exist_ok=True)
            with pack.open(item) as data,source.open('wb') as out:shutil.copyfileobj(data,out)
            if str(relative)!='update-inherit.json':items.append((relative,target,source))
    metadata=json.loads((stage/'package.json').read_text(encoding='utf-8'))
    if metadata.get('name')!='flowsub' or metadata.get('version')!=version:raise ValueError('Package identity or version mismatch')
    extracted=time.perf_counter()
    inherit=stage/'update-inherit.json'
    if inherit.is_file():
        declaration=json.loads(inherit.read_text(encoding='utf-8'))
        if declaration.get('schema')!=1 or declaration.get('version')!=version or not 1<=len(declaration.get('files',[]))<=2:raise ValueError('Invalid inherited resource declaration')
        seen=set()
        for item in declaration['files']:
            name=item.get('path')
            if name not in {'runtime/node.exe','assets/fonts/NotoSansSC.ttf'} or name in seen or (stage/name).exists():raise ValueError('Unexpected inherited dependency')
            seen.add(name);existing=(root/name).resolve()
            if not existing.is_relative_to(root) or not existing.is_file() or existing.stat().st_size!=item.get('bytes'):raise ValueError('Inherited resource missing or changed; full package required')
            with existing.open('rb') as source:
                if hashlib.file_digest(source,'sha256').hexdigest()!=item.get('sha256'):raise ValueError('Inherited resource hash mismatch; full package required')
            (stage/name).parent.mkdir(parents=True,exist_ok=True);shutil.copy2(existing,stage/name)
    required=['server/index.mjs','desktop/overlay.py','runtime/node.exe','Start-FlowSub.cmd']
    if any(not (stage/name).is_file() for name in required):raise ValueError('Incomplete package')
    reused=time.perf_counter()
    written=[]
    try:
        for relative,target,source in items:
            old=backup/relative;existed=target.is_file()
            if existed:old.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(target,old)
            target.parent.mkdir(parents=True,exist_ok=True);temporary=target.with_name(target.name+'.flowsub-updating')
            if not temporary.resolve().is_relative_to(root):raise ValueError('Temporary file escapes installation directory')
            shutil.copy2(source,temporary);temporary.replace(target);written.append((target,old,existed))
    except BaseException:
        for target,old,existed in reversed(written):
            if existed:shutil.copy2(old,target)
            elif target.is_file() and target.resolve().is_relative_to(root):target.unlink()
        raise
    ended=time.perf_counter()
    return {'version':version,'files':len(written),'backup':str(backup),'timings':{'verificationMs':(verified-began)*1000,'extractionMs':(extracted-verified)*1000,'resourceReuseMs':(reused-extracted)*1000,'replaceAndBackupMs':(ended-reused)*1000,'totalMs':(ended-began)*1000}}
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--root',required=True);parser.add_argument('--archive',required=True);parser.add_argument('--sha256',required=True);parser.add_argument('--pid',type=int,required=True);parser.add_argument('--version',required=True);args=parser.parse_args()
    cache=pathlib.Path(args.archive).resolve().parent;result={'state':'failed'}
    try:
        kernel=ctypes.windll.kernel32;kernel.OpenProcess.restype=ctypes.c_void_p;handle=kernel.OpenProcess(0x100000,False,args.pid)
        if handle:
            try:
                kernel.WaitForSingleObject.argtypes=[ctypes.c_void_p,ctypes.c_uint32]
                if kernel.WaitForSingleObject(handle,30000)!=0:raise TimeoutError('FlowSub did not shut down; no files replaced')
            finally:kernel.CloseHandle.argtypes=[ctypes.c_void_p];kernel.CloseHandle(handle)
        result={'state':'installed',**install(args.root,args.archive,args.sha256,args.version,cache)}
    except BaseException as error:result['error']=str(error)
    finally:
        (cache/'install-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
        root=pathlib.Path(args.root).resolve()
        if (root/'package.json').is_file() and json.loads((root/'package.json').read_text(encoding='utf-8')).get('name')=='flowsub':
            subprocess.Popen(['powershell.exe','-NoProfile','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',str(root/'start.ps1')],cwd=root,creationflags=subprocess.CREATE_NO_WINDOW)
if __name__=='__main__':main()

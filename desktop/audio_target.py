"""Read foreground application/audio-session metadata; never change app volumes."""
import ctypes
from ctypes import wintypes
import time
import psutil
from pycaw.pycaw import AudioUtilities
from process_tree import PollProcessTree

user=ctypes.windll.user32
user.GetForegroundWindow.restype=wintypes.HWND
user.GetWindowThreadProcessId.argtypes=[wintypes.HWND,ctypes.POINTER(wintypes.DWORD)]

def application_root(pid,parents=None,process_factory=None):
    process=(process_factory or psutil.Process)(pid);name=process.name().lower()
    for parent in (parents(process) if parents else process.parents()):
        if parent.name().lower()!=name:break
        process=parent
    return process.pid,process.name()

def embedded_in(process,owner,parents=None):
    # A terminal/launcher starts independent apps; it is not an embedded audio
    # host. Do not absorb every tool/app launched from the foreground host.
    launchers={'cmd.exe','powershell.exe','pwsh.exe','conhost.exe','explorer.exe','taskmgr.exe','windowsterminal.exe'}
    for parent in (parents(process) if parents else process.parents()):
        if parent.name().lower() in launchers:return False
        if parent.pid==owner:return True
    return process.pid==owner

class TargetSelector:
    def __init__(self,ignore_tree=None,settle_seconds=.8):
        self.ignore_tree=ignore_tree;self.settle_seconds=settle_seconds;self.current=None;self.candidate=None;self.changed_at=0;self.renderers={}
    def ignored(self,pid,parents=None,process_factory=None):
        if pid==self.ignore_tree:return True
        try:
            process=(process_factory or psutil.Process)(pid)
            return any(parent.pid==self.ignore_tree for parent in (parents(process) if parents else process.parents()))
        except psutil.Error:return True
    def snapshot(self):
        sources={};active=set();renderers={}
        # Parent metadata comes from one table, with per-poll creation-time
        # checks. psutil.parents() otherwise enumerates Windows processes for
        # every link in every distinct renderer's ancestry.
        tree=PollProcessTree();parents=tree.parents;process_factory=tree.process
        foreground=wintypes.DWORD();window=user.GetForegroundWindow()
        if window:user.GetWindowThreadProcessId(window,ctypes.byref(foreground))
        front_root=None;front_name=''
        if foreground.value and not self.ignored(foreground.value,parents,process_factory):
            try:front_root,front_name=application_root(foreground.value,parents,process_factory)
            except psutil.Error:pass
        for session in AudioUtilities.GetAllSessions():
            try:
                if session.Process is None or session.State==2:continue
                pid=session.Process.pid
                if self.ignored(pid,parents,process_factory) or session.SimpleAudioVolume.GetMute():continue
                root,name=application_root(pid,parents,process_factory);sources[root]=name;renderers.setdefault(root,set()).add(pid)
                if session.State==1:active.add(root)
                # Embedded browser/audio hosts can use a different executable name.
                for owner,owner_name in ((front_root,front_name),(self.current,'')):
                    if owner and embedded_in(session.Process,owner,parents):
                        sources[owner]=owner_name or sources.get(owner,'');renderers.setdefault(owner,set()).add(pid)
                        if session.State==1:active.add(owner)
            except (psutil.Error,OSError,AttributeError):continue
        wanted=None
        if front_root in active:wanted=front_root
        if wanted is None:
            if self.current in active:wanted=self.current
            elif len(active)==1:wanted=next(iter(active))
            elif self.current and psutil.pid_exists(self.current):wanted=self.current
        self.renderers=renderers
        return wanted,sources.get(wanted,'')
    def capture_pids(self):
        # Target actual audio-session processes. Some launchers/job boundaries
        # report child ancestry but their parent-loopback contains no child audio.
        return tuple(sorted(self.renderers.get(self.current,())))
    def poll(self):
        wanted,name=self.snapshot();now=time.monotonic()
        if wanted!=self.candidate:self.candidate=wanted;self.changed_at=now
        if wanted!=self.current and now-self.changed_at>=self.settle_seconds:self.current=wanted
        if self.current:
            try:return self.current,name if wanted==self.current and name else psutil.Process(self.current).name()
            except psutil.Error:self.current=None
        return None,''

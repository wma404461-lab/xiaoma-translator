"""Source-selection policy checks using only fake window/audio metadata."""
import pathlib,sys,types,unittest
from unittest.mock import patch
sys.coinit_flags=0
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'desktop'))
import audio_target as target

class Process:
    def __init__(self,pid,name,parents=()):self.pid=pid;self.label=name;self.ancestors=parents
    def name(self):return self.label
    def parents(self):return list(self.ancestors)
    def create_time(self):return 1

class SelectionTest(unittest.TestCase):
    def snapshot(self,foreground,sessions,current=None,ignore=None,with_capture=False):
        processes={p.pid:p for p in sessions}
        for p in list(processes.values()):processes.update({v.pid:v for v in p.parents()})
        def window_pid(window,pointer):pointer._obj.value=foreground
        user=types.SimpleNamespace(GetForegroundWindow=lambda:1,GetWindowThreadProcessId=window_pid)
        audio=[types.SimpleNamespace(Process=p,State=getattr(p,'audio_state',1),SimpleAudioVolume=types.SimpleNamespace(GetMute=lambda:False)) for p in sessions]
        selector=target.TargetSelector(ignore);selector.current=current
        ppids={pid:(p.ancestors[0].pid if p.ancestors else 0) for pid,p in processes.items()}
        import process_tree
        with patch.object(process_tree,'process_table',return_value=ppids),patch.object(target,'user',user),patch.object(target.AudioUtilities,'GetAllSessions',return_value=audio),patch.object(target.psutil,'Process',side_effect=lambda pid:processes[pid]),patch.object(target.psutil,'pid_exists',side_effect=lambda pid:pid in processes):
            result=selector.snapshot()
            if with_capture:selector.current=result[0];return result,selector.capture_pids()
            return result
    def test_foreground_sound_wins_over_previous_background(self):
        self.assertEqual(self.snapshot(20,[Process(10,'playerA.exe'),Process(20,'playerB.exe')],10),(20,'playerB.exe'))
    def test_clicking_own_overlay_keeps_previous_source(self):
        gateway=Process(50,'node.exe');overlay=Process(51,'python.exe',[gateway])
        self.assertEqual(self.snapshot(51,[Process(10,'playerA.exe'),overlay],10,50),(10,'playerA.exe'))
    def test_one_source_is_selected_without_manual_setting(self):
        self.assertEqual(self.snapshot(0,[Process(10,'playerA.exe')]),(10,'playerA.exe'))
    def test_multiple_sources_without_foreground_wait_instead_of_mixing(self):
        self.assertEqual(self.snapshot(0,[Process(10,'playerA.exe'),Process(20,'playerB.exe')]),(None,''))
    def test_browser_children_are_captured_as_one_application(self):
        browser=Process(10,'browser.exe');utility=Process(11,'browser.exe',[browser])
        self.assertEqual(self.snapshot(10,[utility],with_capture=True),((10,'browser.exe'),(11,)))
    def test_capture_tracks_rendering_children_and_excludes_other_app(self):
        player=Process(20,'video.exe');voice=Process(21,'audiohost.exe',[player]);other=Process(30,'background.exe')
        self.assertEqual(self.snapshot(20,[voice,other],with_capture=True),((20,'video.exe'),(21,)))
    def test_terminal_launch_does_not_join_the_foreground_hosts_audio(self):
        host=Process(10,'host.exe');shell=Process(11,'powershell.exe',[host]);player=Process(20,'player.exe',[shell,host])
        self.assertEqual(self.snapshot(10,[player],with_capture=True),((20,'player.exe'),(20,)))
    def test_new_unique_audio_replaces_a_silent_previous_application(self):
        old=Process(10,'old.exe');old.audio_state=0
        self.assertEqual(self.snapshot(0,[old,Process(20,'new.exe')],10),(20,'new.exe'))
    def test_short_focus_change_is_debounced(self):
        selector=target.TargetSelector(settle_seconds=.8)
        with patch.object(selector,'snapshot',return_value=(10,'player.exe')),patch.object(target.psutil,'Process',return_value=Process(10,'player.exe')):
            with patch.object(target.time,'monotonic',return_value=100):self.assertEqual(selector.poll(),(None,''))
            with patch.object(target.time,'monotonic',return_value=100.4):self.assertEqual(selector.poll(),(None,''))
            with patch.object(target.time,'monotonic',return_value=100.9):self.assertEqual(selector.poll(),(10,'player.exe'))
    def test_fast_monitor_still_debounces_temporary_focus(self):
        selector=target.TargetSelector(settle_seconds=.4)
        with patch.object(selector,'snapshot',return_value=(10,'player.exe')),patch.object(target.psutil,'Process',return_value=Process(10,'player.exe')):
            with patch.object(target.time,'monotonic',return_value=100):self.assertEqual(selector.poll(),(None,''))
            with patch.object(target.time,'monotonic',return_value=100.2):self.assertEqual(selector.poll(),(None,''))
            with patch.object(target.time,'monotonic',return_value=100.5):self.assertEqual(selector.poll(),(10,'player.exe'))

if __name__=='__main__':unittest.main()

"""Ancestry consistency and PID-reuse checks for each source-selection poll."""
import pathlib,sys,types,unittest
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'desktop'))
import process_tree as tree

def process(pid,created):return types.SimpleNamespace(pid=pid,create_time=lambda:created)

class ProcessTreeTest(unittest.TestCase):
    def test_parent_pid_reused_after_child_is_not_an_ancestor(self):
        processes={1:process(1,7),2:process(2,5)}
        with patch.object(tree,'process_table',return_value={1:0,2:1}),patch.object(tree.time,'time',return_value=10),patch.object(tree.psutil,'Process',side_effect=processes.get):
            snapshot=tree.PollProcessTree();self.assertEqual(snapshot.parents(processes[2]),[])
    def test_process_born_after_snapshot_cannot_inherit_old_ancestry(self):
        with patch.object(tree,'process_table',return_value={2:1}),patch.object(tree.time,'time',return_value=10),patch.object(tree.psutil,'Process',return_value=process(2,11)):
            with self.assertRaises(tree.psutil.NoSuchProcess):tree.PollProcessTree().process(2)
    def test_cycles_are_bounded_and_table_is_never_reused_between_polls(self):
        processes={1:process(1,1),2:process(2,1),3:process(3,1)}
        with patch.object(tree,'process_table',side_effect=[{1:2,2:1},{2:3,3:0}]) as tables,patch.object(tree.psutil,'Process',side_effect=processes.get):
            first=tree.PollProcessTree();self.assertEqual([p.pid for p in first.parents(processes[2])],[1]);first.parents(processes[1]);self.assertEqual(tables.call_count,1)
            second=tree.PollProcessTree();self.assertEqual([p.pid for p in second.parents(processes[2])],[3]);self.assertEqual(tables.call_count,2)

if __name__=='__main__':unittest.main()

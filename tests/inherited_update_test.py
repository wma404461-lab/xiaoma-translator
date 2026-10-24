import hashlib,importlib.util,json,pathlib,tempfile,unittest,zipfile
spec=importlib.util.spec_from_file_location('installer',pathlib.Path(__file__).parents[1]/'desktop/install-update.py');installer=importlib.util.module_from_spec(spec);spec.loader.exec_module(installer)
class InheritTests(unittest.TestCase):
 def fixture(self,directory):
  root=pathlib.Path(directory)/'app';(root/'runtime').mkdir(parents=True);node=b'validated Node runtime';(root/'runtime/node.exe').write_bytes(node);(root/'package.json').write_text('{"name":"flowsub","version":"0.2.0"}');(root/'settings.json').write_text('retain')
  archive=pathlib.Path(directory)/'content.zip';files={'package.json':'{"name":"flowsub","version":"0.2.1"}','server/index.mjs':'new','desktop/overlay.py':'new','Start-FlowSub.cmd':'new','update-inherit.json':json.dumps({'schema':1,'version':'0.2.1','files':[{'path':'runtime/node.exe','bytes':len(node),'sha256':hashlib.sha256(node).hexdigest()}]})}
  with zipfile.ZipFile(archive,'w') as z:
   for name,value in files.items():z.writestr('FlowSub/'+name,value)
  return root,archive,hashlib.sha256(archive.read_bytes()).hexdigest(),node
 def test_valid_runtime_inherited_settings_retained(self):
  with tempfile.TemporaryDirectory() as d:
   root,archive,digest,node=self.fixture(d);installer.install(root,archive,digest,'0.2.1',d);self.assertEqual((root/'runtime/node.exe').read_bytes(),node);self.assertEqual((root/'settings.json').read_text(),'retain')
 def test_same_length_tampered_runtime_rejected_before_replacement(self):
  with tempfile.TemporaryDirectory() as d:
   root,archive,digest,node=self.fixture(d);(root/'runtime/node.exe').write_bytes(b'x'*len(node))
   with self.assertRaisesRegex(ValueError,'hash mismatch'):installer.install(root,archive,digest,'0.2.1',d)
   self.assertEqual(json.loads((root/'package.json').read_text())['version'],'0.2.0')
if __name__=='__main__':unittest.main()

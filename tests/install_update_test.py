import hashlib,importlib.util,json,pathlib,tempfile,unittest,zipfile
ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('installer',ROOT/'desktop/install-update.py');installer=importlib.util.module_from_spec(spec);spec.loader.exec_module(installer)
class InstallTests(unittest.TestCase):
    def fixture(self,temp,extra=None):
        root=pathlib.Path(temp)/'app';root.mkdir();(root/'package.json').write_text(json.dumps({'name':'flowsub','version':'0.1.23'}),encoding='utf-8');(root/'user-settings.json').write_text('retain',encoding='utf-8')
        archive=pathlib.Path(temp)/'update.zip'
        files={'FlowSub/package.json':json.dumps({'name':'flowsub','version':'0.2.0'}),'FlowSub/server/index.mjs':'new','FlowSub/desktop/overlay.py':'new','FlowSub/runtime/node.exe':'fixture','FlowSub/Start-FlowSub.cmd':'fixture'}
        files.update(extra or {})
        with zipfile.ZipFile(archive,'w') as out:
            for name,value in files.items():out.writestr(name,value)
        return root,archive,hashlib.file_digest(archive.open('rb'),'sha256').hexdigest()
    def test_verified_install_keeps_unknown_settings_and_backs_up_old_version(self):
        with tempfile.TemporaryDirectory() as temp:
            root,archive,digest=self.fixture(temp);result=installer.install(root,archive,digest,'0.2.0',temp)
            self.assertEqual(json.loads((root/'package.json').read_text())['version'],'0.2.0');self.assertEqual((root/'user-settings.json').read_text(),'retain');self.assertEqual(json.loads((pathlib.Path(result['backup'])/'package.json').read_text())['version'],'0.1.23')
    def test_hash_change_cannot_modify_installation(self):
        with tempfile.TemporaryDirectory() as temp:
            root,archive,digest=self.fixture(temp)
            with self.assertRaises(ValueError):installer.install(root,archive,'0'*64,'0.2.0',temp)
            self.assertEqual(json.loads((root/'package.json').read_text())['version'],'0.1.23')
    def test_archive_traversal_is_rejected_before_replacement(self):
        with tempfile.TemporaryDirectory() as temp:
            root,archive,digest=self.fixture(temp,{'FlowSub/../escape.txt':'bad'})
            with self.assertRaises(ValueError):installer.install(root,archive,digest,'0.2.0',temp)
            self.assertFalse((pathlib.Path(temp)/'escape.txt').exists());self.assertEqual(json.loads((root/'package.json').read_text())['version'],'0.1.23')
if __name__=='__main__':unittest.main()

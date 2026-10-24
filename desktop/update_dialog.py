"""Native update panel; authenticated loopback requests run off the UI thread."""
import json,urllib.parse,urllib.request,urllib.error
from PyQt6.QtCore import QThread,QTimer,pyqtSignal,Qt
from PyQt6.QtWidgets import QDialog,QVBoxLayout,QLabel,QPushButton,QProgressBar,QMessageBox
class Request(QThread):
    result=pyqtSignal(dict)
    def __init__(self,base,token,action):super().__init__();self.base=base;self.token=token;self.action=action
    def run(self):
        try:
            request=urllib.request.Request(self.base+'/api/update/'+self.action,method='GET' if self.action=='status' else 'POST',headers={'X-FlowSub-Token':self.token})
            with urllib.request.urlopen(request,timeout=20) as response:value=json.loads(response.read(65537))
        except urllib.error.HTTPError as error:
            try:value=json.loads(error.read(65537))
            except Exception:value={'state':'error','message':'Update service is temporarily unavailable'}
        except Exception:value={'state':'error','message':'Failed to connect to update service, please try again later'}
        self.result.emit(value)
class UpdateDialog(QDialog):
    def __init__(self,url,parent):
        super().__init__(parent);parsed=urllib.parse.urlsplit(url)
        if parsed.hostname!='127.0.0.1':raise ValueError('Updates require the local FlowSub gateway')
        self.base=f'http://127.0.0.1:{parsed.port}';self.token=urllib.parse.parse_qs(parsed.query)['token'][0];self.workers=[];self.pending=False;self.state='idle'
        self.setWindowTitle('Xiaoma Translator · Software Update');self.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint);self.setMinimumWidth(380)
        layout=QVBoxLayout(self);layout.setContentsMargins(18,18,18,18);layout.setSpacing(10)
        self.title=QLabel('Check for Latest Version');self.title.setStyleSheet('font-size:17px;font-weight:600');layout.addWidget(self.title)
        self.details=QLabel('Install update package after signature and integrity verification; local models will be retained.');self.details.setWordWrap(True);layout.addWidget(self.details)
        self.progress=QProgressBar();self.progress.setRange(0,100);self.progress.hide();layout.addWidget(self.progress)
        self.action=QPushButton('Check for Updates');self.action.clicked.connect(self.clicked);layout.addWidget(self.action)
        self.timer=QTimer(self);self.timer.setInterval(1000);self.timer.timeout.connect(lambda:self.request('status'));self.request('check')
    def request(self,action):
        if self.pending:return
        self.pending=True;self.action.setEnabled(False);worker=Request(self.base,self.token,action);self.workers.append(worker)
        worker.result.connect(self.receive);worker.finished.connect(lambda:self.release(worker));worker.start()
    def release(self,worker):
        if worker in self.workers:self.workers.remove(worker)
        worker.deleteLater()
    def receive(self,value):
        self.pending=False;self.state=value.get('state','error');self.action.setEnabled(True);version=value.get('version','');current=value.get('currentVersion','')
        if self.state=='available':self.title.setText('New version found '+version);self.details.setText(value.get('notes','')+f"\n\n Current {current} · Installation package is approximately {round(value.get('bytes',0)/1e6)} MB");self.action.setText('Download Update')
        elif self.state=='current':self.title.setText('Already up to date '+current);self.details.setText('Local models and existing settings will be retained.');self.action.setText('Recheck')
        elif self.state=='downloading':self.title.setText('Downloading '+version);self.progress.show();self.progress.setValue(value.get('progress',0));self.action.setText('Downloading…');self.action.setEnabled(False);self.timer.start()
        elif self.state=='ready':self.timer.stop();self.title.setText('Update package has been verified');self.details.setText('Installation will close current subtitles and restart; model does not need to be re-downloaded.');self.progress.setValue(100);self.action.setText('Install and Restart')
        elif self.state=='installing':self.timer.stop();self.title.setText('Restarting Xiaoma Translator…');self.action.setEnabled(False)
        elif self.state=='checking':self.title.setText('Checking…');self.action.setEnabled(False)
        else:self.timer.stop();self.title.setText('Update temporarily not completed');self.details.setText(value.get('message','Please try again later.'));self.action.setText('Recheck')
    def clicked(self):
        if self.state=='available':self.request('download')
        elif self.state=='ready':
            if QMessageBox.question(self,'Install Update','Install update and restart Xiaoma Translator now?',QMessageBox.StandardButton.Yes|QMessageBox.StandardButton.No)==QMessageBox.StandardButton.Yes:self.request('apply')
        else:self.request('check')
    def closeEvent(self,event):
        self.timer.stop()
        if self.workers:event.ignore();self.hide();return
        event.accept()

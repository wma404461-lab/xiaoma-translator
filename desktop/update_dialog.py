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
            except Exception:value={'state':'error','message':'更新服务暂时不可用'}
        except Exception:value={'state':'error','message':'连接更新服务失败，请稍后重试'}
        self.result.emit(value)
class UpdateDialog(QDialog):
    def __init__(self,url,parent):
        super().__init__(parent);parsed=urllib.parse.urlsplit(url)
        if parsed.hostname!='127.0.0.1':raise ValueError('Updates require the local FlowSub gateway')
        self.base=f'http://127.0.0.1:{parsed.port}';self.token=urllib.parse.parse_qs(parsed.query)['token'][0];self.workers=[];self.pending=False;self.state='idle'
        self.setWindowTitle('小马翻译 · 软件更新');self.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint);self.setMinimumWidth(380)
        layout=QVBoxLayout(self);layout.setContentsMargins(18,18,18,18);layout.setSpacing(10)
        self.title=QLabel('检查最新版本');self.title.setStyleSheet('font-size:17px;font-weight:600');layout.addWidget(self.title)
        self.details=QLabel('更新包通过签名和完整性检查后安装，本地模型会保留。');self.details.setWordWrap(True);layout.addWidget(self.details)
        self.progress=QProgressBar();self.progress.setRange(0,100);self.progress.hide();layout.addWidget(self.progress)
        self.action=QPushButton('检查更新');self.action.clicked.connect(self.clicked);layout.addWidget(self.action)
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
        if self.state=='available':self.title.setText('发现新版本 '+version);self.details.setText(value.get('notes','')+f"\n\n当前 {current} · 安装包约 {round(value.get('bytes',0)/1e6)} MB");self.action.setText('下载更新')
        elif self.state=='current':self.title.setText('已是最新版 '+current);self.details.setText('本地模型和已有设置会保留。');self.action.setText('重新检查')
        elif self.state=='downloading':self.title.setText('正在下载 '+version);self.progress.show();self.progress.setValue(value.get('progress',0));self.action.setText('下载中…');self.action.setEnabled(False);self.timer.start()
        elif self.state=='ready':self.timer.stop();self.title.setText('更新包已验证');self.details.setText('安装会关闭当前字幕并重新启动，模型不需要重下。');self.progress.setValue(100);self.action.setText('安装并重新启动')
        elif self.state=='installing':self.timer.stop();self.title.setText('正在重新启动小马翻译…');self.action.setEnabled(False)
        elif self.state=='checking':self.title.setText('正在检查…');self.action.setEnabled(False)
        else:self.timer.stop();self.title.setText('暂时未完成更新');self.details.setText(value.get('message','请稍后重试。'));self.action.setText('重新检查')
    def clicked(self):
        if self.state=='available':self.request('download')
        elif self.state=='ready':
            if QMessageBox.question(self,'安装更新','现在安装并重新启动小马翻译？',QMessageBox.StandardButton.Yes|QMessageBox.StandardButton.No)==QMessageBox.StandardButton.Yes:self.request('apply')
        else:self.request('check')
    def closeEvent(self,event):
        self.timer.stop()
        if self.workers:event.ignore();self.hide();return
        event.accept()

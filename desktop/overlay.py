"""Native Windows overlay: independent of the browser, globally topmost."""
import argparse, ctypes, json, pathlib, sys
from PyQt6.QtCore import Qt, QUrl, QTimer, QSize
from PyQt6.QtGui import QColor, QFont, QFontDatabase, QFontMetricsF, QPainter, QPainterPath, QPen, QTextLayout, QTextOption, QIcon
from PyQt6.QtWidgets import QApplication, QWidget, QLabel, QVBoxLayout, QHBoxLayout, QPushButton, QSlider, QSizeGrip, QSizePolicy, QGraphicsDropShadowEffect
from PyQt6.QtWebSockets import QWebSocket

class MovieSubtitle(QWidget):
    """Render real glyph outlines so white subtitles survive white video frames."""
    def __init__(self, text='', pixels=36, outline=3, max_lines=None):
        super().__init__()
        self.text=text; self.pixels=pixels; self.outline=outline;self.max_lines=max_lines
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        policy=QSizePolicy(QSizePolicy.Policy.Expanding,QSizePolicy.Policy.Preferred);policy.setHeightForWidth(True);self.setSizePolicy(policy)
    def subtitle_font(self):
        font=QFont(QApplication.font().family());font.setPixelSize(self.pixels);font.setWeight(QFont.Weight.Bold)
        return font
    def lines(self, width):
        font=self.subtitle_font(); result=[]
        for paragraph in self.text.split('\n'):
            text=QTextLayout(paragraph,font);option=QTextOption();option.setWrapMode(QTextOption.WrapMode.WrapAtWordBoundaryOrAnywhere);text.setTextOption(option)
            text.beginLayout()
            while True:
                line=text.createLine()
                if not line.isValid():break
                line.setLineWidth(max(20,width-12));result.append(paragraph[line.textStart():line.textStart()+line.textLength()].strip())
            text.endLayout()
        return result[-self.max_lines:] if self.max_lines else result
    def heightForWidth(self,width):
        ink=QFontMetricsF(self.subtitle_font()).tightBoundingRect('国Ag');padding=max(4,self.outline+1)
        return round(max(1,len(self.lines(width)))*(ink.height()+4)+padding*2)
    def hasHeightForWidth(self):return True
    def sizeHint(self):return QSize(680,round(self.heightForWidth(max(self.width(),680))))
    def minimumSizeHint(self):return QSize(40,round(self.pixels*1.45))
    def setText(self,text):
        if text==self.text:return False
        self.text=text;self.updateGeometry();self.update();return True
    def setPixels(self,value):
        if value==self.pixels:return False
        self.pixels=value;self.updateGeometry();self.update();return True
    def paintEvent(self,event):
        painter=QPainter(self);painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        font=self.subtitle_font();metrics=QFontMetricsF(font);lines=self.lines(self.width());ink=metrics.tightBoundingRect('国Ag');step=ink.height()+4
        baseline=self.height()-max(4,self.outline+1)-ink.bottom()-(len(lines)-1)*step
        pen=QPen(QColor(0,0,0),self.outline*2);pen.setJoinStyle(Qt.PenJoinStyle.RoundJoin)
        for index,line in enumerate(lines):
            path=QPainterPath();path.addText(max(6,(self.width()-metrics.horizontalAdvance(line))/2),baseline+index*step,font,line)
            painter.strokePath(path,pen);painter.fillPath(path,QColor(255,255,255))

class Overlay(QWidget):
    def __init__(self, url=None):
        super().__init__()
        self.setWindowTitle('小马翻译 · 全局字幕')
        self.setWindowFlags(Qt.WindowType.Window | Qt.WindowType.FramelessWindowHint | Qt.WindowType.WindowStaysOnTopHint)
        self.setWindowIcon(QIcon(str(pathlib.Path(__file__).resolve().parents[1]/'assets'/'xiaoma.ico')))
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.opacity = 212; self.drag_origin = None; self.offset = None; self.bilingual = True; self.sizing = False; self.text_only = False; self.auto_connect_pending = not args.render
        screen = QApplication.primaryScreen().availableGeometry()
        self.default_width=min(1100,round(screen.width()*.86))
        self.setMinimumSize(min(640,self.default_width),80); self.resize(self.default_width,150)
        self.move(screen.center().x()-self.width()//2,screen.bottom()-170)
        self.setStyleSheet('QWidget{color:#eef4e9;font-family:"Microsoft YaHei UI";font-size:11px;} QLabel{background:transparent;} QPushButton{background:#29382b;border:1px solid #496142;border-radius:5px;padding:3px 7px;color:#bcd4ae;} QPushButton:hover{background:#3a5234;} QSlider::groove:horizontal{height:3px;background:#42533e;} QSlider::handle:horizontal{width:10px;margin:-4px 0;background:#c5e88e;border-radius:5px;}')
        layout=QVBoxLayout(self);self.main_layout=layout;layout.setContentsMargins(12,8,12,8);layout.setSpacing(4)
        header=QHBoxLayout();header.setContentsMargins(0,0,0,0);header.setSpacing(5);brand=QLabel('小马翻译');brand.setStyleSheet('color:#c5e88e;font-size:11px;font-weight:600;');self.state=QLabel('等待字幕');self.state.setStyleSheet('color:#a7ba9c;font-size:10px;');header.addWidget(brand);header.addStretch();header.addWidget(self.state)
        self.target_name='';self.engine_running=False;self.engine_button=QPushButton('开始翻译');self.engine_button.setToolTip('自动跟随前台有音频的应用，耳机可用，不读取麦克风。点击字幕窗保持原音源。同一浏览器多个标签同时发声仍可能混音。');self.engine_button.clicked.connect(self.engine_control);header.addWidget(self.engine_button)
        self.refresh_button=QPushButton('刷新');self.refresh_button.setToolTip('重新连接识别和翻译，继续接收当前视频。');self.refresh_button.clicked.connect(self.refresh_translation);header.addWidget(self.refresh_button)
        self.header=QWidget();self.header.setLayout(header);layout.addWidget(self.header)
        captions=QWidget();caption_layout=QVBoxLayout(captions);caption_layout.setContentsMargins(0,0,0,0);caption_layout.setSpacing(0)
        self.zh=MovieSubtitle('等待英文语音…',28,2.4);caption_layout.addWidget(self.zh)
        self.en=MovieSubtitle('Waiting for English audio...',20,1.6,max_lines=1);caption_layout.addWidget(self.en);layout.addWidget(captions)
        self.en.setToolTip('英文用一行跟随最新语音；中文在语义定稿后显示，会稍晚到达。')
        controls=QHBoxLayout();controls.setContentsMargins(0,0,0,0);controls.setSpacing(5);controls.addWidget(QLabel('字号'));self.size=QSlider(Qt.Orientation.Horizontal);self.size.setRange(22,48);self.size.setValue(28);self.size.setFixedWidth(75);self.size.valueChanged.connect(self.size_changed);controls.addWidget(self.size);controls.addSpacing(6);controls.addWidget(QLabel('背景'));opacity=QSlider(Qt.Orientation.Horizontal);opacity.setRange(30,100);opacity.setValue(84);opacity.setFixedWidth(65);opacity.valueChanged.connect(self.change_opacity);controls.addWidget(opacity)
        self.language=QPushButton('双语');self.language.clicked.connect(self.toggle_language);controls.addWidget(self.language);plain=QPushButton('透明');plain.clicked.connect(self.toggle_text_only);controls.addWidget(plain);update=QPushButton('更新');update.clicked.connect(self.open_update);controls.addWidget(update);controls.addStretch();controls.addWidget(QSizeGrip(self));self.controls=QWidget();self.controls.setLayout(controls);layout.addWidget(self.controls)
        plain.setToolTip('透明文字模式：Ctrl+Alt+T')
        self.exit_transparent=QPushButton('退出透明',self);self.exit_transparent.setStyleSheet('background:rgba(18,24,20,170);color:#e8eee6;border:1px solid #687c61;border-radius:5px;padding:3px 6px;font-size:10px;');self.exit_transparent.setToolTip('恢复控制栏 · Ctrl+Alt+T');self.exit_transparent.clicked.connect(self.toggle_text_only);self.exit_transparent.adjustSize();self.exit_transparent.hide()
        for label in [self.zh,self.en]:
            shadow=QGraphicsDropShadowEffect(label);shadow.setBlurRadius(8);shadow.setOffset(0,2);shadow.setColor(QColor(0,0,0,210));label.setGraphicsEffect(shadow)
        self.socket=QWebSocket();self.socket.textMessageReceived.connect(self.receive);self.socket.connected.connect(self.connected);self.socket.disconnected.connect(lambda:self.state.setText('连接断开 · 自动重连'))
        self.url=url
        if url:
            self.socket.open(QUrl(url));self.retry=QTimer(self);self.retry.timeout.connect(self.reconnect);self.retry.start(3000)
        self.hotkeys=[]
        if sys.platform=='win32' and not args.render:
            for ident,key in [(153,0x54)]:
                if ctypes.windll.user32.RegisterHotKey(None,ident,0x4000|0x1|0x2,key):self.hotkeys.append(ident)
            self.poll=QTimer(self);self.poll.timeout.connect(self.hotkey_poll);self.poll.start(80)
        self.fit_timer=QTimer(self);self.fit_timer.setSingleShot(True);self.fit_timer.timeout.connect(self.fit_caption_height);self.fit_timer.start(0)
    def open_update(self):
        if not self.url:return
        from update_dialog import UpdateDialog
        if not hasattr(self,'update_panel'):self.update_panel=UpdateDialog(self.url,self)
        self.update_panel.show();self.update_panel.raise_()
    def paintEvent(self,event):
        if self.text_only:return
        p=QPainter(self);p.setRenderHint(QPainter.RenderHint.Antialiasing);path=QPainterPath();path.addRoundedRect(1,1,self.width()-2,self.height()-2,16,16);p.fillPath(path,QColor(14,22,18,self.opacity));p.setPen(QColor(128,165,105,70));p.drawPath(path)
    def mousePressEvent(self,event):
        if event.button()==Qt.MouseButton.LeftButton:self.drag_origin=event.globalPosition().toPoint();self.offset=self.pos()
    def mouseMoveEvent(self,event):
        if self.drag_origin is not None:self.move(self.offset+event.globalPosition().toPoint()-self.drag_origin)
    def mouseReleaseEvent(self,event):self.drag_origin=None
    def resizeEvent(self,event):
        if hasattr(self,'exit_transparent'):self.exit_transparent.move(self.width()-self.exit_transparent.width()-6,4)
        if hasattr(self,'fit_timer') and event.size().width()!=event.oldSize().width():self.fit_timer.start(100)
        super().resizeEvent(event)
    def change_opacity(self,value):self.opacity=round(value*2.55);self.update()
    def publish(self,value):
        if self.socket.isValid():self.socket.sendTextMessage(json.dumps({'type':'overlay-preference',**value}))
    def connected(self):
        self.socket.sendTextMessage(json.dumps({'type':'native-ready'}))
        if self.auto_connect_pending:
            self.auto_connect_pending=False
            self.socket.sendTextMessage(json.dumps({'type':'native-control','action':'start'}))
    def engine_control(self):
        if self.socket.isValid():self.socket.sendTextMessage(json.dumps({'type':'native-control','action':'stop' if self.engine_running else 'start'}));self.engine_button.setEnabled(False);QTimer.singleShot(9000,lambda:self.engine_button.setEnabled(True))
    def refresh_translation(self):
        if self.socket.isValid():
            self.state.setText('正在刷新翻译…');self.refresh_button.setEnabled(False)
            self.socket.sendTextMessage(json.dumps({'type':'native-control','action':'refresh'}))
            QTimer.singleShot(15000,lambda:self.refresh_button.setEnabled(True))
        else:
            self.auto_connect_pending=True;self.reconnect();self.state.setText('正在重新连接…')
    def size_changed(self,value):
        self.zh.setPixels(value);self.en.setPixels(max(18,round(value*.7)))
        if not self.sizing:self.fit_caption_height();self.publish({'fontSize':value})
    def toggle_language(self):
        self.bilingual=not self.bilingual;self.en.setVisible(self.bilingual);self.language.setText('中英双语' if self.bilingual else '仅中文');self.fit_caption_height();self.publish({'bilingual':self.bilingual})
    def toggle_text_only(self):
        self.set_text_only(not self.text_only);self.publish({'transparent':self.text_only})
    def set_text_only(self,value):
        self.text_only=bool(value);self.header.setVisible(not value);self.controls.setVisible(not value);self.exit_transparent.setVisible(bool(value));self.exit_transparent.raise_()
        self.main_layout.setContentsMargins(12,29 if value else 8,12,6 if value else 8);self.fit_caption_height();self.update()
    def hotkey_poll(self):
        from ctypes import wintypes
        message=wintypes.MSG()
        while ctypes.windll.user32.PeekMessageW(ctypes.byref(message),None,0x312,0x312,1):
            if message.wParam==153:self.toggle_text_only()
    def reconnect(self):
        if self.socket.state().value==0:self.socket.open(QUrl(self.url))
    def fit_caption_height(self):
        width=self.width()-24
        captions=self.zh.heightForWidth(width)+(self.en.heightForWidth(width) if self.bilingual else 0)
        needed=captions+(35 if self.text_only else self.header.sizeHint().height()+self.controls.sizeHint().height()+24)
        screen=self.screen().availableGeometry()
        needed=max(80,min(needed,round(screen.height()*.85)))
        if needed!=self.height():
            bottom=self.geometry().bottom();self.resize(self.width(),needed);self.move(self.x(),max(screen.top(),bottom-self.height()+1))
        if self.geometry().bottom()>screen.bottom():self.move(self.x(),max(screen.top(),screen.bottom()-self.height()+1))
    def receive(self,raw):
        try:value=json.loads(raw)
        except Exception:return
        if value.get('type')=='show':self.show();return
        if value.get('type')=='engine-state':self.engine_running=bool(value.get('running'));self.engine_button.setText('停止翻译' if self.engine_running else '开始翻译');self.engine_button.setEnabled(True);self.refresh_button.setEnabled(True);return
        if value.get('type')=='audio-source':self.target_name=value.get('name','').removesuffix('.exe') if value.get('active') else '';return
        if value.get('type')=='english':
            if self.en.setText(value.get('en') or ''):self.fit_caption_height()
            return
        if value.get('type')!='subtitle':return
        zh_changed=self.zh.setText(value.get('zh') or '正在听…');en_changed=self.en.setText(value.get('en') or '')
        bilingual=value.get('bilingual',True);visibility_changed=bilingual!=self.bilingual;self.bilingual=bilingual
        if visibility_changed:self.en.setVisible(bilingual);self.language.setText('双语' if bilingual else '中文')
        mode_changed='transparent' in value and bool(value['transparent'])!=self.text_only
        if mode_changed:self.set_text_only(value['transparent'])
        self.state.setText((self.target_name+' · ' if self.target_name else '')+value.get('state','')+(f" · {value['page']}/{value['pageCount']}" if value.get('pageCount',0)>1 else ''))
        font_size=value.get('fontSize',28);font_changed=font_size!=self.size.value()
        if font_changed:self.sizing=True;self.size.setValue(font_size);self.sizing=False
        if zh_changed or en_changed or visibility_changed or mode_changed or font_changed:self.fit_caption_height()
    def closeEvent(self,event):
        if sys.platform=='win32':
            for ident in self.hotkeys:ctypes.windll.user32.UnregisterHotKey(None,ident)
        self.socket.close();event.accept()
parser=argparse.ArgumentParser();parser.add_argument('--url');parser.add_argument('--render');parser.add_argument('--render-payload');parser.add_argument('--transparent',action='store_true');args=parser.parse_args()
if sys.platform=='win32':ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID('FlowSub.Desktop')
app=QApplication(sys.argv[:1]);app.setApplicationName('小马翻译');app.setWindowIcon(QIcon(str(pathlib.Path(__file__).resolve().parents[1]/'assets'/'xiaoma.ico')));font_file=pathlib.Path(__file__).resolve().parents[1]/'assets'/'fonts'/'NotoSansSC.ttf'
font_id=QFontDatabase.addApplicationFont(str(font_file));families=QFontDatabase.applicationFontFamilies(font_id)
if families:app.setFont(QFont(families[0],10))
window=Overlay(args.url)
if families:window.setStyleSheet(window.styleSheet().replace('Microsoft YaHei UI',families[0]))
window.show()
if args.render:
    window.receive(json.dumps({'type':'subtitle','zh':'不用推倒重来，旧项目照样能用。','en':"You don't have to start from scratch. Your old projects still work.",'state':'已定稿','fontSize':28,'bilingual':True}))
    if args.render_payload:window.receive(pathlib.Path(args.render_payload).read_text(encoding='utf-8'))
    if args.transparent:window.set_text_only(True)
    def save_render():
        pixels=window.grab();pixels.save(args.render)
        pathlib.Path(args.render+'.json').write_text(json.dumps({'logicalWidth':window.width(),'logicalHeight':window.height(),'devicePixelRatio':pixels.devicePixelRatio()}),encoding='utf-8')
        app.quit()
    QTimer.singleShot(300,save_render)
sys.exit(app.exec())

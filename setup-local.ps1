$ErrorActionPreference='Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUNBUFFERED = '1'
if(Test-Path -LiteralPath (Join-Path $PSScriptRoot '.env')){
  foreach($taskLine in Get-Content -LiteralPath (Join-Path $PSScriptRoot '.env')){
    if($taskLine -match '^(FLOWSUB_CACHE|FLOWSUB_BOOTSTRAP_PYTHON)=(.+)$'){[Environment]::SetEnvironmentVariable($Matches[1],$Matches[2].Trim().Trim('"').Trim("'"),'Process')}
  }
}
$taskCache=if($env:FLOWSUB_CACHE){$env:FLOWSUB_CACHE}else{Join-Path $env:USERPROFILE '.cache\flowsub'}
New-Item -ItemType Directory -Force -Path $taskCache | Out-Null
$taskPython=Join-Path $taskCache 'python312\python.exe'
$taskPythonArgs=@()
if($env:FLOWSUB_BOOTSTRAP_PYTHON){$taskPython=$env:FLOWSUB_BOOTSTRAP_PYTHON}
if(!(Test-Path -LiteralPath $taskPython)){
  Write-Output 'FLOWSUB_PROGRESS|1 / 6 · 正在准备运行组件'
  $taskInstaller=Join-Path $taskCache 'python-3.12.10-amd64.exe'
  $taskExpected='67b5635e80ea51072b87941312d00ec8927c4db9ba18938f7ad2d27b328b95fb'
  if(!(Test-Path -LiteralPath $taskInstaller) -or (Get-FileHash -LiteralPath $taskInstaller -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskExpected){
    Invoke-WebRequest -UseBasicParsing -Uri 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe' -OutFile $taskInstaller
  }
  if((Get-FileHash -LiteralPath $taskInstaller -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskExpected){throw 'Python installer checksum mismatch.'}
  $taskPythonDirectory=Join-Path $taskCache 'python312'
  $taskInstall=Start-Process -FilePath $taskInstaller -WindowStyle Hidden -Wait -PassThru -ArgumentList @('/quiet','InstallAllUsers=0',('TargetDir="'+$taskPythonDirectory+'"'),'Include_launcher=0','InstallLauncherAllUsers=0','Include_test=0','Include_doc=0','Include_tcltk=0','Shortcuts=0','AssociateFiles=0','PrependPath=0','Include_pip=1')
  if($taskInstall.ExitCode -notin @(0,3010) -or !(Test-Path -LiteralPath $taskPython)){throw 'Private Python runtime preparation failed.'}
}
& $taskPython -c 'import sys;assert sys.version_info[:2]==(3,12)'
if($LASTEXITCODE -ne 0){throw 'A compatible Python 3.12 runtime is required.'}
$taskEnvPython=Join-Path $taskCache 'venv\Scripts\python.exe'
$taskValidEnv=$false
if(Test-Path -LiteralPath $taskEnvPython){
  $taskEnvVersion=& $taskEnvPython -c 'import sys;print(sys.version_info.major,sys.version_info.minor,sep=chr(46))'
  $taskValidEnv=$LASTEXITCODE -eq 0 -and $taskEnvVersion -eq '3.12'
}
if(!$taskValidEnv){
  & $taskPython @taskPythonArgs -m venv --clear (Join-Path $taskCache 'venv')
  if($LASTEXITCODE -ne 0){throw 'Python setup failed. Use Python 3.12.'}
}
Write-Output 'FLOWSUB_PROGRESS|2 / 6 · 正在安装字幕组件'
& $taskEnvPython -m pip install --disable-pip-version-check -r (Join-Path $PSScriptRoot 'asr\requirements-lock.txt')
if($LASTEXITCODE -ne 0){throw 'Dependency installation failed.'}
Write-Output 'FLOWSUB_PROGRESS|3 / 6 · 正在准备语言组件'
& $taskEnvPython (Join-Path $PSScriptRoot 'scripts\setup-grammar.py')
if($LASTEXITCODE -ne 0){throw 'Free grammar model installation failed.'}
Write-Output 'FLOWSUB_PROGRESS|4 / 6 · 正在下载本地翻译模型'
& $taskEnvPython (Join-Path $PSScriptRoot 'scripts\prepare-local.py')
if($LASTEXITCODE -ne 0){throw 'Model preparation failed; rerun to resume.'}
$taskNvidia=$false
if(Get-Command nvidia-smi -ErrorAction SilentlyContinue){
  & nvidia-smi --query-gpu=name --format=csv,noheader 2>$null | Out-Null
  $taskNvidia=$LASTEXITCODE -eq 0
}
if($taskNvidia){
  Set-Content -LiteralPath (Join-Path $taskCache 'use-nvidia') -Value '1'
  Write-Output 'FLOWSUB_PROGRESS|正在加速下载识别组件'
  & $taskEnvPython (Join-Path $PSScriptRoot 'scripts\prepare-cudnn.py')
  if($LASTEXITCODE -ne 0){Write-Warning 'Optional NVIDIA recognition runtime was not installed; recognition will use CPU.'}
}elseif(Test-Path -LiteralPath (Join-Path $taskCache 'use-nvidia')){Remove-Item -LiteralPath (Join-Path $taskCache 'use-nvidia')}
Write-Output 'FLOWSUB_PROGRESS|5 / 6 · 正在下载语音识别模型'
& $taskEnvPython (Join-Path $PSScriptRoot 'scripts\prepare-streaming.py')
if($LASTEXITCODE -ne 0){throw 'Streaming model download failed.'}
Write-Output 'FLOWSUB_PROGRESS|6 / 6 · 正在完成最后准备'
& $taskEnvPython (Join-Path $PSScriptRoot 'scripts\prepare-whisper.py')
if($LASTEXITCODE -ne 0){throw 'Recognition model download failed.'}
& $taskEnvPython (Join-Path $PSScriptRoot 'scripts\check-install.py')
if($LASTEXITCODE -ne 0){throw 'Installation verification failed; retry to finish.'}
Write-Output 'FLOWSUB_PROGRESS|准备完成，正在打开小马翻译'

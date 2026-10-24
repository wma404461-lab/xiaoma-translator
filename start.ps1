param([switch]$NoBrowser)
$ErrorActionPreference='Stop'
if(!$NoBrowser){
  try{
    $flowExisting=Invoke-RestMethod -Uri 'http://127.0.0.1:4317/api/config' -TimeoutSec 2
    if($flowExisting.translationModel -like 'Qwen3 4B*' -and $flowExisting.token -match '^[a-f0-9]{48}$'){
      $flowOpened=Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:4317/api/overlay/open' -Headers @{'X-FlowSub-Token'=$flowExisting.token} -TimeoutSec 15
      if($flowOpened.opened){exit 0}
    }
  }catch{}
}
$taskNode=if(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'runtime\node.exe')){Join-Path $PSScriptRoot 'runtime\node.exe'}elseif(Get-Command node -ErrorAction SilentlyContinue){(Get-Command node).Source}else{throw 'Install Node.js 22 or later.'}
if(!(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules\ws'))){
  $taskNpm=Get-Command npm -ErrorAction SilentlyContinue
  if(!$taskNpm){throw 'Run pnpm install or npm install once.'}
  Push-Location $PSScriptRoot
  try{& $taskNpm.Source install --omit=dev;if($LASTEXITCODE -ne 0){throw 'Dependency installation failed.'}}finally{Pop-Location}
}
Write-Host 'FlowSub / Local semantic live subtitles'
Write-Host 'Starting the local translation model...'
if($NoBrowser){& $taskNode (Join-Path $PSScriptRoot 'server\index.mjs')}else{& $taskNode (Join-Path $PSScriptRoot 'server\index.mjs') --desktop}

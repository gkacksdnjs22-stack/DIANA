$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$taskEnvPath = Join-Path $taskRoot '.env'
if (-not (Test-Path -LiteralPath $taskEnvPath)) { throw '먼저 npm.cmd run setup 을 실행하세요.' }
Write-Host 'API 키는 채팅에 보내지 말고 이 입력창에만 입력하세요. 문서 텍스트가 API로 전송되며 사용료는 연결한 계정에 청구됩니다.'
$taskSecret = Read-Host 'OpenAI API key (입력 내용 숨김)' -AsSecureString
$taskPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecret)
try {
  $taskApiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPtr)
  if ($taskApiKey -notmatch '^sk-[A-Za-z0-9_-]{16,}$') { throw '키 형식을 확인하세요. 기존 설정은 변경하지 않았습니다.' }
  $taskModel = (Read-Host '계정에서 사용 가능한 Structured Outputs 모델 ID').Trim()
  if ($taskModel -notmatch '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,150}$') { throw '모델 ID를 확인하세요. 기존 설정은 변경하지 않았습니다.' }
  $taskEnv = [IO.File]::ReadAllText($taskEnvPath)
  $taskSettings = @{ AI_MODE = 'openai'; OPENAI_API_KEY = $taskApiKey; OPENAI_MODEL = $taskModel }
  foreach ($taskName in $taskSettings.Keys) {
    $taskPattern = '(?m)^' + [regex]::Escape($taskName) + '=.*$'
    $taskLine = $taskName + '=' + $taskSettings[$taskName]
    if ([regex]::IsMatch($taskEnv, $taskPattern)) { $taskEnv = [regex]::Replace($taskEnv, $taskPattern, [Text.RegularExpressions.MatchEvaluator]{ param($match) $taskLine }) }
    else { $taskEnv += "`r`n$taskLine" }
  }
  [IO.File]::WriteAllText($taskEnvPath, $taskEnv, (New-Object Text.UTF8Encoding $false))
  Write-Host '설정했습니다. 실행 중인 PC 에이전트는 재시작해야 적용됩니다. 키는 화면에 출력하지 않았습니다.'
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPtr)
  $taskApiKey = $null
  $taskEnv = $null
  $taskSettings = $null
  if ($taskSecret) { $taskSecret.Dispose() }
}

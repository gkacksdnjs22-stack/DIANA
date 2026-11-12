$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
if (-not [Environment]::UserInteractive) { exit 1 }
$pairRequest = [Console]::In.ReadToEnd() | ConvertFrom-Json
$pairDialog = New-Object System.Windows.Forms.Form
$pairDialog.Text = 'DIANA - 새 휴대폰 연결 승인'
$pairDialog.Width = 460
$pairDialog.Height = 240
$pairDialog.StartPosition = 'CenterScreen'
$pairDialog.FormBorderStyle = 'FixedDialog'
$pairDialog.MinimizeBox = $false
$pairDialog.MaximizeBox = $false
$pairText = New-Object System.Windows.Forms.Label
$pairText.Text = "새 기기 ‘$($pairRequest.deviceName)’가 연결을 요청했습니다.`n`n방금 직접 연결한 휴대폰인지 확인하세요.`n기기 이름은 요청자가 보낸 정보입니다."
$pairText.UseMnemonic = $false
$pairText.SetBounds(20,20,410,100)
$pairReject = New-Object System.Windows.Forms.Button
$pairReject.Text = '거절'
$pairReject.DialogResult = 'Cancel'
$pairReject.SetBounds(230,145,90,35)
$pairAccept = New-Object System.Windows.Forms.Button
$pairAccept.Text = '승인'
$pairAccept.DialogResult = 'OK'
$pairAccept.SetBounds(330,145,90,35)
$pairDialog.Controls.AddRange(@($pairText,$pairReject,$pairAccept))
$pairDialog.AcceptButton = $pairReject
$pairDialog.CancelButton = $pairReject
try {
    if ($pairDialog.ShowDialog() -eq 'OK') { [Console]::Out.Write('approve') }
} finally { $pairDialog.Dispose() }

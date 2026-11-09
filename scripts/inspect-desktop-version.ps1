param([Parameter(Mandatory=$true)][string]$ExePath)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$full=(Get-Item -LiteralPath $ExePath).FullName
$info=[System.Diagnostics.FileVersionInfo]::GetVersionInfo($full)
# Metadata-only reflection: no entry point, forms, static initializers or worker.
$assembly=[System.Reflection.Assembly]::ReflectionOnlyLoadFrom($full)
$type=$assembly.GetType('Diana.Desktop.BuildVersion',$true)
$values=@{}
foreach($name in @('ProductVersion','NumericVersion','MainTitle','SettingsTitle','DemoSettingsTitle','PickerTitle')){
  $field=$type.GetField($name)
  if($null -eq $field -or -not $field.IsLiteral){throw "Missing generated constant: $name"}
  $values[$name]=$field.GetRawConstantValue()
}
$informational=@($assembly.GetCustomAttributesData() | Where-Object {$_.AttributeType.FullName -eq 'System.Reflection.AssemblyInformationalVersionAttribute'})
if($informational.Count -ne 1){throw 'Missing informational version'}
[ordered]@{fileVersion=$info.FileVersion;productVersion=$info.ProductVersion;assemblyVersion=$assembly.GetName().Version.ToString();informationalVersion=$informational[0].ConstructorArguments[0].Value;constants=$values} | ConvertTo-Json -Depth 5 -Compress

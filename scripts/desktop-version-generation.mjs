import {desktopVersionInfo} from '../financial-desktop/version.mjs';

export function nativeVersionSource(v=desktopVersionInfo){
  return '// Generated from financial-desktop/version.json. Do not edit.\n'+
    `[assembly: System.Reflection.AssemblyVersion("${v.numericVersion}")]\n`+
    `[assembly: System.Reflection.AssemblyFileVersion("${v.numericVersion}")]\n`+
    `[assembly: System.Reflection.AssemblyInformationalVersion("${v.version}")]\n`+
    'namespace Diana.Desktop { public static class BuildVersion {\n'+
    Object.entries({ProductVersion:v.version,NumericVersion:v.numericVersion,MainTitle:v.mainTitle,SettingsTitle:v.settingsTitle,DemoSettingsTitle:v.demoSettingsTitle,PickerTitle:v.pickerTitle})
      .map(([key,value])=>`    public const string ${key} = "${value}";`).join('\n')+'\n} }\n';
}
export function renderDesktopReadme(template,v=desktopVersionInfo){
  if(!template.includes('{{WINDOWS_VERSION}}')||!template.includes('{{EXTRACTION_FOLDER}}'))throw Error('WINDOWS_README_TEMPLATE');
  const rendered=template.replaceAll('{{WINDOWS_VERSION}}',v.version).replaceAll('{{EXTRACTION_FOLDER}}',v.extractionFolder);
  if(/\{\{[^}]+\}\}/u.test(rendered))throw Error('WINDOWS_README_UNRESOLVED');
  return rendered;
}
export function assertNativeBindings(launcher,picker,worker,builder,readme){
  for(const text of [launcher,picker,worker,builder,readme])
    if(/\b\d+\.\d+\.\d+-dev-[a-z]+\d+\b/u.test(text))throw Error('WINDOWS_VERSION_LITERAL');
  if(/Assembly(?:File|Informational)?Version\s*\(/u.test(launcher+picker))throw Error('WINDOWS_NATIVE_MANUAL_VERSION');
  for(const reference of ['Text=BuildVersion.MainTitle','Text=demo?BuildVersion.DemoSettingsTitle:BuildVersion.SettingsTitle'])
    if(!launcher.includes(reference))throw Error('WINDOWS_NATIVE_BINDING');
  if(!picker.includes('Text=Diana.Desktop.BuildVersion.PickerTitle'))throw Error('WINDOWS_PICKER_BINDING');
  if(!worker.includes("appVersion:'desktop-'+desktopVersion"))throw Error('WINDOWS_WORKER_BINDING');
}

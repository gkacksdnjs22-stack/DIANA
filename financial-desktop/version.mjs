import {readFileSync} from 'node:fs';

// Windows product version only. Model, web and runtime versions are independent.
export function resolveDesktopVersion(source) {
  if(!source || Object.keys(source).sort().join(',')!=='schemaVersion,version' || source.schemaVersion!==1)
    throw Error('WINDOWS_VERSION_SCHEMA');
  const match=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-dev-([a-z]+)([1-9]\d*))?$/.exec(source.version);
  if(!match)throw Error('WINDOWS_VERSION_FORMAT');
  const parts=[...match.slice(1,4),match[5]??'0'].map(Number);
  if(parts.some(n=>!Number.isSafeInteger(n)||n>65534))throw Error('WINDOWS_NUMERIC_VERSION_RANGE');
  const version=source.version;
  return Object.freeze({version,numericVersion:parts.join('.'),
    mainTitle:`DIANA ${version} · PC 문서 작업`,
    settingsTitle:`DIANA ${version} · PC 연결 설정`,
    demoSettingsTitle:`DIANA ${version} · 가상 체험 설정`,
    pickerTitle:`DIANA ${version} · PC 문서 폴더 허용`,
    archiveName:`DIANA-PC-${version}-win-x64.zip`,
    extractionFolder:`DIANA-PC-${version}-win-x64`});
}
export const desktopVersionInfo=resolveDesktopVersion(JSON.parse(readFileSync(new URL('./version.json',import.meta.url),'utf8')));
export const desktopVersion=desktopVersionInfo.version;

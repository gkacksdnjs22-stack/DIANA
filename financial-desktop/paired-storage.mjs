import path from 'node:path';
import {lstat,realpath,mkdir} from 'node:fs/promises';
import {checkedDirectory} from '../personal-ai/documents/files.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
// Only the trusted native bootstrap supplies this private application directory.
// It is not a document root and must not relax any document reader's policy.
export async function privateStateDirectory(directory) {
  if(typeof directory!=='string'||!path.isAbsolute(directory)||directory.startsWith('\\\\'))fail('APP_STATE_PATH_INVALID');
  const absolute=path.resolve(directory),drive=path.parse(absolute).root;
  if(absolute===drive)fail('APP_STATE_PATH_INVALID');
  let current=drive;
  for(const part of absolute.slice(drive.length).split(path.sep).filter(Boolean)) {
    current=path.join(current,part);
    let stat;
    try{stat=await lstat(current);}catch(e){if(e.code!=='ENOENT')throw e;await mkdir(current);stat=await lstat(current);}
    if(!stat.isDirectory()||stat.isSymbolicLink())fail('APP_STATE_LINK_DENIED');
    const physical=await realpath(current);
    if(physical.toLowerCase()!==current.toLowerCase())fail('APP_STATE_PATH_CHANGED');
  }
  return absolute;
}

export async function profileDirectory(state,documents) {
  // Keep an existing compatible fixture/portable profile in place. Never silently
  // discard it or move databases containing absolute paths.
  const legacy=path.join(state,'profiles');
  try{await lstat(legacy);return await checkedDirectory(legacy);}catch(e){if(e.code!=='ENOENT')fail('LEGACY_PROFILE_PATH_DENIED');}
  await checkedDirectory(documents);
  const parent=path.join(documents,'DIANA','앱 설정');
  // Check ancestors before creating new children.
  let current=documents;
  for(const part of ['DIANA','앱 설정','paired-dev','profiles']) {
    current=path.join(current,part);
    try{await mkdir(current);}catch(e){if(e.code!=='EEXIST')throw e;}
    await checkedDirectory(current);
  }
  return path.join(parent,'paired-dev','profiles');
}

const messages={
  EADDRINUSE:'PC 연결 포트가 이미 사용 중입니다. 기존 DIANA 연결 상태를 확인한 뒤 다시 시도하세요.',
  EACCES:'앱 설정을 저장할 권한이 없습니다. Windows 사용자와 폴더 권한을 확인하세요.',
  EPERM:'앱 설정에 접근하지 못했습니다. 다른 프로그램의 파일 사용 여부와 폴더 권한을 확인하세요.',
  APP_STATE_LINK_DENIED:'앱 설정 폴더가 다른 위치로 연결되어 있습니다. 설정 위치를 확인하세요.',
  APP_STATE_PATH_CHANGED:'앱 설정 폴더의 실제 위치가 변경되었습니다. 설정 위치를 확인하세요.',
  APP_STATE_PATH_INVALID:'앱 설정 폴더 경로를 확인하세요.',
  LEGACY_PROFILE_PATH_DENIED:'기존 작업공간을 안전하게 열 수 없습니다. 기존 자료는 보존되어 있습니다.',
  document_path_denied:'문서 작업공간 경로가 허용되지 않습니다. 문서 폴더 위치를 확인하세요.',
  document_link_denied:'문서 작업공간이 다른 위치로 연결되어 있습니다. 문서 폴더 위치를 확인하세요.'
};
export function startupFailure(error) {
  const code=Object.hasOwn(messages,error?.code)?error.code:'PC_START_FAILED';
  return {type:'startup-error',code,message:messages[code]||'PC 연결 서비스를 시작하지 못했습니다. 실행 파일과 설정을 확인한 뒤 다시 시도하세요.'};
}

# DIANA 관리자 패스키 시험 모듈

이 폴더는 DIANA 단일 서비스에 포함할 관리자 인증과 Windows 시험 클라이언트다. 운영 서버나 기존 EXE 및 Android 앱에 자동 적용하지 않는다. 서버는 localhost에만 바인딩하고 DB는 이 폴더의 `test-data`에만 만든다. 루트 `.env`, 운영 DB, 문서 파일과 학습 코드를 읽거나 변경하지 않는다.

## 인증과 권한

WebAuthn 등록 및 로그인을 SimpleWebAuthn으로 검증한다. RP ID는 시험용 `localhost`, Origin은 정확히 `http://localhost:43871`이다. challenge는 2분 뒤 만료하고 제출 시 원자적으로 소비한다. 서명, 사용자 확인 및 존재, RP ID, Origin, counter와 현재 인증 등록 상태를 검사한다. 개인키·생체정보·PIN은 서버로 보내지 않는다.

DB에는 계정과 역할, 공개키, 등록 및 폐기 상태, 세션 및 복구 코드 해시를 보관한다. 관리자 세션은 15분이며 갱신 토큰은 발급하지 않는다. 매 요청에 현재 DB 권한을 확인한다. 키 폐기는 그 키가 발급한 모든 세션을 차단하고, 계정의 역할 변경과 비활성화도 기존 세션을 폐기한다.

직접 WebAuthn 인증으로 발급한 세션과 네이티브 교환 세션의 출처를 별도로 기록한다. 네이티브 교환은 원래 WebAuthn 인증 시각과 절대 만료를 그대로 계승하며, 교환 시각부터 새 15분을 부여하지 않는다. 네이티브 세션은 새 승인에 사용할 수 없고, 승인에는 1분 이내에 실제 WebAuthn으로 발급한 세션만 허용한다. 인증 출처 기록이 없는 이전 시험 세션은 재로그인해야 한다.

최초 owner 등록은 운영자 CLI에서만 시작할 수 있다. 이후 관리자 추가와 역할 변경은 owner의 새 WebAuthn 확인과 작업 범위에 연결된 1분짜리 일회용 grant가 필요하다. admin과 auditor는 다른 관리자를 만들거나 승격할 수 없다. 마지막 활성 owner를 비활성화·강등하거나 마지막 키를 폐기할 수 없다. 아직 등록하지 않은 owner 초대는 활성 관리자 수에 포함하지 않는다.

복구 코드는 재인증 후 한 번 표시하며 서버에는 해시만 저장한다. 모든 인증기를 잃으면 운영자가 서비스 중지 후 DB 파일 접근 권한과 유효한 복구 코드를 사용해 CLI 복구를 수행한다. HTTP 복구 API는 없다. 복구는 역할을 확대하지 않고 기존 키·세션·진행 중 등록을 폐기한다. 복구 완료 후 이전 잔여 코드도 폐기한다. 코드까지 잃은 경우 자동 인증 우회를 제공하지 않는다. 개인키를 서버에 백업하지 않는다.

동기화 패스키와 설치별 세션을 구분한다. 세션 하나를 종료해도 그 기기의 동기화 패스키 재로그인은 막을 수 없다. 특정 물리 기기를 영구 차단하려면 별도 기기 귀속 등록과 정책이 필요하다. 이 모듈은 인증키 한 개를 기기 한 대로 표시하지 않는다.

## Windows 연결과 문서 경계

EXE의 관리자 버튼은 별도 관리 창에서 로그인·세션 확인·로그아웃을 제공한다. 시스템 브라우저가 서버 출처에서 패스키를 확인하고, 앱은 임의 포트의 IPv4 loopback으로 authorization code를 받아 PKCE S256으로 교환한다. state, 정확한 반환 경로, 중복 인자와 코드 만료 및 재사용을 검증한다. 토큰은 Windows 현재 사용자 DPAPI로 저장한다.

`127.0.0.1:<임의 포트>/oauth2/callback`은 반환 주소이며 인증 Origin이 아니다. 서버 출처를 localhost PC 문서 화면의 출처와 같은 것으로 취급하지 않는다. 서버 패스키를 PC 문서 화면에서 직접 사용하거나 Bearer 토큰을 URL로 전달하지 않는다.

서버 로그인은 특정 PC 문서 접근·작업 실행·최종 승인 권한을 주지 않는다. 원문·근거·Diff·결과와 최종 승인은 기존 PC에 유지하며 네이티브 상태 응답은 `documentAccess:false`다. 서버가 꺼지거나 세션이 폐기되면 캐시된 역할로 관리자 권한을 허용하지 않는다. PC 문서 잠금과 중앙 관리자를 연결하는 설치별 권한 정책은 별도 후속 작업이다.

## 실행

Node 24와 Windows의 .NET Framework C# compiler가 필요하다. 저장소 루트에서 실행한다.

```powershell
cd security-lab/admin-passkey
npm.cmd ci --ignore-scripts
node build-windows.mjs
node --test test/auth.test.mjs test/native.test.mjs
node operator.mjs bootstrap
npm.cmd start
```

`http://localhost:43871`에서 최초 관리자 패스키를 등록한다. 일회용 등록권은 로컬 `test-data/operator-result.json`에서 확인하며 로그와 채팅에 붙이지 않는다. CLI 출력 파일은 덮어쓰지 않는다. Windows ACL로 `test-data`를 시험 운영자 계정에 한정해야 하며 POSIX mode 옵션만으로 Windows ACL이 설정되지는 않는다.

복구 입력은 `test-data/recovery-input.json`의 `userId`와 `code` 필드로 준비하고 서버 중지 후 `node operator.mjs recover`를 실행한다. 처리 후 입력·출력 파일을 안전하게 제거한다.

시험 EXE는 `generated/windows/DIANA-LAB-PC/DIANA-LAB-PASSKEY.exe`다. 관리자 인증은 문서 worker 없이 동작한다. 이 빌드는 문서용 Node/Python 런타임과 모델을 재배포하지 않으므로 문서 worker를 사용하려면 이미 준비된 별도 DIANA LAB 번들이 필요하다. 기존 설치본에 덮어쓰지 않는다.

## 검증과 남은 범위

로컬 서버 및 Windows 자동 검사 58개가 통과했다. 실제 컴파일한 Windows 인증 클라이언트를 실행해 loopback 코드 반환·PKCE 교환·DPAPI 저장 및 별도 프로세스 복원·키 폐기 후 차단·서버 중단 시 거부를 확인했다. 추가 회귀 검사에서는 네이티브 세션의 반복 승인 거부, 지연·복수 교환 시 최초 인증 시각 및 절대 만료 계승, 만료 시각 변경 및 이전 출처 없는 세션의 거부를 확인했다. 잘못된 실행 인자는 시험 EXE에서 종료 코드 2로 거부한다.

인증 검증을 성공 mock으로 바꾸지 않고 메모리의 임시 ES256 개인키로 표준 WebAuthn 응답을 만들어 실제 서버 라이브러리로 검증한다. 실제 Windows Hello 및 지문·PIN이나 브라우저 패스키 선택은 자동 검사에 포함하지 않는다. Windows GUI 시각 검사는 도구 실행 승인 시간 초과로 미완료다. GitHub workflow는 별도 Windows 관리자 EXE를 시험 artifact로 제공하며 운영 배포는 하지 않는다.

감사 로그는 시각·고정 작업 종류·성공 여부만 최대 1,000건 보관한다. 토큰, 코드, 서명, PIN, challenge와 문서 내용은 기록하지 않는다. 시험 요청 제한은 프로세스당 1분 120건이며 운영 전에는 계정·접속원별 제한, HTTPS 도메인 및 RP ID, 운영 DB와 ACL, 실제 기기 및 PC 설치별 권한 정책을 검토해야 한다. 운영이 localhost 설정을 그대로 사용해서는 안 된다.

# DIANA 관리자 화면·라우트 준비

운영 배포 전에 복제 환경에서 검토하는 모듈이다. 운영 관리자 도메인과 RP ID는 미정이며, 이 PR은 도메인 생성·운영 DB 연결·기존 앱 교체를 수행하지 않는다. 기존 server.mjs, lib/control.mjs, 설치된 APK·EXE를 수정하지 않는다.

## 주소와 화면

화면은 기존 DIANA APK/PC 앱의 짙은 남색(`#080F1C`, `#111D30`), 청록(`#4CE0D6`), 라일락 포인트와 원래 D 로고를 따른다. 로그인·초대 영역, 상태 카드, 선택 정리와 일반 관리 버튼을 구분한다. 배치는 모바일에서 세로로 전환하고 표는 카드 안에서 가로로 스크롤한다. 상태는 색뿐 아니라 텍스트로 표시하며 키보드 초점·본문 바로가기·동작 줄이기 설정을 지원한다. 원래 앱이나 운영 사이트의 디자인 파일을 수정하지 않고 로고만 복제 모듈에 동일한 바이트로 재사용한다. 인증·권한·재인증·정리 정책은 변경하지 않는다.

- 화면 경로: `/admin/`, 고정 정적 자산도 이 경로 안에서만 제공한다.
- 인증 API 경로: `/admin/api/`. 기존 `/api/` 문서·휴대폰 API에 관리자 토큰을 전달하거나 그 권한으로 변환하지 않는다.
- 최종 URL은 나중에 정할 HTTPS 운영 출처에 `/admin/`를 붙인다. 경로는 WebAuthn Origin/RP ID를 대신하지 않는다. 출처와 RP ID는 호스트 헤더로 추론하지 않고 정확한 값으로 명시해야 한다. [WebAuthn 표준](https://www.w3.org/TR/webauthn-3/).
- 관리자 계정 추가·역할 변경·비활성화, 패스키 등록·폐기, 내 세션 종료, 복구 코드 발급 화면을 제공한다. owner 변경과 중요 작업은 서버의 기존 WebAuthn 재인증 정책을 사용한다.
- 토큰·발급 파일은 페이지 메모리에만 보관하고 새로고침·로그아웃·서버의 인증 거절 시 지운다. 초대권·복구 코드는 화면·URL·쿠키·브라우저 저장소에 출력하지 않고 사용자 클릭으로 JSON 파일을 저장한다. 저장 요청이 실패하면 같은 파일을 다시 내려받을 수 있으며 API를 다시 호출해 코드를 교체하지 않는다. 실제 저장 여부는 다운로드 파일로 확인한다.
- 동기화 패스키를 물리 기기 하나로 표시하지 않는다. 서버 관리자 권한은 PC 문서·근거·Diff·결과 파일·최종 승인을 부여하지 않는다.

## 로컬 미리보기

세션 목록은 만료·종료된 로그인을 숨긴다. 시험 서버는 시작 시 및 1분마다 해당 세션과 연결된 임시 인증 정보를 원자적으로 정리한다. owner 계정·패스키·복구 코드와 활성 세션은 유지한다. 세부 보존·실패 재시도 정책은 `security-lab/admin-passkey/staging/README.md`를 참조한다. 운영용 일반 마운트는 이 작업을 자동 기동하지 않으며 운영 연결은 별도 검토 대상이다.

```sh
cd admin-console
npm ci --ignore-scripts --no-audit --no-fund
npm run preview
```

`http://127.0.0.1:43879/admin/`에서 PC·모바일 배치를 확인한다. 서버는 127.0.0.1에만 바인딩하고 인증 어댑터를 받지 않는다. 모든 관리자 API는 503으로 거절한다. `.env`, 운영 인증 정보, DB URL, 실제 계정이나 문서를 읽지 않는다. 미리보기의 localhost는 운영 패스키의 인증 출처가 아니며 로그인 성공을 시뮬레이션하지 않는다.

## 같은 DIANA 서비스에 연결하는 인터페이스

공개 시험 서버에서는 기존 HTTPS 출처의 `/admin/`에 이 화면을 제공한다. `/admin/config.json`은 기존 시험 Origin/RP ID와 `apiBasePath: '/api/'`를 명시하고, 새 화면은 검증된 기존 시험 인증 엔진·시험 DB의 API를 그대로 사용한다. 브라우저는 `/api/` 또는 `/admin/api/` 두 고정된 같은 출처 경로만 허용하며 외부 API URL을 거절한다. 이전 루트 시험 화면은 제거하고 `/`를 `/admin/`로 이동한다. APK·EXE의 native 경로와 DB 스키마는 유지한다. 이 시험 연결은 운영 배포나 최종 관리자 도메인 확정이 아니다.

아래 운영용 마운트 인터페이스의 `/admin/api/`와 엄격한 TLS/프록시 검사는 그대로 유지한다. 공개 시험 연결은 기존 시험 서버의 Host·HTTPS 전달·Origin·권한 검사로 보호되는 기존 `/api/`를 재사용하며, 운영 프록시의 실제 신뢰 경계가 해결됐다는 뜻으로 표시하지 않는다.

현재 기본 server.mjs는 이 모듈을 import하지 않으므로 병합만으로 활성화되지 않는다. 아래는 검토용 연결 예시이며 운영 엔트리포인트에 적용하지 않았다.

```js
const server = createControlServer(existingOptions);
const consoleHandler = createAdminConsole({
  mode: 'connected',
  auth: reviewedAuthAdapter,
  origin: explicitAdminOrigin,
  rpID: explicitAdminRPID,
  trustedProxyIPs: verifiedImmediateProxyIPs,
});
mountAdminConsole(server, consoleHandler); // 기존 서버의 listen 전에 한 번만
server.listen(existingPort, existingHost);
```

서버 객체·포트·기존 request listener와 종료 시 DB 정리 훅은 유지하며 `/admin` 경로만 별도 처리한다. 중복 마운트, 이미 시작한 서버, 여러 request listener가 있는 서버는 거절한다. 관리자 세션과 기존 user/agent/gateway 토큰은 교환하거나 결합하지 않는다.

어댑터는 검증된 `dispatch(action, body, session)`와 `session(session)` 인터페이스 및 일치하는 origin/rpID를 제공해야 한다. 이 PR의 통합 검사는 기존 검증된 StagingAdminAuth와 **새로운 로컬 PGlite 시험 DB**를 주입한다. 운영 DB 어댑터·스키마 마이그레이션·최초 등록 CLI를 새로 구현하거나 운영 DB에 적용한 것은 아니다. 인증 프로토콜을 복제하지 않고 기존 정책을 재사용한다. 접속원별 제한도 기존 검증된 모듈을 사용한다.

실제 TLS 소켓 또는 명시적으로 허용한 바로 앞 프록시의 HTTPS 전달 헤더가 필요하다. 임의의 X-Forwarded-Proto/For를 신뢰하지 않는다. Host·Origin·JSON 형식·본문 제한·API allowlist를 별도로 검사한다. HTTP 복구·초기 owner 자동 생성·native token 교환 경로는 공개하지 않는다. Native APK·EXE의 운영 인증 경로와 callback/client allowlist 연결은 별도 검토 사항이며 현재 클라이언트 설정은 변경하지 않는다.

## 검증과 남은 운영 준비

```sh
# 저장소 루트와 security-lab/admin-passkey도 각각 npm ci로 의존성을 준비한다.
npm test
npx playwright install chromium
npm run test:browser
```

서버 통합 검사는 격리된 SQLite 문서 제어 DB와 PGlite 관리자 DB만 사용한다. 기존 페이지·API 유지, 관리자 토큰의 문서 API 거절, 기존 토큰의 관리자 API 거절, 정확한 출처/프록시 검증, HTTP 복구 금지, 재인증·권한 변경·폐기·감사 비밀값 제외를 확인한다. 브라우저 검사는 **가짜 인증 응답**으로 UI의 역할 제어·파일 저장 재시도·비밀값 비노출·세션 종료·반응형 배치를 확인한다. 브라우저 테스트는 OS 패스키나 실운영 인증 검증으로 표시하지 않는다.

화면 미리보기를 이미 실행 중이면 `ADMIN_PREVIEW_PORT`를 다른 로컬 포트(예: 43880)로 지정해 검사 서버를 분리한다. 기존 미리보기나 사용자 브라우저 프로필을 테스트에 재사용하지 않는다. 네트워크 단절·서버 오류·인증 거절 시 화면의 관리자 권한과 발급 파일 메모리를 지우며, 오프라인에서 저장된 역할만으로 작업을 승인하지 않는다.

`browser-test/connected.spec.mjs`는 가짜 인증 응답을 쓰지 않는다. 별도 HTTPS 서버·새 파일 기반 PGlite DB·브라우저 CTAP2 가상 인증기를 사용해 실제 등록/인증 서명을 서버가 검증한다. 최초 등록·로그인·DB 재시작 후 세션 유지·admin 초대/등록·권한 변경 후 세션 거절·무권한 승격 거절·시험 키 폐기와 재로그인 차단·복구 코드 해시 보관을 확인한다. 테스트 인증서는 해당 일회용 브라우저에서 **그 인증서 공개키만** pin으로 허용하며 OS 인증서 저장소·운영 검증 옵션을 바꾸지 않는다. TLS 개인키는 메모리에만 두고, 실제 패스키 개인키는 가상 인증기가 보관한다. DB와 임시 공개 인증서는 종료 후 경계 검사한 테스트 디렉터리에서 정리한다. 이는 실제 사용자 지문·PIN 또는 Render PostgreSQL 검증으로 표시하지 않는다. Windows에서는 `ADMIN_TEST_OPENSSL`로 개발용 OpenSSL 실행 파일 경로를 지정할 수 있다.

운영 반영 전에는 최종 HTTPS 주소/RP ID, 검토된 운영 DB 어댑터와 전용 스키마·마이그레이션/롤백, 첫 owner 등록과 신뢰된 복구 CLI 실행 환경, 프록시 실제 신뢰 경계, 모니터링·백업, APK·EXE 서명과 운영 경로 설정을 확정해야 한다. 그 뒤 별도 복제 검증과 운영 반영 승인을 진행한다. 기존 운영 서비스·DB·원문·학습·평가 작업을 이 준비 작업에 사용하지 않는다.

## 선택한 계정 일괄 정리

owner가 계정 체크박스 또는 전체 선택으로 최대 50개를 고른 뒤 `선택한 계정 정리`에서 UUID 목록과 삭제 범위를 확인한다. 복구 불가 확인 체크 후 `패스키 재인증 후 영구 삭제`를 누르면 한 번의 실제 owner WebAuthn 검증으로 `cleanup` 범위의 60초 일회용 grant를 발급한다. 선택 전에는 API 변경을 하지 않으며 검토 창 취소는 삭제와 재인증을 시작하지 않는다. 기존 `manage` grant로 삭제할 수 없다.

서버는 `accounts/purge`에서 현재 owner 권한과 모든 대상의 현재 역할을 검사한다. 본인과 다른 모든 owner는 선택할 수 없으며, owner·누락·중복·잘못된 ID가 하나라도 섞이면 전체 거절한다. 계정, 연결된 인증 등록, web/native 세션과 인증 출처 메타데이터, 발급 코드, 재인증 grant, challenge, 초대/등록권, 복구 해시는 하나의 SERIALIZABLE 트랜잭션으로 삭제한다. 실패하면 전체 롤백하고 기존 세션/복구 정보도 유지한다. 선택하지 않은 계정과 owner의 계정·키·세션·복구 정보는 보존한다.

공통 감사 로그에는 계정 식별자 없이 작업 종류·시각·성공 여부만 남는다. 계정별로 나눌 수 없는 공통 감사 이력과 인증 서비스 설정은 지우지 않는다. 성공 감사도 삭제와 함께 커밋한다. 서버 삭제는 휴대폰/PC 패스키 저장소의 항목을 삭제하지 않으므로 OS의 패스키 정리는 사용자가 별도로 한다.

이전 일회성 시험 초대 파일/휴대폰 키 고정 보조 UI의 staging/index.html과 staging/app.js는 제거했다. 등록권으로 패스키 등록, 일반 관리자 초대, 역할/키/세션 폐기와 복구 코드 보관은 새 관리자 화면에서 계속 제공한다. 최초 owner bootstrap API는 기존 토큰·만료 정책을 유지하며, 새 환경 초기 등록권 발급은 신뢰된 운영자 절차로 수행한다. 최초 등록권을 얻은 뒤 `/admin/`에서 등록한다. 기존 최초 owner가 있는 이번 시험 환경의 등록을 다시 시작하지 않는다.

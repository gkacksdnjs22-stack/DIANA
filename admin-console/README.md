# DIANA 관리자 화면·라우트 준비

운영 배포 전에 복제 환경에서 검토하는 모듈이다. 운영 관리자 도메인과 RP ID는 미정이며, 이 PR은 도메인 생성·운영 DB 연결·기존 앱 교체를 수행하지 않는다. 기존 server.mjs, lib/control.mjs, 설치된 APK·EXE를 수정하지 않는다.

## 주소와 화면

- 화면 경로: `/admin/`, 고정 정적 자산도 이 경로 안에서만 제공한다.
- 인증 API 경로: `/admin/api/`. 기존 `/api/` 문서·휴대폰 API에 관리자 토큰을 전달하거나 그 권한으로 변환하지 않는다.
- 최종 URL은 나중에 정할 HTTPS 운영 출처에 `/admin/`를 붙인다. 경로는 WebAuthn Origin/RP ID를 대신하지 않는다. 출처와 RP ID는 호스트 헤더로 추론하지 않고 정확한 값으로 명시해야 한다. [WebAuthn 표준](https://www.w3.org/TR/webauthn-3/).
- 관리자 계정 추가·역할 변경·비활성화, 패스키 등록·폐기, 내 세션 종료, 복구 코드 발급 화면을 제공한다. owner 변경과 중요 작업은 서버의 기존 WebAuthn 재인증 정책을 사용한다.
- 토큰·발급 파일은 페이지 메모리에만 보관하고 새로고침·로그아웃·서버의 인증 거절 시 지운다. 초대권·복구 코드는 화면·URL·쿠키·브라우저 저장소에 출력하지 않고 사용자 클릭으로 JSON 파일을 저장한다. 저장 요청이 실패하면 같은 파일을 다시 내려받을 수 있으며 API를 다시 호출해 코드를 교체하지 않는다. 실제 저장 여부는 다운로드 파일로 확인한다.
- 동기화 패스키를 물리 기기 하나로 표시하지 않는다. 서버 관리자 권한은 PC 문서·근거·Diff·결과 파일·최종 승인을 부여하지 않는다.

## 로컬 미리보기

```sh
cd admin-console
npm ci --ignore-scripts --no-audit --no-fund
npm run preview
```

`http://127.0.0.1:43879/admin/`에서 PC·모바일 배치를 확인한다. 서버는 127.0.0.1에만 바인딩하고 인증 어댑터를 받지 않는다. 모든 관리자 API는 503으로 거절한다. `.env`, 운영 인증 정보, DB URL, 실제 계정이나 문서를 읽지 않는다. 미리보기의 localhost는 운영 패스키의 인증 출처가 아니며 로그인 성공을 시뮬레이션하지 않는다.

## 같은 DIANA 서비스에 연결하는 인터페이스

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

운영 반영 전에는 최종 HTTPS 주소/RP ID, 검토된 운영 DB 어댑터와 전용 스키마·마이그레이션/롤백, 첫 owner 등록과 신뢰된 복구 CLI 실행 환경, 프록시 실제 신뢰 경계, 모니터링·백업, APK·EXE 서명과 운영 경로 설정을 확정해야 한다. 그 뒤 별도 복제 검증과 운영 반영 승인을 진행한다. 기존 운영 서비스·DB·원문·학습·평가 작업을 이 준비 작업에 사용하지 않는다.

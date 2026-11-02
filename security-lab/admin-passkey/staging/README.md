# DIANA 관리자 HTTPS 시험 환경

이 구성은 `codex/admin-passkey-https-staging` 브랜치에서만 배포한다. 운영 `diana` 서비스, 루트 `server.mjs`, 기존 앱, 문서·학습·평가 데이터는 변경하지 않는다. 이 디렉터리의 서버는 관리자 인증만 제공한다.

## 인증과 권한 경계

WebAuthn/FIDO2의 공개키·서명·challenge·Origin·RP ID·UV 검증을 사용한다. 최초 owner는 256비트 초기 등록 토큰이 있어야 등록을 시작할 수 있다. 서버는 토큰의 SHA-256만 보관하고 첫 DB 초기화부터 1시간 후 만료시킨다. 재시작으로 만료를 연장하지 않는다. 등록 완료 후 초기 토큰으로 관리자를 다시 만들 수 없다. 이후 초대·승격은 owner 권한과 60초짜리 일회용 재인증 grant가 필요하다.

서버 DB에는 계정·역할·공개키·등록 상태·challenge·폐기 상태·세션 해시를 보관한다. 비밀키·생체정보·PIN은 브라우저/OS의 인증기에만 남는다. 동기화 패스키 한 개는 여러 기기에서 사용될 수 있다. 폐기는 인증 등록 전체를 대상으로 한다. 분실한 한 기기만 통제해야 한다면 기기 귀속 보안키 또는 별도 기기 등록을 추가해야 하며, 현재 구성이 기기별 폐기를 제공한다고 표시하지 않는다.

APK·EXE는 시스템 브라우저에서 정확한 HTTPS Origin으로 이동하여 인증한다. localhost는 같은 인증 출처가 아니다. EXE의 `127.0.0.1:<임의포트>` 콜백은 PKCE 코드를 전달하는 역할만 한다. Android는 별도 scheme `kr.nightdesk.phone.lab.passkey.stage://oauth2/callback`을 사용한다. 콜백의 state·redirect·PKCE를 검증하고 코드는 한 번만 소비한다. 코드 가로채기만으로 토큰을 교환할 수 없다.

네이티브 세션은 실제 WebAuthn 시각과 최초 15분 절대 만료를 계승한다. 네이티브 세션으로 새 인증을 승인할 수 없고 refresh token도 없다. 인증 등록 폐기·계정 비활성화·권한 변경은 기존 세션을 무효화한다. 마지막 유효 owner 제거는 거절한다. Android 반환 처리는 Activity 밖의 기존 프로세스 소유 controller를 사용한다.

서버 관리자 인증은 특정 PC의 문서 접근·작업 승인 권한을 부여하지 않는다. 원문·근거·Diff·결과 파일·최종 승인은 PC에 유지한다. 서버 장애·오프라인일 때 새 관리자 로그인·서버 권한 작업은 실패하며 저장된 토큰만으로 승인하지 않는다. PC의 기존 로컬 문서 기능은 이 서버에 연결하지 않는다.

## 별도 Render 배포

대상 DB: `diana-admin-stage` / `dpg-dbk9huuc6qcc73duefng-a` / `diana_admin_stage`, Singapore, PostgreSQL 18, free. 외부 접속 허용 목록은 비워 두었다. 무료 DB 만료는 2026-12-02이며 실제 시험 자료만 사용한다.

`staging/render.yaml`은 기존 시험 DB를 `fromDatabase.connectionString`으로 참조해 DB 비밀번호를 소스·채팅·클라이언트에 복사하지 않는다. 새 서비스는 `diana-admin-passkey-stage`, Singapore/free, 자동 배포 off다. 운영 리소스를 이 Blueprint에 포함하지 않는다.

Render 내부 DB는 같은 워크스페이스·리전의 사설망에서만 접속한다. 내부 연결은 플랫폼 사설망 전송을 사용하며 이 경우에만 PostgreSQL TLS를 사용하지 않는다. `render-private` 모드는 Render 실행 표시와 지정한 시험 DB 호스트가 모두 일치해야 한다. 외부 DB URL 모드는 항상 신뢰할 수 있는 TLS 인증서를 검증하며 `sslmode`로 우회하지 못한다. 휴대폰·PC의 HTTPS 인증서 검증은 기본 OS 검증을 유지한다. 관련 플랫폼 설명: [Render PostgreSQL 연결](https://render.com/docs/postgresql-creating-connecting), [Blueprint 참조](https://render.com/docs/blueprint-spec).

1. 운영 폴더 밖의 `staging/private/`에 초기 토큰을 생성한다. 토큰은 32바이트 난수의 base64url이며 공개하지 않는다. SHA-256만 `ADMIN_BOOTSTRAP_SHA256`에 입력한다.
2. Render에서 이 브랜치의 `security-lab/admin-passkey/staging/render.yaml`로 새 Blueprint를 준비한다. 기존 운영 서비스는 선택하지 않는다.
3. 실제 생성 URL이 `profile.json`의 Origin과 일치하는지 확인한다. Render가 다른 hostname을 배정하면 서버 Origin/RP ID와 클라이언트 profile을 함께 바꾸고 다시 빌드한다. 다른 도메인의 패스키는 새로 등록한다.
4. `/healthz`가 DB ready인지 확인한다. 초기 토큰으로 웹의 최초 관리자 등록을 시작하고 실제 패스키 등록은 사용자가 OS 화면에서 직접 완료한다.
5. owner는 추가 인증 수단과 일회용 복구 코드를 미리 준비한다. 테스트용 APK·EXE에서 Wi-Fi/모바일 데이터로 로그인한다. USB/ADB/포트 역방향 연결은 필요 없다.

## 복구

HTTP 복구·계정 자동 승격 경로는 없다. 미리 발급한 복구 코드의 해시만 DB에 저장한다. 모든 키 분실 시 인프라 운영자가 시험 사설망의 신뢰된 실행 환경에서 `operator.mjs recover <새로운 비공개 출력파일>`에 `{userId,recoveryCode}` JSON을 표준입력으로 전달한다. 코드 일회 사용·기존 키 및 세션 폐기·등록 ticket 10분 만료를 적용한다. 사용자가 새 키를 등록하면 나머지 복구 코드를 지운다. 코드를 명령 인자나 환경변수에 넣지 않는다. 복구 코드도 잃었다면 인증을 우회하지 않고 별도 조직의 신원 확인·새 환경 재구축 절차를 수행한다. 무료 Render에는 운영 shell이 없으므로 인프라 운영용 실행 환경 확보는 운영 전 필요 사항이다. 서버는 개인키를 백업하지 않는다.

## 검증과 배포 전 남은 확인

로컬 PostgreSQL 엔진(PGlite) 검사는 `node --test staging/staging.test.mjs`, 기존 정책 검사는 `npm test`다. PGlite 검사는 실제 Render 네트워크/DB 검증을 대체하지 않는다. 실제 서버 배포 후 ready·잘못된 Origin 거절·PKCE 교환·폐기 후 세션 차단·서버 재배포 후 등록 유지와 실제 OS 패스키 로그인까지 별도 확인한다.

클라이언트 생성은 `node staging/build-clients.mjs windows|android`다. 생성물만 바꾸고 원래 앱 소스와 서명키를 덮어쓰지 않는다. APK는 별도 package이며 시험용 debug 서명이다. EXE는 독립된 관리자 로그인 도구이며 문서 실행기를 포함하지 않는다. 일반 배포 전 APK 서명키를 안전하게 고정하고 EXE 코드 서명·복구 운영환경·속도 제한·모니터링·백업/유료 DB 정책을 검토해야 한다.

감사 로그는 작업명·시각·성공 여부만 최대 1000행 보관한다. 인증 응답·토큰·등록 ticket·복구 코드·문서 내용은 기록하지 않는다. GitHub artifact에도 비밀키·DB URL·초기 토큰을 넣지 않는다.

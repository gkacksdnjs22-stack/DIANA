# 2026-11-02 시험 기록

- 기준 main: `c69ac8f7efdaf8d6cc4eaeba8c6b19c2eb500af9` (PR #17/#18 병합 후).
- PGlite PostgreSQL 엔진에서 staging 검사 **15/15 통과**. 공개키 등록·로그인, PKCE, 인증 시각·절대 만료 계승, 네이티브 토큰 재승인 차단, 권한 변경·키 폐기 후 세션 차단, 재인증·마지막 owner, 복구 코드 일회 사용, assertion 동시 재사용, 다른 Origin/RP/UV/서명/crossOrigin 거절, 디스크 재오픈 후 등록·폐기 상태 유지, 문자열 ID 보존, HTTPS proxy/Host/Origin·초기 등록 보호·감사 비밀값 제외 확인.
- Windows HTTPS 전용 EXE와 probe 컴파일 성공. RFC7636와 잘못된 콜백 거절 probe selftest 통과. 실제 HTTPS 서비스 로그인은 배포 후 확인 대상.
- 별도 Android APK 빌드 성공, **58개 단위 검사 실패 0**. HTTPS Origin과 새 callback scheme을 생성물에 적용했다. 기존 2개 설치 앱에 설치·교체 작업을 하지 않았다. 이 APK의 실제 OS 패스키 로그인은 서버 배포 후 사용자가 확인해야 한다.
- 기존 검사 최초 재실행은 **57/58 통과**, 나머지 Windows EXE 통합 검사는 기존 사용 중인 localhost:43871과 충돌(EADDRINUSE)하여 실행 불가했다. 기존 서버를 종료하거나 변경하지 않았다. GitHub Windows CI에서는 빌드 후 이 통합 검사를 실행한다. Linux CI는 해당 Windows 전용 항목을 제외한다.
- Render에 새 Singapore/free PostgreSQL 18 `diana-admin-stage` 생성, available 확인. 외부 IP 허용 목록 없음. 따라서 connector의 외부 SQL 검사는 연결이 거절되었다. 실제 Render DB SQL/HTTP 영속성 검증을 완료했다고 보고하지 않는다.
- 운영 `diana` 서비스와 기존 DB, 앱·학습·평가 작업은 배포 대상에 포함하지 않았다. 새 HTTPS 서비스는 Blueprint 배포 완료와 실제 health 확인 전까지 미완료다.

원본 실행 로그·APK·EXE·초기 토큰은 gitignored 생성/비공개 디렉터리에 보관하며 PR에는 넣지 않는다. Blueprint UI의 최종 공개 서비스 생성은 브라우저 도구의 보안 민감 접근 생성 확인 정책에 따라 구체적인 배포 화면을 준비한 뒤 확인한다.

## PR #19 리뷰 수정 검증

`efa846f`에 대한 두 P2 지적을 수정했다. 복구 출력은 DB 변경 전에 독점 생성하고, 기록·fsync·닫기까지 외부 DB 트랜잭션 안에서 수행한다. 전역 분당 120회 제한은 접속원별 익명 조회/인증과 검증된 계정별 한도로 분리했다. 프록시 전달 주소는 명시적으로 신뢰한 peer만 처리한다.

복제 환경의 전체 PostgreSQL/PGlite 검사는 **20/20 통과**했다(29.2초). 추가 5개 검사는 다음을 확인했다.

- 기존 출력 파일·없는 디렉터리·권한 오류, 부분 기록 후 ENOSPC, fsync·닫기 실패를 반복해도 복구 코드 2개·활성 키·원래 세션이 유지된다. 불완전 파일은 정리되고 기존 파일은 보존된다. 이어서 정상 복구·출력 ticket 등록·재로그인 성공, 사용한 코드 재사용 거절.
- 접속원 A의 소진이 접속원 B·다른 요청 종류·검증된 관리자 계정의 한도에 영향을 주지 않는다. 만료/메모리 상한 처리 확인.
- 비신뢰 peer의 위조 X-Forwarded-For 무시, 명시적 프록시 체인의 우측 검사, IPv4-mapped/IPv6 정규화 확인.
- 실제 HTTP에서 익명 GET 120회 이후 429, 위조 헤더로 우회 불가, 새 로그인 시작 성공. 이어서 익명 API/가짜 Bearer 한도도 소진한 후 owner 상태 조회·목록·재인증 grant를 이용한 관리자 초대 성공.
- 프록시를 모사한 실제 HTTP에서 접속원 A의 인증 30회 소진 후 공격자 prefix로 우회 불가, 접속원 B 인증 요청 성공.

실제 Render DB·공개 HTTPS·Render 프록시 체인·OS 패스키 흐름은 여전히 미검증이다. 시험/운영 서비스 배포, 기존 앱 교체는 수행하지 않았다.

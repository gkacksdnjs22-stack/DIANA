# 금융 문서 앱 연결 검증 결과 — 2026-10-27

로컬 구현과 검증 결과다. 최초 검증 당시에는 운영 Render 배포, Git push, APK 업로드, 실기기 설치를 수행하지 않았다. 이후 사용자 요청으로 APK 한 개를 DIANA에 전달했고 금융 기능 소스는 별도 브랜치에 커밋하도록 정리했다. 운영 주소 `https://diana-pzw3.onrender.com` 및 기존 페어링 구조를 유지한다. 운영에서 새 모드가 동작한다고 보고하는 문서가 아니다.

## 구현 결과

Android ≡ 메뉴에 ‘금융 문서 작업’을 추가했다. PC 등록 작업 → 검토/보완/변환 → 허용 형식 → 요청 확인 → 상태 갱신 → 저장 전 취소를 지원한다. 화면에 ‘문서 내용 확인과 최종 승인은 PC에서 진행합니다’를 표시하며 결과 파일 열기/공유/다운로드/최종 승인 기능은 없다. 금융 상태는 기존 다운로드 캐시에 합치지 않는다. 요청 ID/본문/공개 서버·휴대폰 식별자의 binding만 별도 재시도 설정에 저장한다.

서버는 기존 인증·페어링·영속 settings 어댑터를 사용하며 `finance:v1:` 네임스페이스로 일반 jobs와 분리한다. 허용 필드/상태 코드와 전체 실행 절차는 [financial-mobile.md](financial-mobile.md)에 있다. 공개 응답을 개별 필드로 구성하며 코어 객체를 서버에 전달하지 않는다.

전용 금융 worker는 기존 FinancialDocuments와 Python 코어를 수정 없이 재사용한다. 한 인스턴스/한 활성 계획, 로컬 TTY 승인, 저장 시작 CAS, 실제 execute·재읽기 확인, 영속 메타데이터 outbox를 연결했다. 기존 일반 에이전트는 수정/재시작하지 않았다.

`scripts/financial-dev.mjs`를 실제 테스트용 TTY에서 시작해 임시 localhost 서버와 금융 대기 콘솔이 켜지는 것을 확인했고, `exit` 입력 후 종료 코드 0으로 자신이 만든 서버/worker만 종료됐다. 이 시작·종료 검사는 사용자의 문서 최종 승인 재현과는 별개다.

## 실제 검증

| 검사 | 결과 |
|---|---|
| 기존 서버·전송·페어링·push·영속 저장·코어를 포함한 Node 회귀 실행 | 196개 통과, 실패/스킵 0 |
| 최종 금융 연결 전용 Node 실행 | 16개 통과, 실패/스킵 0; 앞의 회귀 검사와 중복 포함, 합산하지 않음 |
| Python 금융 코어 | 21개 통과 |
| 기존 금융 문서 변환 왕복 | 6개 경로 VERIFIED, findings=[] |
| Android JVM 단위 테스트 | 9개 클래스, 50개 통과, 실패/오류 0 |
| Android debug 앱·계측 테스트 APK 빌드 | BUILD SUCCESSFUL |
| 기존 코어·학습 소스·가상 자료·기존 데모 설정/결과 보호 표본 | 전후 SHA-256 200개 동일 |

Node 정상 흐름은 실제 loopback HTTP, 기존 pair-code/phone-token 인증, SQLite 파일, 기존 Python 코어를 사용했다. 가상 보완 요청을 prepare한 시점에는 확정 출력 파일이 없고, 테스트용 로컬 승인 후에만 파일이 하나 생성됐다. 재읽기 결과에 보완 내용과 미해결 LPAC 안내가 존재하며, 앱용 상태는 LOCAL_SAVE_COMPLETED/saved=true/reviewComplete=false였다. 하네스 승인은 사용자 직접 승인으로 계산하지 않는다.

승인 대기 중 후속 작업은 QUEUED를 유지했다. 다른 휴대폰의 조회/취소, 휴대폰의 agent API, agent/gateway의 모바일 API, 다른 worker/generation/revision, 서버 PC 귀속 변경을 이용한 접근을 거부했다. confirmed/token/role/owner/device/문서 경로 등의 필드, 중복 JSON 키, 미등록 작업/형식, 원격 승인·실행 경로도 거부했다.

완료 ACK 유실 후 서버를 재시작하고 동일 보고를 재전송해도 저장 파일과 실행 게이트는 각각 1개였다. 저장 시작 ACK가 모호하면 execute를 재개하지 않고 UNCERTAIN이 됐다. 승인 대기 ACK 유실 후 취소된 경우에도 outbox가 현재 CANCELLED 상태를 받아들이고 후속 작업으로 넘어갔다. 원문·정책·승인 만료 변경은 저장을 막았고, PC 재시작은 기존 승인을 복구하지 않았다. 저장 시작 직후 실제 HTTP 취소 요청은 LOCAL_SAVING을 반환했고 최종 실제 저장 결과를 유지했다. 출력 경로를 미리 점유한 I/O 장애에서는 기존 파일을 덮어쓰지 않고 UNCERTAIN/saved=false를 반환했다. 기존 어댑터 테스트의 부분 쓰기·재읽기·claim/감사 기록 실패 검사도 통과했다.

정상 흐름의 실제 HTTP 요청/응답과 서버 settings 기록을 수집해 가상 본문 canary, 로컬 문서/근거/지침/항목 ID, 실제 로컬 경로/파일명, 인용, expected_body/output_content/unified_diff/plan_hash/approval_id, 콘솔 계획에 있던 64자리 해시들이 없는지 검사했다. 의도적인 금지 필드 주입은 localhost 부정 테스트로만 보냈으며 응답과 영속 기록에 canary가 남지 않았다. 일반 jobs/agent 큐는 비어 있고 금융 ID의 일반 download/artifact/file 접근은 거부됐다. 원문 canary와 상세 계획은 PC 전용 출력에서만 확인했다.

## Android 산출물

- 버전: 0.3.7, versionCode 10, package kr.nightdesk.phone.
- Gradle 원본: `C:\work\diana\android-app\app\build\outputs\apk\debug\app-debug.apk`.
- 기존 설치와 같은 인증서로 로컬 재서명한 APK: `C:\work\diana\.local\financial-mobile-verification\DIANA-0.3.7-finance.apk`.
- APK 크기: 4,128,230 bytes.
- APK SHA-256: `bc62c0a81162d1fadeab93f95f5677530c89470c0f2d72940ed689fa7806c7ed`.
- 인증서 SHA-256: `9e9e61c36d0657e0cfe86b5f542b634e723c050664f6c0102281e9e7287877b9`.
- 서명·정렬·원본 payload 보존 검증 통과. 기존 `앱-설치/DIANA-debug.apk`는 교체하지 않았다.
- JVM 결과: `android-app/app/build/test-results/testDebugUnitTest/`.
- 계측 APK: `android-app/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk`.

공식 JDK 17, Gradle 8.11.1, Android SDK 기본 API 35를 작업 폴더에 내려받아 체크섬을 확인하고 로컬 빌드했다. platform-tools/에뮬레이터가 설치되지 않은 경고가 있지만 단위 테스트·두 APK 빌드는 성공했다. **계측 테스트는 컴파일만 했고 실행하지 않았다.** Android 실화면·실제 SharedPreferences 저장 내용·실기기 상태 갱신은 아직 실행 검증하지 않았다. 이 부분을 소스 계약 검사나 JVM 테스트와 혼동하지 않는다.

왕복 보고서: `C:\work\diana\.local\financial-roundtrip\run-RnAhmB\report.json`. 기존 기준 파일과 감사/승인 기록은 변경하지 않았다. 보호 표본 결과: `.local/financial-mobile-verification/protection-result.json`.

## 이번 변경 파일

- 서버: `lib/control.mjs`에 모듈 연결, 새 `lib/financial-contract.mjs`, `lib/financial-control.mjs`.
- PC: 새 `financial-documents/remote-worker.mjs`, `worker-cli.mjs`.
- 실행: `scripts/init-financial-mobile-demo.mjs`, `scripts/financial-dev.mjs`, package.json에 finance 실행/검사 명령 3개 추가.
- Android: MainActivity.java 메뉴·화면·별도 상태 폴링, 새 FinanceRequests.java/FinanceState.java, app/build.gradle의 버전 갱신.
- 검사: `tests/financial-mobile.test.mjs`, Android FinanceStateTest.java/FinanceContractTest.java.
- 문서: `docs/financial-mobile.md`, 이 보고서.

처음부터 존재한 미커밋/미추적 변경은 보존했다. 위 목록은 이번 작업 범위이며 git diff 전체를 이번 작업으로 간주하지 않는다. 학습 코드/데이터/체크포인트/선택 프로필/active manifest를 편집하지 않았고 학습·모델·독립 시험을 실행하지 않았다. 초기에 실패한 이번 Node 테스트 프로세스만 정확한 PID와 실행 명령을 확인해 정리했으며 기존 에이전트나 학습 프로세스를 종료하지 않았다. OS 서비스/자동 시작/방화벽도 변경하지 않았다.

## 사용자가 다음에 수행할 일

커밋 후보는 GitHub main 원본과 금융 기능에 필요한 소스·가상 fixture만 조합한 별도 폴더에서 검증했다. 이 폴더의 전체 Node 테스트 375개가 통과했으며 학습·독립 시험은 포함하지 않았다. package.json은 기존 main에 금융 명령 3개만 추가한 버전으로 구성했다. 금융 코어와 그 파일 정책 의존성은 main에 없어서 실행에 필요한 기존 소스도 함께 포함한다. 학습 코드·데이터·모델·로컬 설정·감사 기록·사용자 문서·APK는 커밋 대상에서 제외한다.

1. [실행 안내](financial-mobile.md)의 새 가상 자료 설정 생성 후 로컬 개발 콘솔을 실행한다. 이번에 만든 예시는 `.local/financial-mobile-demo-b196890e-5cae-4cf0-86c3-aca799885c9e/worker.json`이다.
2. 별도 에뮬레이터/테스트 앱 연결로 금융 작업을 요청하고 PC 콘솔에서 직접 상세 확인·approve 입력을 재현한다. 기존 운영 휴대폰 연결은 불필요하게 초기화하지 않는다.
3. 운영 적용을 결정하면 기존 Render 서비스에 `lib/control.mjs`의 금융 연결, 새 금융 계약/제어 모듈, 의존하는 `financial-documents/strict-json.mjs`를 반영해야 한다. 다른 작업의 미커밋 변경까지 일괄 배포하지 않는다. 신규 DB 테이블·외부 서비스는 필요 없다.
4. PC에는 기존 금융 코어와 전용 worker, 검토한 로컬 등록 설정이 필요하다. 서버를 계속 운영해야 하며 서버 배포만으로 PC worker가 켜지지는 않는다.
5. 서버 반영 후 새 APK 설치와 실제 화면·취소·상태 갱신을 확인한다. 새 금융 API가 없는 서버에서는 앱이 미지원 안내를 표시하며 일반 전송으로 우회하지 않는다.

운영 배포·PC 운영 worker 연결·실기기 검사·실제 Supabase 재시작에 대한 금융 모드 종합 검사는 미실행이다. 기존 Supabase 어댑터 회귀 검사는 가짜 Postgres 풀로 실행했으며 실제 서비스의 보장으로 과장하지 않는다. OS 전체 격리나 금융 규정 준수도 이번 검증 범위가 아니다.

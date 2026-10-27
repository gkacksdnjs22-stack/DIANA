# DIANA 금융 문서 작업 연결

기존 Java Android 앱, 제어 서버, 페어링 인증을 재사용한다. 금융 작업은 별도의 API와 `settings`의 `finance:v1:` 전용 영속 네임스페이스에 저장한다. 기존 `jobs`, 문서 catalog, 다운로드, artifact, push 큐에 넣지 않는다. 기존 Supabase 영속 어댑터의 settings 미러/응답 전 flush를 그대로 사용하므로 신규 DB 테이블 마이그레이션은 없다. 기존 서버의 단일 소유자·단일 PC 배치 범위를 유지하며 다중 테넌트 지원을 주장하지 않는다.

## 정보 경계

모바일/서버에 허용되는 내용은 PC 사용자가 명시적으로 공개한 일반 작업 표시명, 랜덤 UUID 작업 식별자, 작업/형식 enum과 최소 상태다. 파일명/경로에서 공개 ID를 만들지 않는다. 원문, 문단, 근거, 항목명/ID, 미해결 상세, Diff, expected_body, output_content, 문서 해시, plan_hash, 승인 토큰/ID, 결과 경로/파일은 PC 전용이다.

`publicTask`, `publicFinanceJob`는 개별 필드로 새 응답을 만든다. 코어 객체를 네트워크 객체에 펼치지 않는다. 금융 API는 모르는 JSON 필드·중복 키·쿼리 문자열·과도한 본문을 거부하며 오류에는 고정 코드만 사용한다. 작업에 대한 휴대폰 소유권은 인증된 phoneId, PC는 서버 설정의 deviceId와 agent 인증으로 결정한다. 앱이 owner/device/role/document/path를 지정할 수 없다. 공개 작업 목록은 이 단일 소유자의 페어링된 기기에 공개되며, 개별 작업은 요청한 기기에만 조회·취소 권한이 있다.

금융 모드에는 파일 선택/업로드/다운로드/공유나 최종 승인 버튼이 없다. 전용 worker는 일반 agent/run.mjs를 실행하거나 가져오지 않는다. 외부 AI·메일·파일 전송·catalog·push 코드도 가져오지 않는다. 금융 입력/출력/상태/설정 경로가 일반 DOCUMENT_ROOT에 노출되거나 금융 루트와 겹치면 worker 시작을 거부한다. DOCUMENT_ROOT나 로컬 정책을 나중에 임의 변경하여 다른 프로그램이 파일을 읽는 행위를 OS 차원에서 차단하는 기능은 아니다.

## 정확한 네트워크 계약

기존 Bearer 인증과 HTTPS 서버를 사용한다. 모바일은 기존 phoneToken, PC는 기존 AGENT_TOKEN이다. 승인용 네트워크 엔드포인트는 없다.

| 경로 | 메서드/권한 | 요청 본문 |
|---|---|---|
| `/api/financial/tasks` | GET 휴대폰/owner | 없음 |
| `/api/financial/jobs` | GET 휴대폰/owner | 없음 |
| `/api/financial/jobs` | POST 휴대폰/owner | `requestId, taskId, action, format` |
| `/api/financial/jobs/:id` | GET 요청한 기기 | 없음 |
| `/api/financial/jobs/:id/cancel` | POST 요청한 기기 | `{}` |
| `/api/agent/financial/register` | POST agent | `workerId, tasks` |
| `/api/agent/financial/next` | POST agent | `workerId` |
| `/api/agent/financial/jobs/:id/observe` | POST agent | `workerId` |
| `/api/agent/financial/jobs/:id/status` | POST agent | `workerId, generation, revision, reportId, state, code, saved, reviewComplete` |

등록 tasks의 각 객체는 정확히 `id, label, actions, formats`다. tasks 조회 응답은 `supported, online, tasks, updatedAt`이다. 최대 20개 등록, 표시명 40자, 작업은 `checklist_review/patch/convert`, 형식은 `md/txt/json`이다. PC 내부 설정에서만 target_doc/source_ids/guideline_id/item_ids 및 로컬 역할/정책에 연결한다.

모바일 작업 객체는 정확히 `id, taskId, action, format, state, code, saved, reviewComplete, revision, createdAt, updatedAt, expiresAt`다. 목록은 `{jobs:[...]}`, 개별/생성/취소/상태 응답은 `{job:...}`이다. PC next의 job에만 `generation, workerId`가 추가된다. register 응답은 `{ok:true}`다. 금융 요청 오류는 `{code:"FINANCIAL_REQUEST_REJECTED"}`다. 인증과 영속 저장 자체가 실패하는 기존 서버 공통 경계의 고정 오류도 존재한다. 요청/응답 원문 로그를 새로 추가하지 않았다.

고정 code 허용 목록은 `PC_QUEUED, PC_PROCESSING, PC_CHECK_REQUIRED, PC_INFORMATION_REQUIRED, PC_SAVING, PC_SAVED, PC_REVIEWED, USER_CANCELLED, PC_REJECTED, LOCAL_CHECK_FAILED, LOCAL_OPERATION_FAILED, RECOVERY_REQUIRED, REQUEST_EXPIRED, POLICY_CHANGED, NO_CHANGE_REQUIRED`다. 로컬 오류 원문으로 code를 생성하지 않는다. 금융 알림은 이번 버전에서 발송하지 않는다.

| 서버/앱 상태 | 의미·PC 코어 대응 |
|---|---|
| QUEUED | PC 수신 대기; 만료 24시간 |
| PROCESSING | 등록 작업 매핑/prepare |
| PC_REVIEW_REQUIRED | 코어 AWAITING_APPROVAL; 로컬 콘솔 확인 필요 |
| WAITING_FOR_INFORMATION | ACTION_REQUIRED/CLARIFICATION_REQUIRED; PC에서 상세 확인 |
| REVIEW_COMPLETED | READY 결과; 새 저장 없음. ALREADY_SATISFIED도 여기 해당 |
| LOCAL_SAVING | 로컬 승인 후 서버 저장 시작 게이트 통과; 원격 취소 불가 |
| LOCAL_SAVE_COMPLETED | execute COMPLETED + saved + storage_verified 확인 |
| CANCELLED | 저장 시작 전 취소 또는 PC 거절 |
| BLOCKED | 정책·원문·승인 유효성·만료·재시작 등 로컬 확인 필요 |
| FAILED | 준비 실패; 공개 응답에 원문 오류 없음 |
| UNCERTAIN | 저장 경계/기록/응답 유실로 실제 파일과 기록을 PC에서 확인해야 함 |

`saved`는 LOCAL_SAVE_COMPLETED일 때만 true다. `reviewComplete`는 별도 코어 판정이며 저장 완료와 동일하지 않다. 가상 보완 사례는 저장해도 LPAC 미해결이므로 false다. 보완 완료로 전체 검토 완료라고 표시하지 않는다.

## PC 실행·승인·복구

한 FinancialDocuments 인스턴스가 한 번에 하나의 활성 작업만 준비한다. 폴링/후속 큐 작업은 대기 중인 계획을 prepare로 덮어쓰지 않는다. 등록 설정과 코어 정책을 재검사하며, 기존 prepare → approve → execute 및 저장 직전 원문 재검사를 그대로 사용한다.

전용 콘솔에는 로컬 대상/원문/근거/출처/전체 계획/실제 출력/Diff/미해결 상세가 표시된다. JSON으로 제어 문자를 이스케이프하며 문서나 네트워크 텍스트를 명령으로 평가하지 않는다. 실제 TTY 터미널에서만 worker-cli를 실행할 수 있고 승인 입력은 다음 형식이다.

```text
approve 현재_서버_요청_UUID
reject 현재_서버_요청_UUID
cancel 현재_서버_요청_UUID
exit
```

콘솔이 가진 현재 계획과 정확한 요청 ID를 확인한 다음, 어댑터가 내부 planId/planHash를 재검사하고 로컬 승인 토큰을 발급한다. 토큰/승인 ID는 통신이나 worker journal에 넣지 않는다. 해시를 원격에서 전달하는 승인 API는 없다. 자동 승인 옵션도 없다. 테스트의 `localCommand()` 호출은 명시적인 테스트 하네스 승인이지 사용자 직접 승인이 아니다.

로컬 승인 직후 상태 revision/generation CAS로 LOCAL_SAVING을 확정한다. 취소가 먼저 반영되면 게이트가 거부되고 저장하지 않는다. 게이트 이후 취소는 현재 상태를 반환하며 저장을 삭제/취소했다고 주장하지 않는다. 실제 저장·재읽기가 확인돼야 완료를 보고한다.

worker journal은 요청 메타데이터/단계/미전송 상태 보고만 fsync 후 rename으로 기록한다. 상태 ACK가 유실되면 동일 reportId/본문을 재전송한다. 문서 execute를 다시 호출하지 않는다. 게이트 ACK가 모호하면 실행을 재개하지 않고 UNCERTAIN으로 전환한다. 실제 코어 저장의 영속 claim/감사 기록도 그대로 유지한다.

90초 heartbeat가 끊기면 준비/승인 대기는 BLOCKED, 저장 중은 UNCERTAIN이다. 이전 worker의 늦은 상태 보고는 덮어쓰지 못한다. 재시작 시 승인 토큰을 복원하지 않으며 기존 요청을 자동 재실행하지 않는다. PC에서 기록을 확인하고 필요하면 새로운 요청과 새로운 승인을 만든다. worker.lock은 살아 있는 PID나 판별 불가 PID가 있으면 시작을 거부하며, 죽은 PID가 확인되면 기존 lock을 보존하고 새 세션으로 시작한다. 다른 프로세스를 종료하지 않는다.

UNCERTAIN은 PC의 worker journal, 출력 폴더, `.financial-ledger`의 claim/완료/감사 기록과 파일 재읽기를 확인해야 한다. 이 버전은 불확실한 저장을 자동으로 완료 처리하거나 다시 실행하지 않는다. 요청은 서버당 최대 500개 보존하며 한도 도달 시 429로 거절한다. 이 버전에는 원격 기록 삭제/보관 정리 API가 없다.

## 로컬 재현

새 가상 자료 설정을 생성한다. 기존 demo/사용자 문서/승인 기록은 덮어쓰지 않는다.

```powershell
cd C:\work\diana
node scripts/init-financial-mobile-demo.mjs --python C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe
```

출력된 workerConfig를 사용해 한 터미널에서 로컬 서버+금융 콘솔을 함께 실행한다. 임시 토큰은 메모리 안에서만 생성되고 콘솔에는 테스트용 5분 연결 코드만 표시한다. 기존 .env와 실행 서버를 사용하거나 변경하지 않는다.

```powershell
npm run finance:dev -- --config C:\work\diana\.local\financial-mobile-demo-생성된UUID\worker.json
```

1. Android 에뮬레이터에서 표시된 서버 주소의 127.0.0.1을 10.0.2.2로 바꾸어 테스트 연결 코드로 페어링한다. 운영 휴대폰 연결은 이번에 초기화하지 않는다.
2. ≡ → 금융 문서 작업 → 가상 검토서 보완 → 보완 → md → 요청 확인.
3. 앱의 PC 확인 필요 상태를 확인한다. 이때 출력 파일이 없는지 PC에서 확인한다.
4. PC 콘솔의 원문·근거·미해결 항목·실제 전체 출력·Diff를 직접 확인한다.
5. PC 콘솔에서 표시된 요청 ID로 `approve UUID`를 입력한다. 승인 유효 시간은 5분이며 지나면 새 요청이 필요하다.
6. PC output의 새 파일과 콘솔의 storage_verified 결과를 확인한다.
7. 앱에서 ‘PC 저장·재읽기 확인’, ‘전체 검토: 미완료 또는 추가 확인 필요’를 확인한다. 결과 파일 버튼은 없다.
8. 별도 요청으로 취소/거절도 확인한다. `exit`는 자신이 만든 로컬 서버/worker만 종료하며 학습 프로세스와 기존 서버에는 영향이 없다.

로컬 서버와 별도로 worker만 실행할 때는 기존 API_BASE_URL/AGENT_TOKEN 설정을 사용한다.

```powershell
npm run finance:worker -- --config C:\work\diana\.local\financial-mobile-demo-생성된UUID\worker.json
```

운영 구성의 API_BASE_URL은 기존 `https://diana-pzw3.onrender.com`을 유지한다. **운영 서버에 새 API를 배포하기 전에는 이 명령을 운영 설정으로 실행하지 않는다.** 서버 미지원은 앱에서 안내하고 일반 전송 경로로 fallback하지 않는다. 새 클라우드 서비스나 금융용 인증키는 필요 없다.

## 검증 명령과 배포 경계

```powershell
node --test tests/financial-mobile.test.mjs tests/financial-documents.test.mjs
python -B -m unittest discover -s tests -p test_financial_core.py
```

Node 통합 테스트는 실제 loopback HTTP·페어링 인증·SQLite 영속 저장·기존 Python 코어·실제 새 파일 저장과 재읽기를 사용한다. 운영 Render, 외부 AI, 메일, 사용자 문서를 호출하지 않는다. 코어 왕복 검증과 기존 전송/서버/페어링 회귀 검사는 별도로 수행한다. 학습/모델/독립 시험 점수로 합산하지 않는다.

Android는 :app:testDebugUnitTest, :app:assembleDebug, :app:assembleDebugAndroidTest를 로컬에서 빌드한다. 계측 테스트 APK 빌드는 계측 테스트 실행이나 실기기 확인과 다르다. 기기에서 실행하지 않은 테스트를 통과로 보고하지 않는다.

후속 배포에는 금융 계약/서버 모듈과 lib/control.mjs 변경을 기존 Render 서비스에 반영하고, PC에 Python 코어·전용 worker·로컬 설정을 준비하며, 새 Android APK를 사용해야 한다. 서버만 바꿔도 금융 worker는 자동으로 실행되지 않는다. 운영 배포·실기기 설치·OS 자동 시작/서비스/방화벽 변경은 수행하지 않는다. 소스 커밋과 APK 전달은 각각 사용자의 별도 요청 범위에서 수행하며, 소스는 운영 main과 분리된 브랜치로 관리한다.

이 구현은 애플리케이션의 데이터 경계와 테스트 결과다. OS 전체 네트워크 격리, 관리자 침해 방어, 금융 규정 준수를 입증한 것으로 설명하지 않는다.

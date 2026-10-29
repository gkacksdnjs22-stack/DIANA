# 실험용 로컬 AI 요청 해석 미리보기 · 0.3.4

현재 상태: 구현·실제 모델 API·번들 의존성 및 최종 실제 브라우저의 주요 흐름·보류 응답 검증 완료. 연구 성능 미달 판정은 유지한다. 모든 실패 상황의 브라우저 검증, 다른 PC 실기기 및 코드 서명 검증까지 완료했다는 뜻은 아니다.

## 사용 흐름

별도 ZIP을 풀어 DIANA.exe를 실행한다. 기존 설치본을 덮어쓰지 않으며 사용 중인 worker는 사용자가 정상 종료한다. 요청 기록 → 새 요청 작성 → 요청문 직접 입력 → 당시 확정 형식 확인 → 기본 꺼짐인 ‘실험용 로컬 AI 해석’ 선택 → ‘AI 해석 보기’를 누른다. 예측은 기존 수동 선택을 자동 변경하지 않는다. 조립 결과가 계약 검사를 통과한 경우에만 ‘선택란에 적용’할 수 있다. 확인·수정 후 기록을 저장하고 상세의 기존 ‘이 선택으로 문서 검토’에서 다시 확인하여 ‘검토 시작’을 눌러야 실제 검토가 실행된다.

보류·취소·nonreview·계약 실패 결과는 원시 head에서 인자를 복구해 적용하지 않는다. 원시 값과 점수는 접힌 진단 영역에 구분한다. 점수는 보정된 정답 확률이 아니다. 입력·후보·설정·수동 선택이 바뀌면 적용을 무효화한다. 15초 제한, 단일 실행, 취소 및 종료 정리를 사용한다. 외부 API/모델 대체·학습은 없다.

## 고정 모델과 입력

28절 Byte seed20261031 final-update1100.npz. 원본은 `.local/financial-review-utf8-input/a9e32f82-990a-4607-bafd-bacb995a957e/20261031/Byte/`다. 배포 사본과 원본 코드 해시는 `financial-documents/local-ai-preview/assets/manifest.json`에 있다. 모델 tensor digest는 `e7b0405d3baac6a25e33b1fce497334c392f6fdd7b2b24a45c619c9d0fc2952c`다. 기존 Byte encode와 원본 model.py/decoder를 사용하며 source 문턱은 0.5다.

모델 stdin은 고정 schema_version과 request/context/candidates뿐이다. 신뢰된 후보 조회에서 ID·이름·alias·역할만 투영한다. 수동 선택, 작업 ID, 정답, 기록 ID, 자료 구분, 검토 결과, 파일 경로·본문은 입력 객체에 포함하지 않는다. 기록 UUID와 사용자 선택 감사는 별도 서비스 메타데이터로만 남는다. 문서 권한·내용은 실제 검토 직전에 기존 경로로 재검사한다.

## 로컬 기록

`stateDir.ai-previews`에 입력/해시, 원시·조립 출력, 구조 검증, 모델 manifest 해시, 시간, 적용 및 사용자 선택 변경 이벤트를 별도로 보존한다. JSON 평문이며 OS 로컬 권한에 의존한다. 기존 요청 기록의 ai_exposure와 annotation_provenance는 AI 결과 열람 후 확인임을 나타낸다. 독립 주석이나 정답으로 자동 승격하지 않는다. AI 감사 폴더는 원래 요청 기록과 별도이므로 현재 요청 기록 삭제 시 자동 삭제되지 않는다. 자동 학습·평가 편입은 없다.

## 검증 및 남은 작업

관련 Node 검사179개 통과. 원본 validation60·진단72는 기존 BLAS 단일 스레드 batch12 실행에서 저장 예측과 정확히 일치했다. 단건 경로는 원시 head와 조립 의미가 모두 동일하고 점수 차이 최대5.364418029785156e-7이 있다. 이 수치 차이를 정확 일치라고 부르지 않는다. 기존 train/개발 성능 미달 판정은 유지한다.

최종 ZIP에는 Python3.12.14, NumPy2.3.5와 필요한 DLL·라이선스를 포함했다. 300개 파일 해시와 소스 일치를 검증했다. 실제 번들의 Windows WorkerSession에서 가상 접수표 요청을 API로 한 번 추론했고 ready/checklist_review 및 구조 계약 통과 응답을 받았다. 이는 의미 일반화나 브라우저 클릭 성공 증거가 아니다. 업무 출력은0개였다.

최초 브라우저 검증은 인앱 브라우저 `browser.user is unavailable` 오류와 대체 Windows 브라우저의 현재 URL 확인 실패로 중단됐다. 당시에는 주요 클릭 검증을 미완료로 보고했다. 이후 아래 별도 실행으로 주요 흐름과 보류 응답을 확인했으며, 서버 API 검사와 순수 UI helper 검사를 브라우저 검사로 대신하지 않았다. 다른 PC 실기기/코드 서명은 미완료다.

산출물: `.local/ai-preview-verification/replay.json`, `regression.log`, `bundle-verification.json`, `run-ef703cdb-85ba-4431-9b5c-7ed28ea41fb5/actual-bundle-api-inference.json`, 해당 실행의 `runtime-result.json`.

## 실제 브라우저 후속 검증 (2026-10-28)

기존 ZIP을 푼 `verified-zip/DIANA-PC`의 300개 파일 해시를 확인하고, 별도 가상 자료·가짜 연결 키·localhost 중계와 실제 Windows `WorkerSession`으로 실행했다. 기존 설치본·공용 설정·사용 worker·제품 코드·연구 모델은 변경하지 않았으며 ZIP도 다시 빌드하지 않았다.

인앱 브라우저에서 다음을 직접 확인했다.

1. 최근 업무 요청 0건에서 새 기록을 열면 AI가 기본 꺼짐이며 추론 버튼도 비활성이다.
2. 가상 접수표 요청을 고정 Byte 모델에 실제 추론하면 `ready/checklist_review`, 대상 `REVIEW_A`, 근거 `DD_A`, 지침 `PE-02`가 표시된다. 적용 전 수동 선택 세 필드는 모두 unknown이었다.
3. ‘선택란에 적용’을 눌렀을 때만 초안이 들어간다. 이후 의도를 question으로 직접 바꾸자 기존 제안이 무효화됐다. 이 변경은 수정 가능성과 별도 검토 확인을 점검하기 위한 의도적인 가상 UI 조작이며 의미 정답 주석이 아니다.
4. 사용자 재확인 후 기록을 저장하면 `user_confirmation_after_ai_preview`와 AI 열람 이력, 부분 계약 주석이 보존된다. 기록 상세에서 별도로 현재 문서 상태를 확인하고 확인란·‘검토 시작’을 눌러야 검토 코어가 실행된다.
5. 검토 결과는 FX_HEDGE 충족, KEY_MAN 근거 있는 보완 필요, LPAC 근거 부족으로 표시됐다. 미해결 항목과 실제 근거도 확인했다.
6. 문서를 언급하지 않은 가상 설명 요청은 실제 추론에서 unsupported/question으로 반환됐다. 적용 버튼이 없고 수동 선택은 unknown을 유지했다. 빈 요청은 모델 호출 전에 안내됐으며 추가 추론이 발생하지 않았다.

이번 실제 추론은 2회, 기록 저장과 로컬 검토는 각각 1회다. 기록 저장 전에는 기록·검토 실행·업무 출력이 모두 0개였고, 종료 후에도 업무 출력·모바일 job·모바일 상태 보고는 0건이다. 가상 원문 해시는 유지됐고 QA worker는 exit 0으로 정상 종료했다. 기존 179개 자동 검사의 재실행이나 모델 일반화 평가로 세지 않는다. 타임아웃·런타임 누락·권한 거부·동시성 등의 모든 실패를 브라우저로 재현한 것은 아니며 해당 범위는 기존 자동 검사와 구분한다.

근거: `.local/ai-preview-verification/browser-verification.json`, 실행 폴더 `.local/ai-preview-verification/run-202faa38-fc30-4672-9455-11b9aed1ab1f/`의 `browser-ai-applied.png`, `browser-review-result.png`, `browser-ai-held.png`, `browser-before-save.json`, `runtime-result.json`. 기존 연구 보고서 해시와 ZIP SHA-256도 동일함을 확인했다.


0.3.5 개인용 교정 기능: [학습자료 검토·교정 사용법](financial-corrections.md). 기존 기록·AI·명시적 검토 경로는 유지하며 교정 저장·내보내기는 추론·학습·업무 실행을 호출하지 않는다.

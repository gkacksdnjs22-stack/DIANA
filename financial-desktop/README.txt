DIANA PC 금융 문서 검토 · Windows x64 휴대용 실행기

1. ZIP 전체를 쓰기 가능한 로컬 폴더에 압축 해제합니다.
2. DIANA.exe를 실행합니다. EXE만 다른 곳에 옮기지 마세요.
3. ‘연결 설정’에서 기존 worker.json, AGENT_TOKEN이 있는 .env,
   일반 DIANA 파일 폴더(기존 sample-documents)를 선택합니다.
4. ‘연결 시작’을 누르면 PC 검토 화면이 기본 브라우저에 열립니다.
5. ‘연결 종료’ 또는 창의 X는 진행 중 처리를 기다린 뒤 worker를 종료합니다.
   브라우저 탭만 닫으면 worker는 계속 실행합니다.

이 실행기는 기존 Render 서버와 금융 요청·상태 API를 사용합니다.
문서·근거·수정안·결과 파일·최종 승인은 PC에 유지합니다.
다른 PC에는 그 PC에서 검토한 작업·문서·권한 설정과 연결 키가 필요합니다.
배포 ZIP에는 사용자 설정·연결 키·원문·결과 파일·학습 모델이 없습니다.

Node와 Python 런타임을 함께 제공합니다. 기존 core.json의 python 경로는
자동 변경하지 않습니다. 새 PC용 설정을 만들 때는 이 폴더의
runtime\python\python.exe 절대 경로를 등록할 수 있습니다.
현재 가상 작업 생성 도구: app\scripts\init-financial-mobile-demo.mjs
이 도구는 개발자용이며 사용자 문서를 자동으로 등록하지 않습니다.

동일 Windows 로그인에서는 실행기 창 하나만 사용합니다.
기존 CMD 금융 worker가 실행 중이면 기존 창에서 exit로 종료한 뒤 연결합니다.
학습 프로그램이나 일반 DIANA 에이전트에는 영향을 주지 않습니다.
연결이 끊기면 자동 재시도하며, 원문과 결과는 PC에 남습니다.

Windows 10/11 x64 및 .NET Framework 4.8이 필요합니다.
현재 EXE는 코드 서명 전 개발 배포본입니다.
로컬 실행 검증은 이 PC에서 수행하며 다른 PC 실기기 검증은 별도입니다.
라이선스·구성 파일 해시는 LICENSES 및 manifest.json에서 확인할 수 있습니다.

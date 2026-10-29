# DIANA 소개 및 Android 다운로드 페이지

기존 Render 서비스의 `/`를 소개·설치 안내 페이지로 교체한다. 앱과 PC의 서버 주소, 인증, 중계 API, DB·Storage·Firebase 설정은 유지한다. 이 변경은 로컬에서 검증했으며 운영 배포를 수행하지 않았다.

## 공개 경로

| 경로 | 제공 내용 |
| --- | --- |
| `/` | DIANA 소개, 사용 흐름, Android 설치 안내, FAQ |
| `/landing.css` | 네이비·청록·보라 색상의 반응형 스타일 |
| `/diana-logo.png` | 기존 앱의 로고 원본 |
| `/downloads/DIANA-0.3.9.apk` | 직접 내려받을 수 있는 서명된 Android APK |
| `/console` | 교체 전의 웹 연결·파일 요청 화면 |
| `/app.js`, `/style.css` | 기존 웹 작업 화면의 스크립트와 스타일 |

정적 경로는 명시적인 허용 목록이며 임의 폴더나 파일을 제공하지 않는다. 공개 APK는 로그인 없이 받을 수 있고 `Content-Disposition: attachment`로 파일명을 지정한다. GET은 파일을, HEAD는 같은 길이·유형의 헤더만 반환한다. 페이지는 외부 폰트·분석 도구·스크립트를 로드하지 않으며 토큰을 요구하거나 작업을 생성하지 않는다. 기존 CSP와 API의 인증·Origin 검사를 유지한다.

## 배포 APK

- Android 0.3.9, versionCode 12, `kr.nightdesk.phone`
- Android 8.0 이상 (minSdk 26)
- 4,226,534바이트
- SHA-256: `3535ec96209c2af6c0d081b5c00ac5335e630b5b6e746f701d99d50001672c00`
- 서명 인증서 SHA-256: `9e9e61c36d0657e0cfe86b5f542b634e723c050664f6c0102281e9e7287877b9`

휴대폰에 DIANA로 전달한 최종 서명본과 같은 바이트다. 비공개 저장소의 GitHub Actions artifact에 방문자가 접근할 필요 없이 서비스가 파일을 제공한다. 배포 소스에 `public/downloads/DIANA-0.3.9.apk`를 포함해야 한다. APK를 업데이트할 때는 기존 서명으로 검증한 새 파일을 추가하고, 허용 경로·홈페이지 버전 및 설치 정보·다운로드 검사 해시를 함께 갱신한다. 이전 버전 경로를 다른 바이트로 바꾸지 않는다. 서명키·환경 파일은 공개 폴더에 두지 않는다.

## 현재 기능 안내

0.3.9의 대화 입력은 휴대폰 내부 초안 보관 단계이며 로컬 AI 연결은 학습·성능 검증 후 진행한다. 페이지에 이를 명시한다. 등록 문서 검토·보완·변환의 원문·근거·Diff·결과 파일·최종 승인은 PC에 유지하고, 요청과 최소 상태만 중계한다. 일반 파일 전송은 서버의 임시 보관을 이용하므로 모든 파일이 PC에만 남는다고 설명하지 않는다.

## 확인 및 운영 반영

`node --test tests/web-landing.test.mjs tests/control.test.mjs tests/financial-mobile.test.mjs tests/incoming-control.test.mjs tests/delivery-control.test.mjs tests/push-control.test.mjs tests/push-dispatcher.test.mjs tests/firebase-push.test.mjs`

로컬 HTTP 연결이 허용된 환경에서 실행한다. 공개 링크·APK 실제 바이트 및 HEAD·기존 웹 화면·API 인증을 확인하며, 실제 사용자 연결이나 운영 요청은 사용하지 않는다. 브라우저에서는 데스크톱과 작은 휴대폰 화면의 줄바꿈·가로 넘침·설치 안내와 FAQ 펼침을 확인한다.

운영에 반영하려면 이 변경과 공개 APK·로고를 포함한 커밋을 Render에 배포해야 한다. 추가 환경변수·DB 변경·Android 재빌드는 필요하지 않다.

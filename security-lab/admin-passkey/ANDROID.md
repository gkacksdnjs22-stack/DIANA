# DIANA Android 관리자 패스키 시험

공통 WebAuthn 서버와 Windows 클라이언트 위에 Android 관리자 로그인 연결을 추가한다. 기존 `android-app`은 수정하지 않고 `build-android.mjs`가 `generated/android/android-app`에 별도 프로젝트를 만든다. 패키지는 `kr.nightdesk.phone.lab.passkey`, 앱 이름은 DIANA LAB PASSKEY다. 새 시험 서명키는 `generated` 안에서만 생성하고 커밋하지 않는다.

## 로그인과 저장

별도 관리자 진입 아이콘과 일반 앱 설정의 관리자 로그인 버튼을 제공한다. 외부 시스템 브라우저가 `http://localhost:43871`에서 패스키를 확인하고, `kr.nightdesk.phone.lab.passkey://oauth2/callback`으로 받은 코드를 PKCE S256으로 교환한다. 앱은 state, 반환 URI 전체, 중복 인자와 만료를 검사한다. Pending verifier와 세션 토큰은 별도 Android Keystore AES-GCM 키로 암호화한다. 일반 페어링 저장소와 섞지 않는다.

화면 재생성에서는 처리한 반환의 해시만 savedInstanceState에 보관해 중복 처리를 막는다. 앱에 관리자 키를 저장하거나 지문·PIN을 직접 받지 않으며, 실제 패스키 개인키와 사용자 확인은 브라우저의 인증기가 담당한다. 서버 확인 실패 때 저장된 역할을 관리자 권한으로 사용하지 않는다. 관리자 인증은 PC 문서 접근·최종 승인과 별도다.

생성된 시험 앱은 일반 API도 localhost·loopback 주소로 제한하고 Firebase 초기화와 등록을 비활성화한다. 이는 생성된 사본에만 적용한다. 테스트 전용 WebAuthn fixture 경로는 일반 서버 및 사용자 APK에 포함하지 않는다.

## 빌드와 실행

Java 17, Gradle 8.11.1, Android SDK 35와 Node 24가 필요하다. 저장소 루트에서 다음을 실행한다.

```sh
node security-lab/admin-passkey/build-android.mjs
cd security-lab/admin-passkey/generated/android/android-app
gradle --no-daemon :app:testDebugUnitTest :app:assembleDebug :app:assembleDebugAndroidTest
```

생성 프로젝트가 이미 있으면 빌드 스크립트는 덮어쓰지 않는다. 재빌드에는 생성된 프로젝트에서 Gradle을 실행한다. 인증 서버와 최초 관리자는 [공통 안내](README.md)를 따른다. USB 시험 기기에서는 `adb reverse tcp:43871 tcp:43871`을 설정하고 관리자 인증 아이콘으로 시작한다. 운영 서버 주소로 연결하지 않는다.

생성한 APK는 `app/build/outputs/apk/debug/app-debug.apk`, 계측 APK는 `app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk`에 있다. GitHub workflow는 두 파일을 시험 artifact로 보관하며 기존 앱의 다운로드나 배포 설정을 바꾸지 않는다.

## 검증 범위

원래 복제 환경에서 Android 단위 58개와 Android 35 x86_64 에뮬레이터 실행 검사 2개가 통과했다. PR 준비에서도 최신 main에서 별도 프로젝트를 생성하여 단위 58개, 앱 및 계측 APK 빌드, 에뮬레이터 실행 2개를 다시 통과했다. 계측에서는 실제 생성된 일반 페어링 저장소가 관리자 인증으로 변경되지 않는지도 확인했다.

에뮬레이터 계측은 시스템 브라우저 Intent를 가로채 소프트웨어 ES256 WebAuthn 응답을 실제 서버 검증기에 제출한다. 실제 Activity 반환, Keystore 암호화, 화면 재생성 후 복원, 서버 세션 폐기 후 거부, pending 로그인 없는 반환 거부를 검사한다. 실제 휴대폰 지문·PIN 및 브라우저 패스키 선택은 검사하지 않았다. CI는 APK 빌드와 단위 검사를 수행하며 계측 실행은 별도 시험 에뮬레이터가 필요하다.

계측 재현 시 이 모듈에서 `npm ci --ignore-scripts` 후 `node test/android-fixture-server.mjs`를 실행한다. 독립 에뮬레이터에 두 APK를 설치하고 포트를 reverse한 다음 실행한다.

```sh
adb shell am instrument -w -e class kr.nightdesk.phone.AdminPasskeyIntegrationTest kr.nightdesk.phone.lab.passkey.test/androidx.test.runner.AndroidJUnitRunner
```

전용 fixture 서버는 시험 계정에 소프트웨어 인증을 제공하므로 운영에 배포하지 않는다. 검증 뒤 프로세스와 시험 에뮬레이터를 종료한다. 운영 반영 전에는 실제 기기 검증, HTTPS 도메인·RP ID, 배포 서명과 반환 주소, 서버 통합 및 PC별 권한 정책이 필요하다.

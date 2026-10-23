# Firebase로 백그라운드 파일 빠르게 받기

FCM은 파일이 준비됐다는 신호를 보내고, DIANA는 인증된 서버에서 파일을 내려받아 검증한 뒤 선택한 외부 폴더에 복사한다. 실제 저장 확인은 푸시 발송 성공과 구분한다. 아래 설정은 0.3.2 서버·앱 연결에 사용한다.

## Firebase에서 준비할 파일

1. [Firebase 콘솔](https://console.firebase.google.com/)에서 프로젝트를 만들고 Android 앱을 등록한다. 패키지 이름은 **`kr.nightdesk.phone`**으로 입력한다. 프로젝트 설정 → 일반 → 해당 Android 앱에서 `google-services.json`을 내려받는다. [공식 Android 등록 안내](https://firebase.google.com/docs/android/setup)
2. 같은 프로젝트의 프로젝트 설정 → 서비스 계정 → Firebase Admin SDK에서 새 비공개 키를 생성하고, 받은 JSON의 이름을 `firebase-service-account.json`으로 바꾼다. 이 파일은 서버 발송 인증에 사용한다. [공식 HTTP v1 인증 안내](https://firebase.google.com/docs/cloud-messaging/send/v1-api)
3. 프로젝트에서 **Firebase Cloud Messaging API(HTTP v1)**가 사용 설정됐는지 확인한다. 서비스 계정에는 대상 프로젝트의 `cloudmessaging.messages.create` 권한이 필요하다. [공식 FCM 권한 목록](https://firebase.google.com/docs/projects/iam/permissions#cloud-messaging)
4. 두 파일은 아래 위치에만 보관한다. 이 폴더와 파일명은 Git 추적에서 제외된다.

```text
C:\work\diana\.local\firebase\google-services.json
C:\work\diana\.local\firebase\firebase-service-account.json
```

원본 JSON을 채팅·GitHub·모바일에 올리지 않는다. 서비스 계정의 개인 키는 서버에서만 사용한다. 앱에는 페어링된 연결을 통해 초기화에 필요한 공개 Android 설정 필드만 전달한다.

DIANA에는 Firebase Messaging SDK가 포함돼 있으며 `FirebaseOptions`로 초기화한다. 이 프로젝트에서는 `google-services.json`을 Android 소스에 복사하거나 Google services Gradle 플러그인을 추가할 필요가 없다. [Firebase의 코드 초기화 안내](https://github.com/firebase/firebase-android-sdk/blob/main/firebase-installations/REQUIRED_FIREBASE_OPTIONS_ANDROID.md)

## 로컬과 Render 설정

로컬 서버는 프로젝트 루트 `.env`에서 파일 경로를 사용할 수 있다.

```dotenv
FIREBASE_ANDROID_CONFIG_FILE=C:/work/diana/.local/firebase/google-services.json
FIREBASE_SERVICE_ACCOUNT_FILE=C:/work/diana/.local/firebase/firebase-service-account.json
```

Render에서는 로컬 PC 경로를 읽을 수 없으므로 아래 환경변수에 **각 JSON 파일 전체를 JSON 문자열 값으로** 넣는다. 파일 경로나 Base64로 변환한 값이 아니다. 개인 키의 JSON 이스케이프를 유지한다.

| Render 환경변수 | 넣을 내용 |
| --- | --- |
| `FIREBASE_ANDROID_CONFIG_JSON` | `google-services.json` 전체 |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | `firebase-service-account.json` 전체 |

같은 설정에 `_FILE`과 `_JSON`을 동시에 지정하지 않는다. 로컬에서는 해당 `_JSON` 값을 비우고, Render에서는 `_FILE` 값을 비운다.

파일이 준비되면 Codex가 프로젝트·패키지 일치 여부와 키 형식을 검증하고, 값이 노출되지 않도록 비공개 Render 환경변수 파일을 준비할 수 있다. 현재 Render 관리 연결이 없어 대시보드 환경변수 반영과 재배포는 사용자가 진행해야 한다.

## 실제 갤럭시 확인

1. Firebase 설정을 반영한 서버를 배포하고 DIANA 0.3.2를 설치한다. 기존 페어링이 유지돼도 앱을 한 번 열어 서버 설정을 새로 받아야 한다. 재설치로 연결이 지워졌다면 다시 페어링한다.
2. 알림 권한을 허용하고 자동 확인을 켠다. Android ‘내 파일’에서 볼 수 있는 외부 폴더도 선택한다. 앱의 빠른 수신 상태가 연결됐는지 확인한다. [공식 Android FCM 권한·초기화 안내](https://firebase.google.com/docs/cloud-messaging/android/get-started)
3. 홈 화면으로 나가 앱 화면을 닫은 상태에서 PC의 작은 테스트 파일을 DIANA로 보낸다. 앱의 ‘지금 결과 확인’을 누르기 전에 선택한 외부 폴더에 파일이 생기는지 확인한다.
4. 서버의 `phoneSavedAt`은 앱 내부 다운로드·검증 응답이다. 외부 폴더에 실제 파일이 있고 원본 크기·SHA-256이 일치하는지도 따로 확인한다. 푸시 발송 성공만으로 파일 저장 성공을 기록하지 않는다.
5. APK는 별도 테스트 패키지로 전달해 DIANA의 설치 버튼이 Android 설치 화면을 여는지 확인한다. 출처 허용과 최종 설치는 사용자가 Android 화면에서 결정한다. DIANA 자체 업데이트의 서명 호환성은 이 확인과 별개다.

OS 설정의 **강제 종료** 후 자동으로 깨어난다고 보장하지 않는다. 네트워크와 Android 절전 정책에 따라 지연될 수 있으며, 즉시 도착이나 정확한 시각의 저장도 보장하지 않는다. 빠른 수신이 연결되지 않으면 기존 주기 확인과 수동 확인을 사용한다. [공식 Android 메시지 수신 안내](https://firebase.google.com/docs/cloud-messaging/android/receive-messages)

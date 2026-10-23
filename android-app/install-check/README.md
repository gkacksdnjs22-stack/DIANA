# 다른 APK의 설치 화면 확인

DIANA 자체 업데이트 문제와 일반 APK 열기 문제를 구분하기 위한 작은 확인용 앱입니다.

- 앱 이름: **DIANA 설치 연결 확인**
- 패키지: `kr.nightdesk.installcheck` (DIANA와 별개)
- Android 8.0 이상
- 권한 요청, 외부 라이브러리, 네트워크 연결, 파일 접근 없음
- 실행하면 설명문만 표시

`android-app` 폴더에서 기존 CI와 같은 Gradle/Java 환경으로 빌드합니다.

```text
gradle :install-check:assembleDebug
```

결과: `install-check/build/outputs/apk/debug/install-check-debug.apk`

## 휴대폰 확인

1. DIANA로 이 APK를 전달하고 저장 완료를 확인합니다.
2. DIANA 안에서 APK를 엽니다.
3. Android 패키지 설치 화면에 **DIANA 설치 연결 확인**이라는 앱 이름이 표시되는지 확인합니다. 출처 허용이 필요하면 휴대폰의 안내를 따릅니다.
4. 설치 화면이 열렸는지만 확인하려면 **취소**해도 됩니다. 설치할 필요는 없습니다.
5. 실제로 설치한 경우 실행하면 설명문만 나오며, 이후 이 확인용 앱을 삭제할 수 있습니다.

이 앱은 DIANA를 업데이트하거나 교체하지 않습니다. 설치 화면이 열렸다는 사실과 실제 설치 성공 여부는 별도로 기록합니다.

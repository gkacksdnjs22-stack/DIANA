# Android 공개 파일과 소스 확인

공개 APK는 `public/downloads/releases.json`의 `android.sourceCommit`에서 만든 파일입니다. 개발 중인 현재 `android-app`과 같은 소스라고 가정하지 않습니다.

## 이번 불일치의 원인

공개 APK 0.3.9의 기록된 소스 커밋은 `ea595cba04fd9ca3deb0987245f4fc067a3d33aa`입니다. 이 커밋의 소스 57개는 기존 SHA-256 기록과 모두 일치합니다. 병합된 PR #28은 테스트 설정과 별도 화면 등록을 위해 `app/build.gradle`과 `app/src/main/AndroidManifest.xml`을 바꿨고 공개 APK를 교체하지 않았습니다. 이전 검사는 기록된 배포 소스 대신 현재 개발 파일을 읽어 실패했습니다. PR #29의 문서 기능 수정이 원인은 아닙니다.

## 검사 범위

- CI에서 기록된 전체 커밋 번호를 확인한 뒤 해당 Git 커밋을 가져옵니다. 검사 도구 자체는 네트워크에 접근하지 않습니다.
- 현재 작업 파일 대신 해당 커밋의 Git 객체를 읽어 기록된 소스 57개의 해시를 확인합니다. 기존 범위인 세 Gradle 파일과 `app/src/main`의 파일 목록도 대조해 누락과 중복을 거부합니다.
- 실제 APK의 바이트 수와 SHA-256을 확인합니다. APK의 앱 ID, 버전 이름, 버전 번호, 최소 SDK를 배포 당시 Gradle 설정 및 공개 정보와 대조합니다.
- 커밋이 없거나 기록이 맞지 않으면 실패합니다. 현재 파일로 대신 확인하거나 해시 검사를 건너뛰지 않습니다.
- Windows 번들의 기존 검사는 유지합니다. 최신 Android 소스의 빌드와 단위 검사 및 화면 검사는 기존 `DIANA Android APK` 작업에서 계속 수행합니다. 두 검사의 대상이 다릅니다.

이번 확인은 기존 기록과 공개 파일의 일치를 검사합니다. APK 재빌드의 바이트 재현성, 서명자의 신원, 배포 기록의 외부 인증까지 보장하지는 않습니다. 기존 기록에 없던 debug 설정이나 전체 빌드 환경도 새로 검증했다고 표시하지 않습니다.

## 로컬 실행

저장소를 복제한 폴더에서 실행합니다. 내려받은 소스 압축만으로는 기록된 Git 객체를 확인할 수 없습니다.

```powershell
$releaseSourceCommit = node -p "JSON.parse(require('node:fs').readFileSync('public/downloads/releases.json', 'utf8')).android.sourceCommit"
git fetch --no-tags --depth=1 origin $releaseSourceCommit
node --test tests/release-packages.test.mjs tests/android-release-provenance.test.mjs tests/financial-ai-preview-view.test.mjs
```

새 APK를 실제로 배포할 때는 그 빌드의 커밋, 소스 해시, APK 해시와 크기, 버전을 함께 기록해야 합니다. 기존 APK에 최신 소스 해시만 덮어쓰지 않습니다. 이번 변경은 공개 APK, Windows ZIP, 배포 정보와 앱 소스를 바꾸지 않습니다.

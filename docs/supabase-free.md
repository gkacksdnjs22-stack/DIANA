# DIANA: Render 무료 서버에서 Supabase 영구 저장 사용

이 안내는 DIANA의 서버 내부 SQLite/파일 저장을 Supabase에 옮기기 위한 것입니다. GitHub PR이 완성되고 Render 환경변수가 준비될 때까지 **기존 배포는 그대로 둡니다.**

## 1. Supabase (서울 지역)

- 프로젝트 `diana-seoul`, Region `ap-northeast-2`.
- SQL Editor에서 아래 구조가 생성된 상태여야 합니다.
  - `diana.jobs(id TEXT, data TEXT, inserted_seq IDENTITY)`
  - `diana.settings(key TEXT, value TEXT)`
  - `diana.phone_devices(id, token_hash, name, created_at, last_seen_at, fcm_token, revoked_at)`
- `diana` 스키마는 공개 API에 노출하지 않고, RLS를 켜고, `anon`/`authenticated` 권한을 철회합니다.
- Storage에 **Private** 파일 버킷 `diana-transfers`를 만듭니다. 공개 버킷으로 바꾸지 마세요. 10MB 파일 제한, MIME 제한 없음.

## 2. Render 서버 환경변수 (비밀값은 채팅·GitHub에 절대 붙여넣지 않기)

Render Dashboard → DIANA Web Service → Environment에서 아래 항목을 설정합니다.

| 이름 | 값 |
| --- | --- |
| `DATABASE_URL` | Supabase 프로젝트의 **Session pooler** PostgreSQL URI. 비밀번호를 URL 인코딩한 연결 문자열을 사용합니다. Render 무료 IPv4 환경에서는 Direct connection 대신 Session pooler를 선택하세요. |
| `SUPABASE_URL` | 프로젝트 URL (`https://...supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase 프로젝트 API Keys의 서버 전용 **secret/service_role** 키. 다른 사용자에게 노출하지 않습니다. |
| `SUPABASE_STORAGE_BUCKET` | `diana-transfers` |

기존 `USER_TOKEN`, `AGENT_TOKEN`, `GATEWAY_TOKEN`, `DEVICE_ID`, `APP_ORIGIN`은 바꾸지 않습니다. **네 가지 Supabase 설정이 모두 준비되기 전에는 새 버전을 배포하지 마세요.** 특히 `DATABASE_URL` 없이 실행하면 로컬 SQLite 모드이므로 Render 재시작 시 기록이 사라집니다.

서버는 Supabase 연결/스키마 확인에 실패하면 시작을 중단하며 로컬 DB로 조용히 대체하지 않습니다.

## 3. 기존 데이터와 휴대폰 페어링 주의

Render 무료 인스턴스의 `.local/control.sqlite` 및 `.local/transfers`는 휘발성입니다. 이번 방식은 **새로운 Supabase 프로젝트에 배포 이후 생성되는 데이터**를 보존합니다. 현재 실행 중인 Render 인스턴스의 기존 SQLite/파일을 자동 이관하지 않습니다. 배포 과정에서 기존 서버 기록이 사라질 수 있으므로 필요한 문서를 휴대폰 `Download/DIANA`에 먼저 보관하고, 작업을 완료 또는 기록해 둡니다.

기존 Galaxy 앱은 이전 서버의 휴대폰 토큰을 갖고 있을 수 있습니다. 새로운 빈 `diana.phone_devices`에 토큰 해시가 없으므로 **첫 배포 후 6자리 코드로 한 번 다시 페어링해야 할 수 있습니다.** 휴대폰에 이미 저장된 실제 문서는 앱 연결 작업으로 삭제하지 않습니다.

## 4. 배포 후 검증

1. 브라우저에서 `https://<DIANA Render 주소>/api/health` 확인: `"ok":true`와 `"persistence":"supabase"`가 있어야 합니다.
2. 갤럭시 앱을 새 코드로 페어링하고, 문서 1개를 `Download/DIANA`에 저장합니다. SHA-256 및 저장 확인을 검사합니다.
3. Render를 재시작한 뒤에도 웹 작업 기록과 휴대폰 연결 정보가 남는지 확인합니다. 재시작 테스트 전 전송할 파일과 작업 진행 상태를 별도로 보관하세요.
4. 다운로드 중계 파일은 24시간까지만 보관합니다. 만료 후 서버가 Supabase Storage에서 제거하며, 휴대폰에 복사한 파일은 지우지 않습니다.

## 제한

- Render 무료는 일정 시간 미사용 시 절전되어 새 요청 때 시작 지연이 발생할 수 있습니다.
- Supabase 무료 프로젝트는 사용량이 적으면 일시 중지될 수 있으며, 필요 시 Supabase 대시보드에서 복원해야 합니다. 상시 운영 보장은 아닙니다.
- 이 구현은 Render 무료 **단일 인스턴스**를 전제로 SQLite 메모리 캐시와 Postgres 영구 복제를 사용합니다. 여러 서버 인스턴스를 동시에 붙이면 캐시 충돌이 생길 수 있으므로 확장 배포에는 별도 저장 계층을 설계해야 합니다.
- 인증 정보와 문서는 제3자 클라우드에 보관되므로 민감한 문서의 취급 정책을 확인하세요.

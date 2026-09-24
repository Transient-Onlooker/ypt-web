# YPT Web

휴대폰과 PC에서 열품타 이메일 계정의 과목, 타이머, 공부 기록, 가입 그룹을 사용하는 React + Cloudflare Worker + D1 앱입니다. 별도 서비스 가입이나 허용 목록은 없습니다. 운영 배포는 아직 하지 않았습니다.

## 로컬 실행

Node.js 22 이상이 필요합니다.

```powershell
npm install
Copy-Item .env.example .dev.vars
```

`.dev.vars`의 `YPT_ENCRYPTION_KEY`를 무작위 32바이트의 base64 값으로 바꿉니다. 예를 들어 PowerShell에서 아래 명령으로 **키 값만** 생성할 수 있습니다. 생성한 값은 채팅이나 Git에 넣지 마세요.

```powershell
$bytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
[Convert]::ToBase64String($bytes)
```

`APP_ORIGIN=http://localhost:5173`을 유지하고 `npm run db:local`을 실행합니다. 터미널 두 개에서 `npm run dev:worker`와 `npm run dev`를 각각 실행한 뒤 `http://localhost:5173`에 접속합니다. 브라우저 비밀번호·JWT는 출력하거나 로컬 파일에 저장하지 않습니다. D1에는 암호화된 JWT, 해시된 세션 토큰, 타이머 상태가 저장됩니다. 세션 쿠키는 HttpOnly·Secure·SameSite=Strict입니다. 로컬 HTTP에서 Secure 쿠키의 예외 동작은 브라우저별로 차이가 있으므로, 운영 환경은 반드시 HTTPS를 사용합니다.

## 기능과 안전한 상태 복구

- 열품타의 실제 과목을 조회합니다. 웹에서 시작한 타이머와 앱에서 시작한 타이머는 계정별로 상태를 동기화합니다. 시작 성공 뒤 인증 응답의 `p.st`를 다시 읽어 정확한 시작 시각을 보관하고, 확인할 수 없는 경우 종료에 추정 시각을 사용하지 않습니다.
- 일시정지는 열품타의 `stop`, 재개는 새 `start`입니다. 앱이 꺼지거나 브라우저를 닫아도 자동 종료하지 않습니다. 화면 복귀 시와 열린 화면에서 15초 간격으로 상태를 다시 확인합니다.
- 중복 클릭과 여러 탭은 D1의 버전 조건으로 막습니다. 응답 유실·통신 실패 뒤에는 같은 시작/종료 요청을 자동 재시도하지 않습니다. 화면의 안내대로 **열품타 앱에서 타이머를 실제로 정지한 뒤** 복구 버튼을 누릅니다.
- 기록은 API에서 확인된 날짜와 시간을 그대로 표시합니다. 과목별 시간이 응답에 없으면 추정값을 표시하지 않습니다. 가입 그룹은 그룹 화면에서 30초마다 갱신하고 직접 새로고침할 수 있습니다.
- 기록 화면에서 이전·다음 날짜와 오늘로 이동할 수 있습니다. 공부 중인 시간은 완료된 오늘 기록과 구분해 표시하며, 다른 탭에서도 타이머를 볼 수 있습니다. 그룹에서는 공부 중 인원과 멤버별 상태·시간을 보여줍니다. 상태 갱신이 지연되거나 실패하면 마지막 확인 시각과 오류를 표시합니다.
- 로그아웃은 현재 웹 세션을 해제합니다. 다시 로그인할 수 있도록 계정의 암호화된 열품타 JWT와 타이머 상태는 서버에 남습니다.

## 검증

```powershell
npm test
npm run build
npm run check:worker
git diff --check
```

실제 API 조사 도구는 `scripts/`에 있습니다. 계정 입력은 로컬 터미널에서만 받으며 비식별 결과는 Git에서 제외한 `.ypt-local/`에 보존합니다. 실제 검증 결과와 한계는 [docs/api-validation.md](docs/api-validation.md)에 기록했습니다.

## 운영 배포 준비

운영 D1 데이터베이스를 만든 뒤 `wrangler.jsonc`의 임시 `database_id`를 실제 ID로 바꾸고, `APP_ORIGIN`을 서비스의 정확한 HTTPS 출처로 설정합니다. `YPT_ENCRYPTION_KEY`는 Worker secret으로 설정해야 하며 Git이나 `vars`에 넣지 않습니다. 마이그레이션은 배포 전에 순서대로 적용합니다. 운영 배포 및 도메인 연결은 별도 단계입니다.

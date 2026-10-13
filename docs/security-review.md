# 공개 저장소 보안 점검 기록

> 기준: 2026-10-13, 코드 v0.31.3, 문서 변경 전 `main` SHA `af4bb60ccaca82e8e1a0703c79854c87da05b934`. **정적 코드·이력 점검 기록**이며 모의 침투 테스트, 외부 서비스 설정 검증 또는 보안 인증이 아닙니다.

## 점검 범위와 방법

- GitHub 저장소의 공개 상태(Public), `main` 추적 파일 **57개**의 경로와 `.gitignore`, Wrangler, npm, Pages workflow 설정을 확인했습니다.
- 현재 텍스트 파일(프런트·Worker·스크립트·공통 모듈·테스트·문서·lockfile)에 비밀키 블록, GitHub/OpenAI/AWS/Google 키 형식, JWT 패턴, 비밀값 상수 할당을 탐지하는 정규식 검사를 수행했습니다. PNG 등 바이너리와 비정형·암호화·인코딩된 비밀값은 이 방식으로 확인할 수 없습니다.
- `main` 커밋 **76개**의 GitHub 변경 패치에서 **추가된 줄**을 같은 패턴으로 확인했습니다. 이는 Git 개체를 완전히 내려받아 탐색한 검사가 아니며, 삭제된 줄·GitHub가 생략한 patch·다른 ref·도달 불가능한 개체에 대한 전수검사는 아닙니다.
- `main` 외 기존 작업 브랜치 **18개**의 tip 트리에서 의심스러운 파일명 경로를 확인했습니다. 해당 브랜치의 모든 커밋·모든 blob에 대한 전문 스캔은 수행하지 않았습니다.
- `worker/index.ts`, `worker/ypt.ts`의 인증·세션·암호화·입력 제한·CORS/CSRF·upstream 호출 흐름과 `src/main.tsx` 등에서 직접 HTML 실행 관련 위험 패턴을 표본 검토했습니다.

## 확인 결과

1. **명백한 실서비스 비밀키 노출은 확인되지 않음(검사 범위 한정).** `tests/worker-flow.test.mjs`에서 탐지된 credential-like 문자열은 모의 Google 토큰 시나리오의 테스트 데이터이며, `.env.example`은 교체해야 하는 예시 값입니다. 이 결과를 키 유효성 검증이나 절대적인 무노출 증명으로 해석하지 않습니다.
2. **공개 설정과 비밀은 구분해야 함.** `wrangler.jsonc`의 Google OAuth **웹 클라이언트 ID**, D1 **데이터베이스 식별자**, Worker 호스트명은 그 자체로 비밀키가 아닙니다. 반면 `YPT_ENCRYPTION_KEY`, 열품타 JWT, Google Access/Refresh token, 실제 사용자 비밀번호는 공개되어서는 안 됩니다.
3. **정적 코드상 방어가 확인됨.** 열품타 JWT의 AES-GCM 암호화 저장, 임의 세션 토큰의 SHA-256 해시 저장, HMAC 기반 계정 키, 로그인 제한, 정확한 Pages origin 기반 CORS 및 CSRF 검사, HTTPS upstream 고정과 3xx 자동 리디렉션 거부가 구현되어 있습니다. 이는 운영 설정·실제 공격 내성을 검증했다는 뜻이 아닙니다.
4. **민감정보 출력 위험 완화가 확인됨.** Worker 로그는 기본적으로 경로·HTTP 상태·오류 종류만 기록하는 형태이며, 조사 스크립트에는 민감정보 미저장·비식별 결과 지침이 있습니다. 사용자가 임의로 터미널 전체 로그를 공개하지 않는지까지는 확인할 수 없습니다.
5. **라이선스는 아직 미결정.** 공개 여부와 코드 재사용 허가는 별개의 문제입니다. `LICENSE`는 이번 문서 동기화에서 추가하지 않았습니다.

## 남은 확인·개선 항목

- **우선:** 모든 ref와 과거 Git 개체를 내려받아 Gitleaks 등 별도 secret scanner로 `--all` 이력까지 검사하고, 탐지된 값의 실제 노출 여부를 검증합니다. 비밀이 확인되면 저장소에서 지우는 작업보다 해당 키·토큰 **폐기/재발급**을 먼저 수행합니다.
- **우선:** 운영 Cloudflare의 Secrets, D1 접근 권한·마이그레이션·배포 버전, GitHub Secrets 및 최근 CI 로그의 유출 여부를 별도로 확인합니다. 이 문서에서는 해당 콘솔 내부를 열람하지 않았습니다.
- **우선:** `npm audit --json` 또는 Dependabot alerts로 lockfile 전체의 알려진 취약점을 검사합니다. 네트워크 제한으로 npm registry 감사 요청을 실행하지 못했고, 공개 검색만으로 의존성 무취약을 판단할 수 없습니다.
- **개선 후보:** GitHub Actions `uses: actions/*@v4/v5` 태그를 검토해 커밋 SHA pinning, 작업별 최소 `permissions` 적용을 고려합니다. 현재 workflow에서 Pages 관련 쓰기 권한은 workflow 전역에 설정되어 있습니다.
- **개선 후보:** Pages에서 제공되는 실제 응답의 CSP 등 보안 헤더와 브라우저의 XSS 방어를 점검합니다. 소스에 직접 `dangerouslySetInnerHTML` 사용 패턴은 관찰되지 않았지만, 이것만으로 XSS가 없다고 증명할 수 없습니다.
- **운영 위험:** 로그인/로그아웃 경로의 만료 세션 정리 코드가 존재하지만, 지속적으로 실행되는 주기적 DB 청소까지 확인한 것은 아닙니다. JWT 보존 기간·실제 운영 정책은 추가 점검해야 합니다.
- **외부 의존성:** 비공식 열품타 API 및 Google 로그인 제공자의 변경, 원격 CDN 폰트, npm 패키지와 배포 인프라의 공급망 위험은 정적 코드 검색만으로 배제할 수 없습니다.

## 재현 가능한 확인 지점

- GitHub `main` tree, GitHub REST commits(100개/page) 및 각 commit의 `files[].patch` 추가 줄 검사
- `worker/index.ts`: `master`, `accountId`, `encrypt`/`decrypt`, `session`, `mutationAllowed`, `limitIp`, `limitIdentity`, `googleLoginRoute`, `issueSession`, `handleRequest`
- `worker/ypt.ts`: 고정 upstream `BASE`, `redirect: "manual"`, 오류 로그
- `.gitignore`, `.env.example`, `.github/workflows/pages.yml`, `wrangler.jsonc`
- `tests/worker-flow.test.mjs`: Google OAuth 모의 요청 및 더미 토큰

점검 결과는 **2026-10-13 당시의 코드 상태와 조사 범위**에만 적용합니다. 이후 커밋, 재배포, 운영 권한 설정 변경으로 보안 상태가 달라질 수 있습니다.

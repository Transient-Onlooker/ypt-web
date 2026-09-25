# 배포와 도메인 연결

화면은 GitHub Pages의 `https://ypt.mcv.kr`, API는 [Cloudflare Worker](https://ypt-web.junuh145858.workers.dev)의 `/api`로 제공하는 구성입니다. Pages는 GitHub Actions의 `.github/workflows/pages.yml`에서 빌드합니다. Worker의 D1 `ypt-web`에는 초기 마이그레이션을, Worker secret에는 `YPT_ENCRYPTION_KEY`를 적용했습니다. `ypt.mcv.kr` CNAME은 GitHub Pages를 가리킵니다. 인증서 승인과 HTTPS 화면·자산의 200 응답을 확인하고 HTTPS 강제를 켰습니다.

## 현재 검증 범위

- Worker의 `GET /api/session`은 비로그인 상태를 반환합니다. `ypt.mcv.kr` 출처의 CORS 사전 요청은 204, 다른 출처의 로그인 요청은 403입니다.
- 통합 테스트에서 Pages 출처의 사용자별 로그인·계정 분리·타이머 제어·로그아웃을 모의 열품타 응답으로 검증했습니다.
- Pages 배포 워크플로 성공, DNS CNAME 변경, HTTPS 인증서 승인, Pages 화면·JS 자산 200 응답, HTTPS 강제 설정을 확인했습니다. 실제 열품타 계정으로 Pages 주소의 로그인과 타이머를 확인하는 일은 남아 있습니다. 로컬 실제 계정 검증은 [API 검증 기록](api-validation.md)을 참고합니다.

## 재배포

Node.js 22 이상, 이 저장소에 연결된 Wrangler 인증이 필요합니다. 현재 운영 D1 ID는 `wrangler.jsonc`에 지정돼 있습니다. 암호화 키는 기존 Worker secret에 있으므로 재배포할 때 새로 생성하지 않습니다. 키를 바꾸면 저장된 열품타 JWT를 복호화할 수 없습니다.

```powershell
npm ci
npm test
npm run build
npm run check:worker
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy
```

로컬 개발은 `.dev.vars`의 `APP_ORIGIN=http://localhost:5173`과 Vite 프록시를 사용합니다. Pages 빌드는 `VITE_API_BASE_URL`에 Worker 주소를 넣습니다. Worker는 정확히 `https://ypt.mcv.kr` 출처에만 CORS를 허용합니다. Pages 로그인은 계정별 불투명 세션 토큰을 발급하고 브라우저 탭의 `sessionStorage`에만 저장합니다. 탭을 닫으면 다시 로그인해야 합니다. 열품타 비밀번호·JWT는 브라우저에 저장하지 않습니다. Worker 단독 주소는 기존 HttpOnly 쿠키 세션을 유지합니다.

## `ypt.mcv.kr` 연결

Linode의 기존 `ypt.mcv.kr` CNAME 대상만 `transient-onlooker.github.io`로 변경했습니다. `mcv.kr`의 다른 DNS 기록과 네임서버는 그대로입니다. 공개 DNS와 GitHub Pages DNS 진단에서 올바른 대상·Pages 제공 상태를 확인했습니다. GitHub Pages 인증서가 승인된 뒤 `https://ypt.mcv.kr`의 화면과 JS 자산 응답을 확인하고 HTTPS 강제를 켰습니다. [GitHub Pages HTTPS 안내](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https)를 참고하세요.

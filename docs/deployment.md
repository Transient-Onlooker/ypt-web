# 배포와 도메인 연결

2026-09-25 기준 Worker는 [ypt-web.junuh145858.workers.dev](https://ypt-web.junuh145858.workers.dev)에 배포돼 있습니다. React 빌드 파일은 같은 Worker의 정적 자산으로 제공하고, `/api`는 Worker 코드가 처리합니다. D1 `ypt-web`에 초기 마이그레이션을 적용하고 `YPT_ENCRYPTION_KEY`를 Worker secret으로 설정했습니다. GitHub Pages는 이 앱의 제공 경로에 포함되지 않습니다. GitHub 저장소는 코드와 문서의 관리 장소입니다.

## 현재 검증 범위

- `GET /`는 200, `GET /api/session`은 비로그인 상태를 반환합니다.
- 다른 출처의 `POST /api/login`은 403, 같은 출처의 빈 로그인 입력은 400입니다.
- 운영 주소에서 실제 열품타 계정 로그인과 타이머 제어는 아직 확인하지 않았습니다. 로컬 실제 계정 검증은 [API 검증 기록](api-validation.md)을 참고합니다.

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

로컬 개발은 `.dev.vars`의 `APP_ORIGIN=http://localhost:5173`을 사용합니다. 운영에서는 브라우저가 접속한 Worker 주소와 요청의 `Origin`이 일치해야 변경 요청을 처리합니다. 클라이언트는 같은 주소의 `/api`만 호출하므로 별도 CORS나 다른 사이트 쿠키 설정이 필요하지 않습니다.

## `ypt.mcv.kr` 연결

2026-09-25 DNS 조회에서 `mcv.kr`의 권한 네임서버는 Linode DNS입니다. 사용자가 Linode에 `ypt.mcv.kr → ypt-web.junuh145858.workers.dev` CNAME을 추가했고, 공개 DNS 조회에서 그 값이 확인됐습니다. 그러나 `https://ypt.mcv.kr/api/session`은 TLS 핸드셰이크가 실패합니다. **CNAME은 전파됐지만 사이트 연결은 완료되지 않았습니다.** `se3c`, `sir-model`, `openjacks` 서브도메인은 GitHub Pages를 가리키고, `mcv.kr` 자체는 별도 A 레코드를 사용합니다. 이 기존 주소들의 DNS를 유지해야 합니다. Cloudflare Worker의 기본 Custom Domain은 활성 Cloudflare DNS 영역에 속한 주소가 필요하며, 설정하면 Cloudflare가 DNS 레코드와 인증서를 만듭니다. [Cloudflare Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)와 [Cloudflare DNS 구성](https://developers.cloudflare.com/dns/zone-setups/)을 참고하세요.

이 구성을 유지하며 연결하는 절차는 다음과 같습니다.

1. Linode의 **전체** `mcv.kr` DNS 레코드를 내보내거나 확인하고, 루트 A 레코드, GitHub Pages용 CNAME, 이메일 및 검증용 MX/TXT 등을 빠짐없이 기록합니다.
2. Cloudflare에 `mcv.kr`을 DNS 영역으로 추가하고 기존 레코드를 동일하게 준비합니다. 기존 사이트들의 호스팅은 유지할 수 있습니다.
3. 등록기관에서 `mcv.kr` 네임서버를 Cloudflare가 지정한 값으로 바꾸고, 기존 사이트와 메일의 DNS·HTTPS 응답을 확인합니다. 이 변경은 `mcv.kr` 전체에 영향을 주므로 레코드 확인 전에는 실행하지 않습니다.
4. DNS 영역이 활성화되면 Linode에 추가한 임시 `ypt` CNAME이 Cloudflare 영역으로 복사되지 않았는지 확인합니다. Custom Domain과 같은 이름의 기존 CNAME은 충돌합니다. `wrangler.jsonc`에 `{ "routes": [{ "pattern": "ypt.mcv.kr", "custom_domain": true }] }`를 추가하고 `npx wrangler deploy`를 실행합니다. Cloudflare가 해당 주소의 DNS와 인증서를 생성합니다.
5. `https://ypt.mcv.kr/`, `/api/session`, 실제 계정 로그인·타이머를 확인합니다. 현재 `workers.dev` 주소도 계속 사용할 수 있습니다.

Linode DNS를 계속 권한 서버로 두고 **CNAME 한 개만** 추가하려는 방식은 Cloudflare의 일반적인 Worker Custom Domain 설정에 해당하지 않습니다. Cloudflare의 별도 CNAME/부분 영역 구성은 플랜 제한이 있으므로 여기서는 전제로 삼지 않습니다. 기존 사이트에 영향을 주는 DNS 이전은 아직 수행하지 않았습니다.

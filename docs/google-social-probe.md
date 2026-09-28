# 구글 계정 → 열품타 로그인 로컬 검증

이 절차는 구글 OAuth 토큰이 열품타의 `/user/social/sign-up-jwt`에서 받아들여지는지 조사합니다. 2026-09-26 사용자가 자신의 구글 본계정으로 실행해 Google UserInfo 확인, 열품타 교환 HTTP 200·`success=true`, 인증된 재조회 HTTP 200·`verified=true`를 보고했습니다. 웹에는 Google 로그인 코드를 설정값으로 켤 수 있게 추가했지만, 운영용 웹 OAuth 클라이언트 ID가 없어 아직 로그인 버튼은 비활성 상태입니다. 웹 클라이언트 토큰과 기존 앱 계정 데이터 일치 여부도 검증되지 않았습니다.

열품타의 소셜 경로는 새 제공자 ID를 받으면 **새 계정을 만들 수 있습니다**. 기존 열품타 이메일 계정과 구글 이메일이 같아도 연결된다고 가정하지 마세요. 이미 열품타 앱에서 구글로 로그인한 계정으로 시험하는 것이 안전합니다.

1. 로컬 터미널에서 저장소로 이동하고 Node.js 22 이상을 준비합니다. `node scripts/probe-google-social.mjs --help`로 안내를 볼 수 있습니다.
2. 본인이 브라우저에서 [Google OAuth 2.0 Playground](https://developers.google.com/oauthplayground/)를 엽니다. Step 1의 직접 입력 칸에 `openid email profile`을 넣어 승인하고, Step 2에서 인증 코드를 토큰으로 교환합니다. **Access token**을 사용합니다. Refresh token이나 ID token은 사용하지 않습니다.
3. 로컬 터미널에서 `node scripts/probe-google-social.mjs`를 실행하고 숨김 입력란에 Access token을 붙여 넣습니다. 토큰을 명령 인수·환경변수·채팅·파일에 넣지 마세요.
4. 도구가 Google UserInfo를 확인한 뒤 열품타로 전송하기 전에 멈춥니다. 새 열품타 계정 생성 가능성을 감수하고 진행할 때만 `SEND`를 입력합니다. 다른 입력은 전송 없이 취소합니다.

도구는 열품타 응답의 HTTP 상태, 성공 여부, 숫자 오류 코드만 출력합니다. 성공 시 받은 JWT는 메모리에서만 사용해 읽기 전용 `reload/info`를 한 번 확인합니다. Google 프로필, 토큰, 열품타 JWT, 전체 API 응답은 저장하거나 출력하지 않습니다. 실패한 응답만으로 구글 로그인이 불가능하다고 단정하지 않습니다. Google OAuth Playground의 기본 클라이언트로 발급한 토큰이 열품타 공식 앱의 토큰과 같은 방식으로 허용되는지는 검증 대상입니다.

## 웹 로그인 설정에 필요한 것

운영 웹에서 Google Identity Services를 사용하려면 이 사이트용 **OAuth 2.0 웹 애플리케이션 클라이언트 ID**가 필요합니다. [Google의 클라이언트 ID 설정 안내](https://developers.google.com/identity/oauth2/web/guides/get-google-api-clientid)에 따라 승인된 JavaScript 출처에 `https://ypt.mcv.kr`을, 로컬 검증을 원하면 `http://localhost:5173`도 등록해야 합니다. 팝업 기반 [토큰 모델](https://developers.google.com/identity/oauth2/web/guides/use-token-model)은 리디렉션 URI나 클라이언트 보안 비밀을 프론트엔드에 넣지 않습니다. OAuth 동의 화면이 테스트 상태라면 실제로 로그인할 구글 계정이 테스트 사용자에 포함되어야 합니다.

클라이언트 ID는 공개 설정값이지만 클라이언트 **보안 비밀**, Access token, Refresh token, JWT와 다릅니다. 이 문서의 로컬 검증은 Google OAuth Playground의 토큰으로 수행됐고, `ypt.mcv.kr`용 웹 클라이언트 ID로 발급한 토큰은 아직 시험하지 않았습니다.

웹 클라이언트 ID를 만든 뒤 Worker의 `GOOGLE_CLIENT_ID` 설정값에 넣으면 `/api/auth/providers`가 ID를 공개하고 Google 로그인 버튼이 켜집니다. 버튼은 Google Identity Services 팝업에서 `openid email profile` Access token을 받습니다. Worker는 Google의 토큰 확인 응답에서 발급 대상(`aud`·`azp`)이 설정된 웹 클라이언트 ID와 같은지 확인하고, UserInfo의 `sub`와 검증된 이메일을 대조한 뒤 열품타 소셜 로그인에 전달합니다. 토큰은 브라우저 저장소나 D1에 보관하지 않습니다. 열품타 JWT만 기존과 같이 암호화해 저장합니다. Google `sub`를 기준으로 만든 웹 계정 키를 이메일 로그인 키와 분리해 같은 이메일의 서로 다른 열품타 계정이 서로의 JWT를 덮어쓰지 않게 합니다.

토큰 발급 대상 확인은 Google의 [사용자 액세스 토큰 확인 응답](https://docs.cloud.google.com/docs/authentication/token-types#user_access_tokens)에 근거합니다. 이 확인이나 Google UserInfo가 실패하면 열품타 API를 호출하지 않습니다.

로컬 시험에서는 `.dev.vars`에 `GOOGLE_CLIENT_ID=...apps.googleusercontent.com`을 추가합니다. 운영 환경에서는 Cloudflare Worker의 환경 변수로 같은 값을 설정하고 Worker를 배포합니다. 값은 공개 클라이언트 ID이며 클라이언트 보안 비밀을 설정하거나 프런트엔드에 넣지 않습니다. [Cloudflare의 환경 변수 안내](https://developers.cloudflare.com/workers/configuration/environment-variables/)를 참고하세요.

기존 열품타 앱의 Google 계정과 같은 계정으로 연결되는지는 아직 확인되지 않았습니다. **처음에는 실제 계정에서 읽기 전용으로 과목·가입 그룹·기존 날짜 기록을 앱과 비교**한 뒤 타이머를 조작해야 합니다. 참고 클라이언트의 소셜 요청 형식은 [구현 코드](https://github.com/deveworld/ypt_client/blob/main/lib/ypt_api.dart#L77-L102)에 있지만, 이 클라이언트에는 Google 버튼이 없고 Kakao·Naver 로그인만 있습니다. 제공자 ID가 기존 계정으로 연결된다는 설명은 참고 클라이언트의 추정이며 계정 일치 검증을 대체하지 않습니다.

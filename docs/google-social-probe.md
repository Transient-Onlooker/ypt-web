# 구글 계정 → 열품타 로그인 로컬 검증

이 절차는 구글 OAuth 토큰이 열품타의 `/user/social/sign-up-jwt`에서 받아들여지는지 조사합니다. 2026-09-26 사용자가 자신의 구글 본계정으로 실행해 Google UserInfo 확인, 열품타 교환 HTTP 200·`success=true`, 인증된 재조회 HTTP 200·`verified=true`를 보고했습니다. 운영 웹에는 구글 로그인 버튼을 추가하지 않았습니다. 웹 서비스용 자체 Google OAuth 클라이언트의 토큰과 기존 앱 계정의 데이터 일치 여부는 아직 검증하지 않았습니다. 새 제공자 ID로 계정 생성 가능성이 있어 사용자 지시에 따라 웹 적용은 보류했습니다.

열품타의 소셜 경로는 새 제공자 ID를 받으면 **새 계정을 만들 수 있습니다**. 기존 열품타 이메일 계정과 구글 이메일이 같아도 연결된다고 가정하지 마세요. 이미 열품타 앱에서 구글로 로그인한 계정으로 시험하는 것이 안전합니다.

1. 로컬 터미널에서 저장소로 이동하고 Node.js 22 이상을 준비합니다. `node scripts/probe-google-social.mjs --help`로 안내를 볼 수 있습니다.
2. 본인이 브라우저에서 [Google OAuth 2.0 Playground](https://developers.google.com/oauthplayground/)를 엽니다. Step 1의 직접 입력 칸에 `openid email profile`을 넣어 승인하고, Step 2에서 인증 코드를 토큰으로 교환합니다. **Access token**을 사용합니다. Refresh token이나 ID token은 사용하지 않습니다.
3. 로컬 터미널에서 `node scripts/probe-google-social.mjs`를 실행하고 숨김 입력란에 Access token을 붙여 넣습니다. 토큰을 명령 인수·환경변수·채팅·파일에 넣지 마세요.
4. 도구가 Google UserInfo를 확인한 뒤 열품타로 전송하기 전에 멈춥니다. 새 열품타 계정 생성 가능성을 감수하고 진행할 때만 `SEND`를 입력합니다. 다른 입력은 전송 없이 취소합니다.

도구는 열품타 응답의 HTTP 상태, 성공 여부, 숫자 오류 코드만 출력합니다. 성공 시 받은 JWT는 메모리에서만 사용해 읽기 전용 `reload/info`를 한 번 확인합니다. Google 프로필, 토큰, 열품타 JWT, 전체 API 응답은 저장하거나 출력하지 않습니다. 실패한 응답만으로 구글 로그인이 불가능하다고 단정하지 않습니다. Google OAuth Playground의 기본 클라이언트로 발급한 토큰이 열품타 공식 앱의 토큰과 같은 방식으로 허용되는지는 검증 대상입니다.

## 웹 로그인 설정에 필요한 것

운영 웹에서 Google Identity Services를 사용하려면 이 사이트용 **OAuth 2.0 웹 애플리케이션 클라이언트 ID**가 필요합니다. [Google의 클라이언트 ID 설정 안내](https://developers.google.com/identity/oauth2/web/guides/get-google-api-clientid)에 따라 승인된 JavaScript 출처에 `https://ypt.mcv.kr`을, 로컬 검증을 원하면 `http://localhost:5173`도 등록해야 합니다. 팝업 기반 [토큰 모델](https://developers.google.com/identity/oauth2/web/guides/use-token-model)은 리디렉션 URI나 클라이언트 보안 비밀을 프론트엔드에 넣지 않습니다. OAuth 동의 화면이 테스트 상태라면 실제로 로그인할 구글 계정이 테스트 사용자에 포함되어야 합니다.

클라이언트 ID는 공개 설정값이지만 클라이언트 **보안 비밀**, Access token, Refresh token, JWT와 다릅니다. 이 문서의 로컬 검증은 Google OAuth Playground의 토큰으로 수행됐고, `ypt.mcv.kr`용 웹 클라이언트 ID로 발급한 토큰은 아직 시험하지 않았습니다.

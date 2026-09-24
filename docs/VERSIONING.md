# 내부 버전 관리

- 형식은 `vMAJOR.MINOR.PATCH · 짧은 이름`입니다. 1.0 전에는 검증 중인 기능과 API 해석이 바뀔 수 있습니다.
- 사용자 기능 묶음은 MINOR, 기존 동작의 수정은 PATCH를 올립니다. 호환성이 크게 바뀌면 MAJOR를 올립니다.
- 버전을 올릴 때 `package.json`과 `package-lock.json`의 루트 버전을 같이 바꾸고, `docs/CHANGELOG.md` 맨 위에 날짜·이름·사용자에게 보이는 변화·검증 결과·남은 한계를 적습니다.
- 실제 계정/API 동작은 `docs/api-validation.md`에 근거를 남깁니다. 참고 구현의 추정과 실제 계정 검증을 구분합니다.
- 버전 번호와 패치노트는 내부 개발 기록입니다. Git 태그, GitHub Release, 운영 배포는 별도 작업으로 취급합니다.

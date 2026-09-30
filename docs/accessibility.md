# 접근성 점검

YPT Web은 **WCAG 2.2 Level AA**를 구현 목표로 둡니다. 이 문서는 코드에서 자동으로 확인하는 항목과 실제 브라우저에서 따로 확인해야 하는 항목을 구분합니다.

## 기준

- 일반 텍스트 대비: 4.5:1 이상
- 큰 텍스트 대비: 3:1 이상
- 의미 있는 UI 경계·그래픽: 3:1 이상
- Target Size (Minimum, 2.5.8): 원칙적으로 24×24 CSS px 이상 또는 규정된 간격 예외 충족
- Focus Not Obscured (Minimum, 2.4.11): 키보드 포커스가 작성자 UI에 완전히 가려지지 않아야 함
- Reflow (1.4.10): 320 CSS px 폭에 해당하는 확대 환경에서 필요한 2차원 콘텐츠를 제외하고 양방향 스크롤 없이 사용 가능해야 함

W3C 참고:
- https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
- https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html
- https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
- https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html
- https://www.w3.org/WAI/WCAG22/Understanding/reflow.html
- https://www.w3.org/WAI/WCAG22/Understanding/label-in-name.html
- https://www.w3.org/WAI/WCAG22/Understanding/accessible-authentication-minimum.html

## v0.29.0 핵심 대비

아래는 현재 테마 토큰을 WCAG 상대 휘도 공식으로 계산한 값입니다.

| 항목 | 색 조합 | 대비 | AA 기준 |
| --- | --- | ---: | --- |
| 라이트 본문 / 페이지 | #000000 / #FFF0BE | 18.46:1 | 통과 |
| 라이트 보조 텍스트 / 페이지 | #1E1E1E / #FFF0BE | 14.65:1 | 통과 |
| 라이트 주요 버튼 | #000000 / #FF9A86 | 10.22:1 | 통과 |
| 라이트 선택 배경 | #000000 / #FFB399 | 12.16:1 | 통과 |
| 다크 본문 / OLED 배경 | #FFFFFF / #000000 | 21.00:1 | 통과 |
| 다크 보조 텍스트 / 카드 | #888888 / #121212 | 5.28:1 | 통과 |
| 다크 주요 버튼 | #000000 / #FFA500 | 10.63:1 | 통과 |
| 다크 hover 버튼 | #000000 / #CC5500 | 4.87:1 | 통과 |
| 다크 강조 텍스트 / 카드 | #FFA500 / #121212 | 9.49:1 | 통과 |

v0.29 theme override는 승인한 온라인 팔레트의 6자리 HEX 외 색을 추가하면 자동 테스트가 실패합니다.

## 코드에서 확인한 AA 관련 구조

- 문서 언어가 `ko`로 선언되어 있습니다.
- viewport에서 `user-scalable=no` 또는 `maximum-scale=1`로 확대를 막지 않습니다.
- 본문 바로가기가 있고 대상 `main`이 존재합니다.
- 클릭 동작은 button/a/input/summary 같은 네이티브 대화형 요소에 둡니다.
- 양수 `tabindex`를 사용하지 않습니다.
- literal id를 가진 input/select/textarea는 label 또는 ARIA 이름과 연결합니다.
- 로그인 이메일/비밀번호는 `username`, `current-password` autocomplete를 사용하며 붙여넣기를 막지 않습니다.
- 동적 오류와 주요 비동기 결과는 `role="alert"` 또는 `role="status"`를 사용합니다.
- 선택 상태에는 `aria-pressed` 또는 `aria-current`를 사용합니다.
- 초당 변하는 타이머 숫자는 `aria-live="off"`로 두어 스크린리더를 매초 방해하지 않습니다.
- 밝기 전환·날짜 이동·증감 버튼처럼 `aria-label`을 덮어쓰는 컨트롤은 보이는 라벨을 접근 가능한 이름에도 포함합니다.
- 모바일 하단 고정 메뉴와 상단 sticky bar를 고려한 scroll padding/margin을 둡니다.
- 저수준 포인터 타깃은 24px 이상을 목표로 하고, 주요 버튼은 대부분 40~54px 높이입니다. 체크박스는 클릭 가능한 label 영역을 32px 이상으로 확보합니다.
- 320px 폭을 막는 body 최소 폭을 두지 않고, 모바일 상태 문구/달력 텍스트는 잘림 대신 줄바꿈을 허용합니다.
- `prefers-reduced-motion: reduce`를 지원합니다.

## 자동 검증

- `tests/accessibility-contrast.test.mjs`: v0.29 온라인 오렌지 팔레트 토큰, 핵심 텍스트 4.5:1, 그래픽/포커스 3:1 이상과 승인 색상 목록을 검사
- `tests/accessibility-aa.test.mjs`: 언어, zoom 허용, skip link, form label, tabindex, click handler, focus 여백, 주요 target size, reflow CSS, label-in-name, accessible authentication의 정적 회귀 검사

## 코드만으로 확정할 수 없는 항목

아래는 **실제 렌더링/보조기술 테스트가 필요**합니다.

- 320 CSS px 또는 400% 확대에서 실제 가로 스크롤/겹침이 없는지
- 키보드 Tab/Shift+Tab 순서가 시각적 순서와 자연스럽게 일치하는지
- sticky 상단바, 하단 메뉴, 열린 설정 팝오버가 실제 포커스를 완전히 가리지 않는지
- VoiceOver/NVDA 등에서 버튼 이름, 현재 탭, 펼침 상태, 오류·상태 변경이 의도대로 읽히는지
- 실제 계산된 CSS 기준으로 모든 pointer target이 24×24 또는 spacing 예외를 만족하는지
- 사용자 브라우저의 텍스트 간격 오버라이드에서 잘림/겹침이 없는지
- 색각 이상 환경에서 그래프와 상태가 색만으로 구분되지 않는지

따라서 코드 기준 표현은 **“WCAG 2.2 AA를 목표로 정적 가드와 UI 안전장치를 적용한 상태”**입니다. 수동 항목까지 통과하기 전에는 “AA 인증/완전 적합”이라고 표현하지 않습니다.

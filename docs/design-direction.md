# 화면 디자인 참고와 적용 원칙

2026-09-26 조사. 아래 사이트는 화면 흐름과 접근성 원칙을 참고한 출처입니다. 기존 화면이나 에셋을 복제하지 않고 YPT Web의 공부·기록·그룹 기능에 맞춰 CSS와 SVG를 직접 만들었습니다.

- [Mobbin](https://mobbin.com/) — 실제 모바일·웹 앱 화면의 정보 밀도와 카드 배치를 비교하는 참고 자료.
- [Android Developers: Layouts and navigation patterns](https://developer.android.com/design/ui/mobile/guides/layout-and-content/layout-and-nav-patterns) — 좁은 화면의 하단 탐색과 넓은 화면의 측면 탐색을 구분하는 지침.
- [Apple Human Interface Guidelines: Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars) — 상위 화면 이동을 하단 탭으로 일관되게 제공하는 지침.
- [W3C WCAG 2.2: Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum) — 포인터 조작 영역의 최소 크기 또는 충분한 간격에 관한 기준.

현재 화면은 큰 타이머 카드, 읽기 쉬운 완료 시간 요약, 과목 색 유지, 모바일 하단 3개 탭, 데스크톱 측면 탐색을 사용합니다. 조작 버튼은 가능한 한 높이 44px 이상으로 두고, 키보드 포커스 표시와 휴대폰 안전 영역을 유지합니다. Pretendard를 전 화면에서 사용합니다.


## v0.31 색상 시스템

색은 프로젝트 안에서 임의 생성하지 않고 아래 온라인 팔레트만 사용합니다.

- **Light / soft orange** — ColorsWall Orange scale: https://colorswall.com/palette/353647
  - `#FFF7EC`
  - `#FFEED9`
  - `#FFE5C6`
  - `#FFD49F`
- **Dark / OLED neutral**
  - `#000000`
  - `#121212`
  - `#1E1E1E`
  - `#FFFFFF`
  - `#888888`
- **Dark / orange accent** — ColorsWall: https://colorswall.com/palette/560727
  - `#FFA500`
  - `#CC5500`

### 구현 원칙

`src/style.css` 상단의 `:root`와 `:root[data-theme="dark"]`만 실제 HEX 팔레트를 정의합니다. 컴포넌트에서는 HEX를 직접 쓰지 않고 `--bg`, `--surface`, `--surface-soft`, `--accent`, `--accent-hover`, `--text`, `--text-muted`, `--border`, `--on-accent`, `--focus`만 사용합니다.

새 팔레트로 바꿀 때는 새 override를 추가하지 않고 이 토큰 값만 교체합니다. 과거 팔레트 코드가 런타임에 남지 않도록 자동 테스트가 승인되지 않은 HEX를 거부합니다. 열품타에서 전달되는 사용자 과목색 `subject.color`은 외부 데이터이므로 예외입니다.

다크 테마는 OLED 절전을 위해 `--bg: #000000`을 유지합니다.

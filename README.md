# 🎬 Grok Imagine Auto

Grok Imagine에서 여러 장면의 프롬프트와 참조 이미지를 순서대로 입력하고, 생성된 이미지 또는 비디오를 자동으로 저장하는 Chrome 확장 프로그램입니다.

개인 작업 흐름을 빠르게 만들기 위한 비공식 자동화 도구입니다. Grok 또는 xAI의 공식 제품이 아니며, Grok 화면 구조가 바뀌면 일부 기능이 동작하지 않을 수 있습니다.

## ✨ 주요 기능

- 장면별 프롬프트 자동 입력
- `이미지+프롬프트` 모드와 `프롬프트만` 모드 지원
- `이미지+프롬프트` 모드에서 일부 장면은 참조 이미지 없이 프롬프트만으로 생성 가능
- 단, `이미지+프롬프트` 모드에서는 전체 작업에 최소 1개 이상의 참조 이미지 필요
- 이미지 생성과 비디오 생성 지원
- 이미지 생성 결과 중 첫 번째 생성 이미지만 자동 저장
- 참조 이미지가 함께 표시되는 Grok 결과 화면에서도 첫 번째 생성 이미지를 구분해 저장
- 비디오 해상도 `480p`, `720p` 및 길이 `6s`, `10s` 선택
- 비율 선택: `16:9`, `9:16`, `1:1`, `2:3`, `3:2`
- CSV/TSV로 여러 장면 일괄 입력
- 진행 상태, 중단 상태, 재시도, 건너뛰기 지원
- 결과물을 `Grok Images`, `Grok Videos` 폴더에 번호가 붙은 파일명으로 저장

## 🧩 설치 방법

1. 이 저장소를 내려받거나 압축을 풉니다.
2. Chrome에서 `chrome://extensions`를 엽니다.
3. 오른쪽 위의 `개발자 모드`를 켭니다.
4. `압축해제된 확장 프로그램을 로드`를 클릭합니다.
5. 이 프로젝트 폴더를 선택합니다.
6. 확장 프로그램 아이콘을 클릭하면 Chrome 사이드패널이 열립니다.

코드를 수정한 뒤에는 `chrome://extensions`에서 이 확장 프로그램을 새로고침해야 최신 코드가 반영됩니다.

## 🚀 사용 방법

1. Chrome에서 [Grok Imagine](https://grok.com/imagine)을 열고 로그인합니다.
2. 확장 프로그램 사이드패널을 엽니다.
3. 생성 방식, 이미지/비디오 모드, 비율, 해상도, 길이 등을 선택합니다.
4. 장면별 프롬프트와 필요한 참조 이미지를 입력합니다.
5. `시작` 버튼을 누릅니다.
6. 자동화가 끝날 때까지 Grok 탭을 닫거나 다른 페이지로 이동하지 않습니다.

## 🖼️ 이미지 입력 방식

### 이미지+프롬프트

참조 이미지를 포함해 생성하고 싶을 때 사용합니다.

- 모든 장면에 이미지가 있을 필요는 없습니다.
- 중간 장면은 프롬프트만 입력해도 생성됩니다.
- 전체 작업에서 참조 이미지가 하나도 없으면 실행되지 않습니다.

### 프롬프트만

이미지 없이 텍스트 프롬프트만으로 모든 장면을 생성합니다.

## 📄 CSV/TSV 일괄 입력

장면 수가 많을 때는 CSV 또는 TSV 파일로 프롬프트와 이미지 파일명을 한 번에 채울 수 있습니다.

권장 형식:

```csv
image,prompt
scene-001.png,A calm cinematic shot of a quiet winter village
scene-002.png,A woman walking through a snowy market at dawn
scene-003.png,Steam rising from a large pot in a traditional kitchen
```

주의할 점:

- CSV에는 실제 파일 경로가 아니라 이미지 파일명만 적습니다.
- 이미지 파일은 확장 프로그램 패널에서 별도로 선택해야 합니다.
- 파일명은 CSV의 `image` 값과 선택한 이미지 파일명이 일치해야 자동 매칭됩니다.
- 프롬프트만 필요한 장면은 `image` 값을 비워둘 수 있습니다.

## 💾 저장 위치

Chrome 기본 다운로드 폴더 아래에 저장됩니다.

```text
Downloads/Grok Images
Downloads/Grok Videos
```

파일명은 시작 번호, 접두어, 프롬프트 일부를 조합해 만듭니다.

```text
001_grok-image_prompt-text.jpg
002_grok-video_prompt-text.mp4
```

## 🔐 사용 권한

이 확장 프로그램은 다음 Chrome 권한을 사용합니다.

- `activeTab`: 현재 열린 Grok 탭과 통신
- `scripting`: 필요한 경우 content script 주입
- `downloads`: 생성 결과 저장
- `storage`: 설정값과 진행 상태 저장
- `sidePanel`: 사이드패널 UI 표시
- `unlimitedStorage`: 장면 이미지 임시 저장 용량 제한 완화

호스트 권한은 Grok Imagine 화면과 생성 결과 이미지/비디오 URL에 접근하기 위해 사용됩니다.

## ⚠️ 주의사항

- 이 프로젝트는 개인용 비공식 자동화 도구입니다.
- Grok 또는 xAI의 공식 제품이 아닙니다.
- Grok Imagine UI가 바뀌면 자동화가 실패할 수 있습니다.
- 자동 실행 중에는 Grok 탭을 닫거나 다른 페이지로 이동하지 않는 것이 좋습니다.
- Grok 계정, 요금제, 사용량 제한, 대기 시간에 따라 자동화가 중간에 멈출 수 있습니다.
- 사용자는 Grok 및 관련 서비스의 이용 약관과 정책을 직접 확인하고 준수해야 합니다.

## 🗂️ 프로젝트 구조

```text
manifest.json
background.js
content-shared.js
content-dom-utils.js
content-media-utils.js
content.js
popup.html
popup.css
popup.js
icons/
scripts/
templates/
```

- `background.js`: 다운로드 처리와 사이드패널 열기
- `content.js`: Grok Imagine 자동화 실행 흐름
- `content-shared.js`: 공용 상수와 기본 헬퍼
- `content-dom-utils.js`: DOM 탐색과 클릭 헬퍼
- `content-media-utils.js`: 이미지/미디어 URL 판별 헬퍼
- `popup.*`: 사이드패널 UI와 장면 설정

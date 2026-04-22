# Grok Imagine Video Automator

Grok Imagine에서 여러 장면의 프롬프트와 이미지를 순서대로 입력해 이미지 또는 비디오를 생성하고, 결과물을 번호가 붙은 파일명으로 저장하는 Chrome 확장프로그램입니다.

개인 작업을 편하게 하기 위해 만든 비공식 자동화 도구입니다. Grok 또는 xAI의 공식 제품이 아니며, Grok 화면 구조가 바뀌면 동작이 깨질 수 있습니다.

## 주요 기능

- 장면별 프롬프트를 순서대로 자동 입력
- 이미지+프롬프트 또는 프롬프트만 모드 지원
- 이미지 / 비디오 생성 모드 지원
- 비디오 해상도 480p / 720p 지원
- 비디오 길이 6s / 10s 지원
- 비율 선택: 16:9, 9:16, 1:1, 2:3, 3:2
- 480p 비디오 생성 후 업스케일 자동 시도
- 이미지 생성 결과의 첫 번째 이미지를 자동 저장
- 결과물을 `Grok Videos` 또는 `Grok Images` 폴더에 저장
- 파일명 접두어와 시작 번호 설정
- CSV/TSV 파일로 여러 장면 일괄 입력
- 진행 상태와 오류 메시지를 사이드패널에 표시

## 설치 방법

1. 이 저장소를 내려받거나 압축을 풉니다.
2. Chrome에서 `chrome://extensions`를 엽니다.
3. 오른쪽 위의 `개발자 모드`를 켭니다.
4. `압축해제된 확장 프로그램을 로드`를 클릭합니다.
5. 이 저장소 폴더를 선택합니다.
6. 확장프로그램 아이콘을 클릭하면 오른쪽 사이드패널이 열립니다.

수정한 뒤에는 `chrome://extensions`에서 이 확장프로그램을 새로고침해야 최신 코드가 반영됩니다.

## 사용 방법

1. Chrome에서 [https://grok.com/imagine](https://grok.com/imagine)을 열고 로그인합니다.
2. 확장프로그램 아이콘을 눌러 사이드패널을 엽니다.
3. 생성 방식, 품질, 비율 등 설정을 선택합니다.
4. 장면별 프롬프트와 필요한 이미지를 입력합니다.
5. `시작` 버튼을 누릅니다.
6. 자동화가 끝날 때까지 Grok 탭을 닫거나 다른 페이지로 이동하지 않습니다.

## CSV/TSV로 장면 채우기

장면 수가 많을 때는 CSV 또는 TSV 파일로 장면을 한 번에 채울 수 있습니다.

권장 형식:

```csv
image,prompt
scene-01.png,A calm cinematic shot of a quiet winter village
scene-02.png,A woman walking through a snowy market at dawn
scene-03.png,Steam rising from a large pot in a traditional kitchen
```

사용 순서:

1. `image`와 `prompt` 열을 만듭니다.
2. `image` 열에는 실제 이미지 파일명을 적습니다.
3. `prompt` 열에는 해당 장면의 프롬프트를 적습니다.
4. 파일을 `CSV UTF-8` 또는 `TSV`로 저장합니다.
5. 확장패널에서 `CSV/TSV로 장면 채우기`를 엽니다.
6. 표 파일을 선택하고, 이미지 파일들을 여러 장 선택합니다.
7. `표 내용으로 채우기`를 누릅니다.

브라우저 보안상 CSV 안의 로컬 파일 경로를 직접 읽을 수는 없습니다. CSV에는 파일 경로 대신 파일명을 적고, 실제 이미지 파일은 확장패널에서 따로 선택해야 합니다.

## 다운로드 위치와 파일명

Chrome의 기본 다운로드 폴더 아래에 저장됩니다.

```text
Downloads/Grok Videos
Downloads/Grok Images
```

파일명은 시작 번호와 파일명 접두어를 사용합니다.

```text
01_grok-video_prompt-text.mp4
02_grok-image_prompt-text.png
```

## 권한 설명

이 확장프로그램은 다음 작업을 위해 Chrome 권한을 사용합니다.

- `activeTab`: 현재 열린 Grok Imagine 탭과 통신
- `scripting`: 필요한 경우 content script 주입
- `downloads`: 생성 결과 저장
- `storage`: 설정값과 진행 상태 저장
- `sidePanel`: Chrome 사이드패널 UI 표시
- `unlimitedStorage`: 장면 이미지 임시 저장 용량 제한 완화

호스트 권한은 Grok Imagine과 생성 결과 이미지/비디오 URL에 접근하기 위해 사용합니다.

## 주의사항

- 이 프로젝트는 개인용/실험용 비공식 도구입니다.
- Grok 또는 xAI의 공식 제품이 아닙니다.
- Grok Imagine의 UI 구조가 바뀌면 자동화가 동작하지 않을 수 있습니다.
- Grok 계정, 요금제, 사용량 제한, 대기 시간에 따라 자동화가 중간에 멈출 수 있습니다.
- 자동화 실행 중에는 Grok 탭을 닫거나 다른 페이지로 이동하지 않는 것이 좋습니다.
- 사용자는 Grok 및 관련 서비스의 이용 약관과 정책을 직접 확인하고 준수해야 합니다.
- 대량 생성, 스팸, 저작권 침해, 타인에게 피해를 주는 용도로 사용하지 마세요.

## 프로젝트 구조

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
```

- `background.js`: 다운로드 처리와 사이드패널 열기
- `content.js`: Grok Imagine 자동화 실행 흐름
- `content-shared.js`: 공용 상수와 기본 헬퍼
- `content-dom-utils.js`: DOM 클릭/탐색 헬퍼
- `content-media-utils.js`: 이미지/미디어 URL 판별 헬퍼
- `popup.*`: 사이드패널 UI

## License

아직 별도 라이선스를 정하지 않았습니다. 공개 저장소로 사용하더라도, 라이선스가 추가되기 전까지는 명시적인 허가 없이 재배포나 상업적 사용을 허용하지 않습니다.

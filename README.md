# Grok Imagine Video Automator

Grok Imagine에서 장면별 이미지와 프롬프트를 순서대로 넣어 이미지 또는 영상을 자동 생성하고, 결과물을 번호가 붙은 파일명으로 다운로드하는 Chrome 확장프로그램입니다.

## 주요 기능

- 장면별 이미지 1개와 프롬프트 1개를 묶어서 순차 실행
- 여러 장면을 한 번에 등록하고 자동 생성
- 생성 설정 선택 지원
  - 이미지 / 비디오
  - 480p / 720p
  - 6s / 10s
  - 16:9 / 9:16
- 480p 영상 생성 후 업스케일 자동 시도
- 720p 영상은 업스케일 없이 바로 다운로드
- 다운로드 파일명 앞에 순번 자동 추가
- 프롬프트 입력값 자동 저장
- 모든 프롬프트 한 번에 지우기
- CSV/TSV 파일로 장면 일괄 입력
- Chrome 사이드패널 UI 지원

## 설치 방법

1. Chrome에서 `chrome://extensions`를 엽니다.
2. 오른쪽 위의 `개발자 모드`를 켭니다.
3. `압축해제된 확장 프로그램을 로드`를 클릭합니다.
4. 이 폴더를 선택합니다.

```text
C:\Users\user\Desktop\grok-video-auto
```

5. 확장프로그램 아이콘을 클릭하면 오른쪽 사이드패널이 열립니다.

## 사용 방법

1. Chrome에서 [https://grok.com/imagine](https://grok.com/imagine)을 열고 로그인합니다.
2. 확장프로그램 아이콘을 눌러 사이드패널을 엽니다.
3. 생성 설정을 선택합니다.
4. 장면별로 이미지와 프롬프트를 입력합니다.
5. `시작` 버튼을 누릅니다.
6. Grok 화면을 그대로 둔 상태에서 자동화가 끝날 때까지 기다립니다.

## CSV/TSV로 장면 채우기

장면 수가 많을 때는 엑셀이나 스프레드시트에서 CSV 또는 TSV 파일을 만들어 한 번에 입력할 수 있습니다.

엑셀 템플릿은 `templates/grok-imagine-scenes-template.xlsx` 파일을 사용하면 됩니다. 확장프로그램에 넣을 때는 이 파일을 엑셀에서 `CSV UTF-8`로 다시 저장하거나, 바로 `templates/grok-imagine-scenes-template.csv` 파일을 사용하세요.

중요: 확장프로그램은 `.xlsx` 파일을 직접 읽지 않습니다. `.xlsx`를 그대로 넣으면 글자가 깨질 수 있습니다.

권장 형식은 아래와 같습니다.

```csv
image,prompt
scene-01.png,A calm cinematic shot of a quiet winter village
scene-02.png,A woman walking through a snowy market at dawn
scene-03.png,Steam rising from a large pot in a traditional kitchen
```

사용 순서:

1. 엑셀에서 `image`와 `prompt` 열을 만듭니다.
2. `image` 열에는 실제 이미지 파일명을 적습니다.
3. `prompt` 열에는 해당 장면의 프롬프트를 적습니다.
4. 파일을 `CSV UTF-8` 또는 `TSV`로 저장합니다. `.xlsx` 그대로 넣지 마세요.
5. 확장패널에서 `CSV/TSV로 장면 채우기`를 펼칩니다.
6. 표 파일을 선택하고, 이미지 파일들을 여러 장 선택합니다.
7. `표 내용으로 채우기`를 누릅니다.

브라우저 보안상 CSV 안에 적힌 로컬 파일 경로를 직접 읽을 수는 없습니다. 대신 CSV의 이미지 파일명과 사용자가 선택한 이미지 파일명을 비교해서 자동 매칭합니다. `woman_story (1)`처럼 확장자 없이 적어도 `woman_story (1).png`와 매칭됩니다.

## 생성 설정

기본값은 다음과 같습니다.

```text
비디오 / 480p / 6s / 16:9
```

설정별 동작은 아래와 같습니다.

- `비디오 + 480p`: 영상 생성 후 업스케일을 시도하고 다운로드합니다.
- `비디오 + 720p`: 업스케일 없이 생성된 영상을 바로 다운로드합니다.
- `이미지`: 이미지 생성 후 이미지 파일을 다운로드합니다.

## 다운로드 위치와 파일명

Chrome의 기본 다운로드 폴더 아래에 저장됩니다.

영상은 기본적으로 아래 폴더에 저장됩니다.

```text
Downloads/Grok Videos
```

이미지는 아래 폴더에 저장됩니다.

```text
Downloads/Grok Images
```

파일명은 시작 번호와 파일명 접두어를 사용합니다.

```text
01_grok-video_프롬프트 일부.mp4
02_grok-video_프롬프트 일부.mp4
```

## 주의사항

- Grok Imagine의 화면 구조가 바뀌면 자동화 선택자가 동작하지 않을 수 있습니다.
- 이미지 파일 선택값은 브라우저 보안상 영구 저장되지 않습니다. 확장패널을 다시 열면 이미지는 다시 선택해야 할 수 있습니다.
- 프롬프트와 설정값은 자동 저장됩니다.
- 자동화 실행 중에는 Grok 탭을 닫거나 다른 페이지로 이동하지 않는 것이 좋습니다.
- Grok의 생성 제한, 대기 시간, 요금제 제한에 따라 자동화가 중간에 멈출 수 있습니다.
- Chrome이 아이콘이나 확장 파일을 캐시할 수 있으므로 수정 후에는 `chrome://extensions`에서 확장프로그램을 새로고침하세요.

## 개발 메모

이 확장프로그램은 Manifest V3 기반으로 구성되어 있습니다.

- `manifest.json`: 확장프로그램 권한, 사이드패널, 아이콘 설정
- `background.js`: 다운로드와 사이드패널 열기 처리
- `content.js`: Grok Imagine 페이지 자동 조작
- `popup.html`: 사이드패널 UI
- `popup.css`: 사이드패널 스타일
- `popup.js`: UI 입력값 저장과 자동화 시작 처리

## 면책

이 프로젝트는 개인 자동화 용도로 만든 비공식 도구입니다. Grok 또는 xAI의 공식 제품이 아닙니다.

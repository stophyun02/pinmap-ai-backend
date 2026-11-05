# Pinmap AI 게시물 요약 백엔드

이미 수집된 Instagram 자료를 서버가 OpenAI에 보내 요약합니다. 실행 중에 사람이 게시물을 읽어 요약을 대신 작성하지 않습니다. Meta API와 Instagram 로그인은 사용하지 않습니다.

## 실행

저장소를 내려받은 뒤 폴더에서 `npm ci`를 실행합니다. `npm start` 또는 저장소 안의 `AI_게시물요약_열기.command`로 서버를 시작합니다. macOS 실행 파일은 화면도 함께 엽니다.

1. http://127.0.0.1:8101/ 에서 **OpenAI API 키**를 직접 입력하고 **키 적용**을 누릅니다. Meta 토큰과 별개이며, 키는 서버 메모리에만 보관합니다.
2. 게시물을 선택하고 처리 개수를 1로 둔 뒤 **선택 게시물 요약**을 누릅니다.
3. 처리 결과의 행을 누르면 요약·추출 정보·근거·실제 토큰 사용량을 볼 수 있습니다.
4. 시험 결과를 확인한 후 선택 항목 또는 처리 개수를 늘립니다. API 사용료는 입력한 키의 OpenAI 계정에 청구됩니다.

서버가 종료되면 화면에서 키를 다시 입력합니다. 이미 완료된 같은 자료는 재사용합니다. **같은 입력의 기존 요약도 새로 생성**을 선택하면 유료 호출을 다시 수행합니다. 진행 중인 중복 요청은 재사용합니다.

개발용 실행: Node.js 22 이상에서 `npm ci`, `npm start`. FFmpeg 설치 스크립트의 실행을 차단하는 환경이라면 패키지에 명시된 `ffmpeg-static` 설치 스크립트를 허용한 뒤 설치합니다. 테스트는 `npm test`입니다. 서버는 127.0.0.1에서만 연결됩니다. 외부 공개 서비스로 배포하려면 사용자 인증과 계정별 저장소·요금 제한을 추가해야 합니다.

## 입력과 분석 범위

- 기본 시험 데이터는 `fixtures/instagram-export/`에 있습니다. 원본 내보내기 ZIP과 이를 변환한 저장 게시물 349건(캡션 341건)을 포함합니다. ZIP에는 사진·영상이 없습니다. 캡션 요약을 시험하려면 화면의 **사진·영상이 확보된 게시물만 처리**를 끄고 캡션이 있는 게시물을 선택하세요.
- 입력 경로는 `.env`의 `SOURCE_ROOT`를 우선합니다. 설정하지 않으면 기존 로컬 폴더인 `../pinmap-items.json`이 있을 때 그 자료와 `../collector/results/evidence/`를 사용하고, 없으면 포함된 시험 데이터를 불러옵니다.
- 기존 컬렉션명·저장 이유·사람이 작성한 예시 요약은 AI 입력에 넣지 않습니다. 원본 ZIP의 컬렉션 정보는 보존하되 요약 입력에는 사용하지 않습니다.
- 현재 수집 자료가 화면 캡처라면 화면에 있는 일부만 분석합니다. 원본 영상 파일이 없으면 영상 전체나 음성을 분석한 것으로 표시하지 않습니다.
- 원본 사진·캐러셀·영상 파일은 화면의 **원본 사진·영상 추가**로 해당 게시물에 연결합니다. 업로드한 자료가 있으면 이전 화면 캡처 대신 업로드한 파일을 사용합니다. 여러 파일은 선택 순서대로 처리합니다.
- 사진은 최대 24장, 영상은 게시물당 총 10분까지 처리합니다. 영상은 실제 시각을 기록한 프레임을 추출하고, 음성이 있으면 전사한 뒤 함께 요약합니다. 프레임 사이의 장면은 분석하지 않았으므로 영상 결과는 일부 분석으로 기록됩니다.
- 이미지 최대 20MB, 영상·음성 파일 최대 150MB, 한 번의 업로드 전체 160MB입니다. PNG·JPG·WEBP·MP4·MOV·WEBM·MP3·WAV·M4A·OGG를 지원합니다.
- 사진·영상 입력이 없는 항목은 기본적으로 제외합니다. 해당 옵션을 끄면 확보된 캡션·음성만으로 처리할 수 있습니다.
- 원본 링크의 접속, 원본 미디어 다운로드, 좋아요·댓글 수 조회는 수행하지 않습니다.

## AI 호출과 결과

사진·프레임·캡션 요약은 `gpt-4.1-mini`, 음성 전사는 `gpt-4o-mini-transcribe`를 기본으로 사용합니다. 서버는 OpenAI 공식 REST API만 호출합니다. 요약 요청은 `store: false`로 보냅니다.

요약 결과의 JSON 형식은 `lib/contract.mjs`의 `RESULT_SCHEMA`입니다.

- `title`, `summary`, `topics`: 제목·요약·콘텐츠 주제
- `visible_text`: 이미지에서 읽은 텍스트
- `facts`: 장소·주소·날짜·가격·제품·도구·레시피 등 원문에 명시된 항목
- `inferences`: AI의 해석·추측
- `limitations`: 읽지 못한 자료·분석 한계
- `evidence_ids`: 각각의 근거가 된 캡션·이미지·영상 프레임·음성 전사의 ID

서버는 JSON 형식과 근거 ID의 존재를 검사합니다. 내용의 사실성 자체를 보증하지는 않으며, 외부 사실 확인도 수행하지 않습니다. 원문에 없는 값은 추출하지 않도록 지시합니다.

각 작업에는 분석 범위(`coverage`), 프레임 시각, 음성 전사, 입력 지문, 모델·프롬프트 버전, 실제 API 응답 ID, 토큰 사용량이 함께 저장됩니다. 음성 전사의 시간 근거는 전체 음성 구간 단위이며 문장별 시각을 만들어 넣지 않습니다.

## 저장 위치와 오류 처리

- `.data/jobs/`: 작업 상태와 입력 스냅샷
- `.data/results/`: 실제 AI 응답에 근거한 완료 결과
- `.data/assets/`: 업로드 원본
- `.data/work/`: 영상 프레임·추출 음성
- `.data/server.log`: 실행 기록. API 키·본문은 로그에 출력하지 않습니다.

호출은 한 번에 1건씩 실행합니다. 인증·요금·호출 한도 오류가 나면 대기열이 멈춥니다. 네트워크가 끊기거나 서버가 실행 중 종료되면 중복 과금을 피하려고 해당 호출을 자동 반복하지 않습니다. 키나 결제 상태를 해결한 뒤 대기열을 재개하고, 실패한 항목은 직접 다시 등록하세요.

이 버전은 결과 JSON을 로컬에 저장합니다. 기존 Google Sheets에 AI 결과를 쓰는 연결은 포함하지 않습니다.

## 다른 화면에서 연결하는 API

모든 경로는 `http://127.0.0.1:8101` 기준입니다. JSON 요청은 `Content-Type: application/json`을 사용합니다. 서버 설정과 키 입력은 같은 로컬 화면에서 수행하세요.

| 요청 | 용도 |
| --- | --- |
| `GET /api/state` | 연결 여부·자료 개수·대기열 상태 |
| `GET /api/posts` | 게시물 ID와 확보된 입력 자료 목록 |
| `POST /api/settings` | `{ "api_key": "..." }` 서버 메모리에 적용 |
| `POST /api/jobs` | `{ "post_ids": ["게시물 ID"], "limit": 1, "require_visual": true, "force": false }` |
| `GET /api/jobs` | 작업 목록 |
| `GET /api/jobs/{job_id}` | 특정 작업의 상태·결과 |
| `GET /api/results` | 완료된 결과 JSON |
| `POST /api/posts/{post_id}/assets` | multipart `files`, `complete` 업로드 |
| `POST /api/queue/pause` | 현재 작업 후 대기열 정지 |
| `POST /api/queue/resume` | 대기열 재개 |
| `POST /api/jobs/{job_id}/cancel` | 작업 취소 |
| `POST /api/catalog/refresh` | 로컬 수집 파일 다시 읽기 |

자동 테스트의 응답은 합성 자료에 대한 모의 응답이며, 실제 유료 호출의 성공으로 취급하지 않습니다.

시험 데이터는 `npm run prepare:data`로 ZIP 원본에서 다시 만들 수 있습니다. 이 변환에만 Python 3가 필요합니다. 실제 내보내기 자료를 포함한 비공개 저장소이며 API 키, 수집 캡처, 실행 로그, 생성한 AI 결과는 업로드하지 않습니다. 자세한 구성은 `fixtures/instagram-export/README.md`를 참고하세요.

구현 참고: [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [이미지 입력](https://developers.openai.com/api/docs/guides/images-vision), [음성 전사](https://developers.openai.com/api/docs/guides/speech-to-text).

# Pinmap 다중 사용자 서버

## 현재 구현

각 사용자는 초대 코드로 계정을 만들고 로그인합니다. Instagram 내보내기 ZIP 또는 개별 링크를 자기 계정으로 가져온 뒤 원본 사진·영상을 추가하고 AI 작업을 요청할 수 있습니다. 로그인한 사용자만 자신의 게시물, 파일, 작업 상태, 결과를 조회할 수 있습니다. ZIP에 원본 사진·영상이 없으면 별도로 업로드해야 합니다. Meta API는 호출하지 않습니다.

API와 AI 작업자는 별도 프로세스이며 같은 SQLite WAL 데이터베이스와 미디어 디렉터리를 공유합니다. 대기 작업은 재시작 후에도 남습니다. 작업 중 서버가 끊긴 항목은 20분 후 `needs_review`가 되며, AI 중복 호출을 막기 위해 자동 재시도하지 않습니다. 같은 사용자의 AI 작업은 동시에 1건만 실행되고, 전체 동시 실행 수는 `WORKER_CONCURRENCY`로 제한합니다. 계정당 24시간 AI 작업은 기본 50건, 대기·진행 작업은 25건, 미디어는 2GB, 게시물당 미디어는 40개로 제한합니다.

## 이 컴퓨터에서 시작

Node.js 22 이상, Ollama와 이미지 모델이 필요합니다. `npm ci`를 실행하고 `.env.multiuser.example`을 `.env`로 복사해 긴 임의의 `PINMAP_INVITE_CODE`를 설정하세요. `MULTIUSER_AI_PROVIDER=ollama`, `MULTIUSER_MODEL=qwen2.5vl:3b`로 두고 모델을 설치합니다. 터미널 두 개에서 각각 `npm start`, `npm run worker`를 실행한 뒤 [http://127.0.0.1:8200/](http://127.0.0.1:8200/)을 엽니다. 기존 `.env`에 OpenAI 키가 있더라도 새 서버는 이 키를 읽어 AI 제공자에게 전달하지 않습니다.

개발용 로컬 계정의 자료는 `.multiuser-data/`에 저장됩니다. 사용자마다 ZIP을 다시 가져와야 하며, 저장소에 포함된 349건 ZIP이 새 가입자의 계정에 자동으로 들어가지는 않습니다. 기존 1인용 자료를 자신의 새 계정으로 옮길 때는 먼저 화면에서 가입한 뒤 `npm run migrate:legacy -- 본인_이메일`을 한 번 실행합니다. 기존 게시물, 확보한 화면 캡처와 완료된 Ollama 결과만 복사하며 원본 파일을 지우지 않습니다. 다시 실행하면 이미 옮긴 항목은 건너뜁니다.

## 인터넷 서버에 배포

단일 호스트에서 Docker, HTTPS 도메인, 영속 디스크, 별도 GPU 추론 서버를 준비합니다. `compose.yaml`은 API, 작업자, HTTPS 프록시를 같은 호스트에서 시작하고 영속 볼륨을 공유합니다. `.env`에는 실제 `PINMAP_DOMAIN`, 긴 임의의 `PINMAP_INVITE_CODE`, `MULTIUSER_AI_PROVIDER=vllm`, `MULTIUSER_MODEL`과 작업자만 접근 가능한 `VLLM_BASE_URL`, `VLLM_API_KEY`를 설정합니다. 공개 주소는 자동으로 `https://<도메인>`이 됩니다. `docker compose up -d --build`로 시작합니다. vLLM 추론 서버는 이 Compose에 포함되지 않습니다. GPU 종류와 모델이 결정된 뒤 별도로 띄워야 합니다.

vLLM 후보 모델은 이미지 입력이 가능한 `Qwen/Qwen2.5-VL-3B-Instruct`입니다. 실제 GPU 메모리, 영상 프레임 수, 사용자 요청 길이로 부하 시험을 한 뒤 모델과 `WORKER_CONCURRENCY`를 결정하세요. 사용자 100명이 등록되어도 AI 동시 요청 100건을 바로 실행하지 않습니다. 대기열에서 처리하고 결과는 인증된 `GET /api/jobs/{id}` 또는 `GET /api/results`로 전달합니다. 음성 전사는 현재 다중 사용자 작업자에 연결되지 않았고, 결과에 분석하지 않았다는 한계를 기록합니다.

SQLite 방식은 **한 호스트의 영속 볼륨**을 전제로 합니다. API와 작업자를 여러 호스트에 나눠 배포하려면 PostgreSQL과 공유 객체 저장소로 옮겨야 합니다. 운영 전에 디스크 백업·복구 시험, HTTPS 도메인, 초대 코드 관리, 로그·관측, 악용 방지와 처리량 시험을 완료해야 합니다. 이 저장소의 구현만으로 인터넷에 배포됐거나 100명 동시 부하가 검증된 것은 아닙니다. vLLM HTTP 서버는 인터넷에 직접 노출하지 마세요.

## API 요약

브라우저 화면은 모든 변경 요청에 `X-Pinmap-CSRF: 1`을 넣습니다. 로그인 세션은 HttpOnly 쿠키이며 HTTPS 배포에서는 Secure 속성이 적용됩니다. 모든 자료 조회와 등록은 세션 사용자 ID로 제한됩니다.

| 경로 | 용도 |
| --- | --- |
| `POST /api/auth/register`, `/api/auth/login`, `/api/auth/logout` | 가입·로그인·로그아웃 |
| `GET /api/me` | 계정과 분석 설정 |
| `POST /api/import/instagram` | `file` 필드에 Instagram 내보내기 ZIP 입력 |
| `POST /api/posts`, `GET /api/posts`, `GET /api/posts/{id}` | 링크·캡션 등록 및 조회 |
| `POST /api/posts/{id}/assets`, `GET /api/assets/{id}` | 원본 사진·영상 업로드 및 인증된 보기 |
| `POST /api/jobs`, `GET /api/jobs`, `GET /api/jobs/{id}` | 분석 요청과 상태·결과 |
| `POST /api/jobs/{id}/cancel`, `GET /api/results` | 대기 작업 취소 및 결과 목록 |

작업 입력의 ZIP 저장 시각은 게시물 작성 시각으로 해석하지 않습니다. AI에는 작성자 캡션·사용자가 제공한 미디어만 전달하며 저장 이유와 컬렉션명은 보내지 않습니다. 결과에는 사용한 증거 ID와 분석 범위를 보관합니다. 개인 ZIP은 Docker 이미지에서 제외됩니다.

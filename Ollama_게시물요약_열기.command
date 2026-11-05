#!/bin/zsh
cd "${0:A:h}" || exit 1
if ! command -v ollama >/dev/null; then
  echo 'Ollama를 먼저 설치하세요: https://ollama.com/download'
  exit 1
fi
if ! curl -fsS --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null; then
  echo 'Ollama 서버를 시작하세요: ollama serve'
  exit 1
fi
AI_PROVIDER=ollama PORT=8102 npm run start:background || exit 1
open http://127.0.0.1:8102/

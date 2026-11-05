#!/usr/bin/env bash
# Free, offline LLM planner for JobPay Agent: llama.cpp + Qwen2.5-3B-Instruct (Apache-2.0, ~2.1 GB, CPU-only).
# Usage:  bash scripts/local-llm.sh        # downloads once into ./.llm, serves http://localhost:8088/v1
# Then:   OPENAI_BASE_URL=http://localhost:8088/v1 OPENAI_MODEL=qwen2.5-3b-instruct bun run start
# Linux x64 build shown; on macOS: `brew install llama.cpp` and run llama-server with the same flags.
set -euo pipefail
DIR="${LLM_DIR:-.llm}"; mkdir -p "$DIR"; cd "$DIR"
LLAMA_TAG="${LLAMA_TAG:-b12138}"
MODEL="qwen2.5-3b-instruct-q4_k_m.gguf"
if ! command -v llama-server >/dev/null && [ ! -x "llama-$LLAMA_TAG/llama-server" ]; then
  curl -fL -o llama.tgz "https://github.com/ggml-org/llama.cpp/releases/download/$LLAMA_TAG/llama-$LLAMA_TAG-bin-ubuntu-x64.tar.gz"
  tar xzf llama.tgz
fi
[ -f "$MODEL" ] || curl -fL -o "$MODEL" "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/$MODEL"
BIN="$(command -v llama-server || echo "./llama-$LLAMA_TAG/llama-server")"
exec "$BIN" -m "$MODEL" --jinja --port "${LLM_PORT:-8088}" -c 8192

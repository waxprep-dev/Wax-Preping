#!/bin/bash
mkdir -p models

echo "[WaxPrep] Downloading Phi-4 Mini (1.9GB) — Backend Brain..."
curl -L "https://huggingface.co/bartowski/phi-4-mini-GGUF/resolve/main/phi-4-mini-Q4_K_M.gguf" \
  -o models/phi-4-mini.Q4_K_M.gguf \
  --progress-bar

echo "[WaxPrep] Downloading Llama 3.2 1B (0.5GB) — Fast Router..."
curl -L "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf" \
  -o models/llama-3.2-1b.Q4_K_M.gguf \
  --progress-bar

echo "[WaxPrep] Models downloaded. Run: docker-compose up"
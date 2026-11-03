#!/usr/bin/env bash
# Atualiza a Sala Privada neste host: puxa do GitHub o que teve push, reconstrói a
# imagem e reinicia o container. Rode na pasta do projeto:  ./update.sh
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "Falta .env — copie de .env.example e preencha antes de atualizar." >&2
  exit 1
fi

echo "==> git pull ($(git rev-parse --abbrev-ref HEAD))"
git pull --ff-only

echo "==> build + up (reconstrói se o código mudou)"
docker compose up -d --build

echo "==> removendo imagens órfãs"
docker image prune -f >/dev/null || true

echo "==> status"
echo "No ar: $(git log -1 --format='%h %s')"
docker compose ps
echo
sleep 3
docker compose logs --tail=30 sala-privada

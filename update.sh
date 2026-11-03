#!/bin/bash
# Atualiza a Sala Privada no servidor com o que está no GitHub: só entra no ar o que já teve push.
# Uso, no servidor: cd ~/sala-privada && ./update.sh
set -euo pipefail
cd "$(dirname "$0")"

branch=$(git rev-parse --abbrev-ref HEAD)
echo "==> Baixando a branch $branch do GitHub..."
git fetch --quiet origin "$branch"
# Só avança: se alguém mexeu nos arquivos aqui no servidor, para em vez de misturar.
git merge --ff-only --quiet "origin/$branch"

echo "==> Montando o app e reiniciando o container..."
docker compose up -d --build
docker image prune -f >/dev/null

echo "==> No ar: $(git log -1 --format='%h %s')"

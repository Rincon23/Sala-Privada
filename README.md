# Sala Privada

Uma sala só para a galera: voz, câmera, quantas telas e janelas quiser ao mesmo tempo, música do YouTube tocando sincronizada para todo mundo e chat. Entra só com o nome e dá para instalar como app no PC e no celular.

- **Site e sinalização:** Node.js num container, publicado pelo Cloudflare Tunnel (sem abrir portas).
- **Voz, vídeo e telas:** Cloudflare Realtime (SFU). Grátis até 1.000 GB por mês; o app para câmera e telas em 900 GB para nunca passar disso.
- **Música:** player do YouTube em cada pessoa, sincronizado pelo servidor.
- **Arquivos:** envio em pedaços de 32 MB (passa do limite de 100 MB do Cloudflare), até 10 GB cada; somem sozinhos depois de 24 h.
- **Mesa de sons:** 11 efeitos gerados por código (`npm run sounds`) e qualquer pessoa pode adicionar os seus (até 2 MB e 15 s).
- **Monitor:** se o áudio ou a câmera de alguém para de chegar, o app refaz a conexão sozinho; se o problema é de quem transmite, o servidor pede para o app dessa pessoa reconectar.

## Lendo os logs

```bash
docker logs -f sala-privada
```

Cada problema aparece com o que aconteceu e, logo abaixo, **→ O que fazer**. Erros que se repetem viram um contador em vez de lotar o log.

## Rodando no servidor

```bash
cd ~/sala-privada
cp .env.example .env   # e preencha as chaves do Realtime
docker compose up -d --build
```

No Cloudflare Tunnel, a rota de `live.rincon.dev.br` aponta para `http://172.17.0.1:8380` (o cloudflared roda em Docker na rede padrão).

### Chaves do Cloudflare Realtime

No painel da Cloudflare: **Realtime → Serverless SFU → Create**. Copie o App ID e o App Secret para o `.env`:

```
REALTIME_APP_ID=...
REALTIME_APP_SECRET=...
```

Depois recrie o container: `docker compose up -d --force-recreate`.

### Outras opções do `.env`

| Variável | Para quê |
|---|---|
| `ROOM_PASSWORD` | Senha da sala. Vazio = entra só com o nome. |
| `MONTHLY_LIMIT_GB` | Quanto do plano grátis pode ser usado antes de pausar câmera e telas (padrão 900). |
| `FILE_TTL_HOURS` | Depois de quantas horas um arquivo enviado some (padrão 24). |
| `FILE_MAX_GB` | Tamanho máximo de cada arquivo (padrão 10). |
| `FILES_TOTAL_GB` | Espaço total para arquivos no servidor (padrão 50). |

## Desenvolvendo

```bash
npm install
npm start          # http://localhost:8380
npm run icons      # regera os PNGs do app a partir do desenho em scripts/make-icons.mjs
```

Sem as chaves do Realtime, o chat e a música funcionam; voz e vídeo ficam desligados.

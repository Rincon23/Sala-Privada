# Sala Privada

Uma sala só para a galera: voz, câmera, quantas telas e janelas quiser ao mesmo tempo, música do YouTube tocando sincronizada para todo mundo e chat. Entra só com o nome e dá para instalar como app no PC e no celular.

- **Site e sinalização:** Node.js num container, publicado pelo Cloudflare Tunnel (sem abrir portas).
- **Voz, vídeo e telas:** Cloudflare Realtime (SFU). Grátis até 1.000 GB por mês; o app para câmera e telas em 900 GB para nunca passar disso.
- **Música:** player do YouTube em cada pessoa, sincronizado pelo servidor.

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

## Desenvolvendo

```bash
npm install
npm start          # http://localhost:8380
npm run icons      # regera os PNGs do app a partir do desenho em scripts/make-icons.mjs
```

Sem as chaves do Realtime, o chat e a música funcionam; voz e vídeo ficam desligados.

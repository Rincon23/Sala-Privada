# Sala Privada

Uma sala só para a galera: canais de texto que guardam mensagens e imagens, salas de voz com câmera e quantas telas e janelas quiser, música do YouTube sincronizada em cada sala de voz. Cada pessoa entra com a própria conta (e-mail e senha) e dá para instalar como app no PC e no celular.

- **Contas:** a pessoa cria a conta com nome, e-mail e senha (sem confirmar e-mail). Para criar, precisa da senha da sala (`ROOM_PASSWORD`); depois é só e-mail e senha, e o aparelho fica lembrado por 180 dias. Dá para trocar o nome e a senha em Configurações.
- **Admin:** a conta do `ADMIN_EMAIL` é o host, com a senha do `ADMIN_PASSWORD`. Em Configurações → Painel de admin dá para criar servidores, escolher quem entra em cada um, dar uma senha nova para quem esqueceu e apagar contas. Só o host dá e tira o cargo de admin de outras contas; quem recebe pode todo o resto, menos mexer na conta de outro admin.
- **Servidores:** o principal ("Sala Privada") é aberto a todas as contas. Os outros só aparecem para quem o admin colocar como membro. Troca-se de servidor clicando no nome dele, em cima da lista de canais.
- **Canais de texto:** qualquer pessoa cria, renomeia e apaga pelo **+** e pela engrenagem na lista à esquerda. Tudo fica guardado: texto, imagens (dá para colar com Ctrl+V ou arrastar para o chat) e arquivos de até 25 MB. Quem mandou pode apagar a própria mensagem.
- **Salas de voz:** clicar numa sala entra nela. Cada sala tem a sua voz, câmeras, telas, música, mesa de sons e um chat ao lado. Quem está em outra sala não ouve nem vê nada, e o servidor também barra isso.

- **Site e sinalização:** Node.js num container, publicado pelo Cloudflare Tunnel (sem abrir portas).
- **Voz, vídeo e telas:** Cloudflare Realtime (SFU). Grátis até 1.000 GB por mês; o app para câmera e telas em 900 GB para nunca passar disso.
- **Música:** player do YouTube em cada pessoa, sincronizado pelo servidor.
- **Arquivos:** envio em pedaços de 32 MB (passa do limite de 100 MB do Cloudflare), até 10 GB cada; somem sozinhos depois de 24 h.
- **Mesa de sons:** 11 efeitos gerados por código (`npm run sounds`) e qualquer pessoa pode adicionar os seus, de até 3 minutos (WAV grande demais vira um WAV menor antes de subir). Só um admin tira sons da mesa.
- **Monitor:** se o áudio ou a câmera de alguém para de chegar, o app refaz a conexão sozinho; se o problema é de quem transmite, o servidor pede para o app dessa pessoa reconectar.

## Lendo os logs

```bash
docker logs -f sala-privada
```

Cada problema aparece com o que aconteceu e, logo abaixo, **→ O que fazer**. Erros que se repetem viram um contador em vez de lotar o log.

## Rodando no servidor

O servidor monta o app a partir da `main` no GitHub, nunca do PC: só entra no ar o que já teve **push** na `main`.

Primeira vez:

```bash
git clone https://github.com/Rincon23/Sala-Privada.git ~/sala-privada
cd ~/sala-privada
cp .env.example .env   # e preencha as chaves do Realtime, ADMIN_EMAIL e ADMIN_PASSWORD
docker compose up -d --build
```

Para atualizar, depois do push:

```bash
ssh rincon@100.64.38.33 'cd ~/sala-privada && ./update.sh'
```

O `update.sh` puxa a `main`, remonta o container e mostra qual commit ficou no ar, com o status e o log. O `.env` fica só no servidor e nunca vai para o GitHub.

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
| `ADMIN_EMAIL` e `ADMIN_PASSWORD` | A conta de admin. Trocar a senha aqui (e recriar o container) troca a senha do admin. |
| `ROOM_PASSWORD` | Senha da sala, pedida só para criar conta. Vazio = qualquer pessoa com o link cria conta. |
| `MONTHLY_LIMIT_GB` | Quanto do plano grátis pode ser usado antes de pausar câmera e telas (padrão 900). |
| `FILE_TTL_HOURS` | Depois de quantas horas um arquivo enviado some (padrão 24). |
| `FILE_MAX_GB` | Tamanho máximo de cada arquivo (padrão 10). |
| `FILES_TOTAL_GB` | Espaço total para arquivos no servidor (padrão 50). |
| `CHAT_FILE_MAX_MB` | Tamanho máximo de cada imagem ou arquivo mandado no chat (padrão 25). Esses não expiram. |

### O que fica guardado

Tudo fica no volume `dados` do Docker (`/data` no container): `users.json` (as contas, com as senhas só em hash), `sessions.json` (os aparelhos logados), `servers.json` (os servidores e membros), `channels.json` (os canais), `messages/` (uma linha por mensagem, um arquivo por canal) e `attachments/` (as imagens e arquivos do chat). Para fazer backup das mensagens, copie essa pasta. Apagar um canal apaga as mensagens e imagens dele de vez.

## Desenvolvendo

```bash
npm install
npm start          # http://localhost:8380
npm run icons      # regera os PNGs do app a partir do desenho em scripts/make-icons.mjs
```

Sem as chaves do Realtime, o chat e a música funcionam; voz e vídeo ficam desligados.

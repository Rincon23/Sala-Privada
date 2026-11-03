# Sala Privada

Uma sala só para a galera, no estilo do Discord: canais de texto que guardam mensagens e imagens, salas de voz com câmera e quantas telas e janelas quiser, música do YouTube sincronizada em cada sala de voz. Entra só com o nome (ou com a conta do Discord, que já traz nome e foto) e dá para instalar como app no PC e no celular.

- **Canais de texto:** qualquer pessoa cria, renomeia e apaga pelo **+** e pela engrenagem na lista à esquerda. Tudo fica guardado: texto, imagens (dá para colar com Ctrl+V ou arrastar para o chat) e arquivos de até 25 MB. Quem mandou pode apagar a própria mensagem.
- **Salas de voz:** clicar numa sala entra nela, como no Discord. Cada sala tem a sua voz, câmeras, telas, música, mesa de sons e um chat ao lado. Quem está em outra sala não ouve nem vê nada, e o servidor também barra isso.

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

### Login com o Discord (opcional)

Com isso, aparece o botão **Continuar com o Discord** na entrada: a pessoa entra com o nome e a foto da conta dela, e o app lembra dela por 30 dias. Quem não quiser continua entrando só com um nome.

1. Em [discord.com/developers/applications](https://discord.com/developers/applications), clique em **New Application** e dê o nome *Sala Privada* (é o que aparece na tela de autorização). Dá para colocar o ícone do app em **App Icon**.
2. Em **OAuth2**, copie o **Client ID** e clique em **Reset Secret** para pegar o **Client Secret**.
3. Ainda em **OAuth2 → Redirects**, adicione os endereços de retorno (precisa ser exatamente assim):
   - `https://live.rincon.dev.br/api/discord/callback`
   - `http://localhost:8380/api/discord/callback` (para testar no PC)
4. No `.env`:

   ```
   DISCORD_CLIENT_ID=...
   DISCORD_CLIENT_SECRET=...
   ```

5. Recrie o container: `docker compose up -d --force-recreate`.

O app só pede o escopo `identify` (nome, @ e foto). Não vê e-mail, servidores nem mensagens. A senha da sala, se houver, continua valendo para todo mundo.

### Outras opções do `.env`

| Variável | Para quê |
|---|---|
| `ROOM_PASSWORD` | Senha da sala. Vazio = entra só com o nome. |
| `MONTHLY_LIMIT_GB` | Quanto do plano grátis pode ser usado antes de pausar câmera e telas (padrão 900). |
| `FILE_TTL_HOURS` | Depois de quantas horas um arquivo enviado some (padrão 24). |
| `FILE_MAX_GB` | Tamanho máximo de cada arquivo (padrão 10). |
| `FILES_TOTAL_GB` | Espaço total para arquivos no servidor (padrão 50). |
| `CHAT_FILE_MAX_MB` | Tamanho máximo de cada imagem ou arquivo mandado no chat (padrão 25). Esses não expiram. |

### O que fica guardado

Tudo fica no volume `dados` do Docker (`/data` no container): `channels.json` (os canais), `messages/` (uma linha por mensagem, um arquivo por canal) e `attachments/` (as imagens e arquivos do chat). Para fazer backup das mensagens, copie essa pasta. Apagar um canal apaga as mensagens e imagens dele de vez.

## Desenvolvendo

```bash
npm install
npm start          # http://localhost:8380
npm run icons      # regera os PNGs do app a partir do desenho em scripts/make-icons.mjs
```

Sem as chaves do Realtime, o chat e a música funcionam; voz e vídeo ficam desligados.

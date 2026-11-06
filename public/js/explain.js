// Traduz erros em "o que aconteceu" + "o que fazer", para quem está na sala.
// O mesmo texto vai para o log do servidor.

const DEVICE = {
  mic: { o: 'o microfone', O: 'O microfone' },
  cam: { o: 'a câmera', O: 'A câmera' },
};

// what: 'mic' | 'cam' | 'screen' | 'watch' | 'send' | 'receive' | 'connect' | 'file'
// label: nome do que estava sendo feito (ex.: "a tela de Ana")
export function explain(err, what, label = '') {
  const code = err?.code || err?.name || 'unknown';
  const device = DEVICE[what];

  if (device) {
    if (code === 'NotAllowedError' || code === 'SecurityError') {
      return {
        code,
        text: `O navegador bloqueou ${device.o}.`,
        action: `Clique no cadeado ao lado do endereço, permita ${device.o} e recarregue a página.`,
      };
    }
    if (code === 'NotFoundError' || code === 'OverconstrainedError') {
      return { code, text: `Não encontrei ${device.o} neste aparelho.`, action: 'Confira se está conectado ou escolha outro em Configurações.' };
    }
    if (code === 'NotReadableError' || code === 'AbortError') {
      return {
        code,
        text: `${device.O} está sendo usado por outro programa.`,
        action: 'Feche o outro programa (Discord, Zoom, OBS…) e tente de novo.',
      };
    }
  }

  switch (code) {
    case 'quota':
      return {
        code,
        text: 'O limite gratuito de vídeo deste mês acabou.',
        action: 'A voz continua. Câmera e telas voltam quando o mês virar.',
      };
    case 'not_configured':
      return {
        code,
        text: 'O servidor está sem as chaves do Cloudflare Realtime.',
        action: 'Quem cuida do servidor precisa preencher REALTIME_APP_ID e REALTIME_APP_SECRET no .env.',
      };
    case 'unauthorized':
    case 'http_401':
      return { code, text: 'Sua entrada na sala expirou.', action: 'Recarregue a página.' };
    case 'session_error':
    case 'closed':
      return { code, text: 'A conexão de voz e vídeo caiu.', action: 'Reconectando sozinho…' };
    case 'invalid_session_description':
      return {
        code,
        text: 'Seu navegador e o servidor de mídia não se entenderam.',
        action: 'Reconectando sozinho. Se continuar, recarregue a página ou use Chrome, Edge ou Brave atualizados.',
      };
    case 'not_found_track_error':
    case 'empty_track_error':
    case 'track_timeout':
      return {
        code,
        text: `${label ? `${capitalize(label)} ainda` : 'A transmissão ainda'} não começou a chegar.`,
        action: 'Tentando de novo… Se não aparecer, peça para a pessoa parar e compartilhar de novo.',
      };
    case 'stream_stalled':
      return {
        code,
        text: `${capitalize(label || 'a transmissão')} parou de chegar para você.`,
        action: 'Reconectei sozinho. Se continuar, a pessoa que transmite deve recarregar a página.',
      };
    case 'receive_stalled':
      return {
        code,
        text: 'O áudio e o vídeo dos outros pararam de chegar para você.',
        action: 'Reconectando sozinho… Se repetir, desligue a VPN ou troque de rede.',
      };
    case 'send_stalled':
      return { code, text: 'Seu áudio parou de sair para a sala.', action: 'Reconectando sua transmissão sozinho…' };
    case 'republish':
      return {
        code,
        text: 'Outras pessoas não estavam recebendo o que você transmite.',
        action: 'Reconectei sua transmissão sozinho. Se repetir, recarregue a página ou troque de rede.',
      };
    case 'connect_timeout':
    case 'connect_failed':
    case 'transport_unavailable_error':
      return {
        code,
        text: 'Não consegui conectar ao servidor de voz e vídeo.',
        action: 'Tentando de novo… Se continuar, sua rede pode estar bloqueando chamadas: desligue a VPN ou troque de rede (4G, outro Wi-Fi).',
      };
    case 'network':
      return { code, text: 'Sem conexão com o servidor da sala.', action: 'Confira sua internet.' };
    case 'retryable_transient_error':
    case 'temporarily_unavailable_error':
    case 'backend_error':
    case 'internal_error':
    case 'upstream':
    case 'http_502':
    case 'http_503':
      return {
        code,
        text: 'O Cloudflare está instável agora.',
        action: 'Tentando de novo… Se durar, veja cloudflarestatus.com.',
      };
    case 'file_too_large':
      return { code, text: err.message, action: 'Compacte ou divida o arquivo.' };
    case 'storage_full':
      return { code, text: 'O servidor está sem espaço agora.', action: 'Tente de novo mais tarde ou avise o host.' };
    default:
      return {
        code,
        text: `Algo deu errado${label ? ` com ${label}` : ''}: ${err?.message || err}.`,
        action: 'Se repetir, recarregue a página.',
      };
  }
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

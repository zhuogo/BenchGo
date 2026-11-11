import { readLimited } from '../../../../../../shared/http.mjs';
import { VoiceError } from '../../config.mjs';

export async function upstreamFailure(response, kind, signal) {
  let code = '', noSpeech = false;
  try {
    if (response.headers.get('content-type')?.includes('application/json')) {
      const raw = await readLimited(new Request('http://voice.internal', { method: 'POST', body: response.body, duplex: 'half', signal }), 8192);
      const body = JSON.parse(new TextDecoder().decode(raw));
      // Only a bounded machine code is safe to expose. Upstream messages may echo credentials or audio.
      const candidate = body.error?.code ?? body.error?.type; if (typeof candidate === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/u.test(candidate)) code = candidate;
      // Recognize this exact documented failure without reflecting arbitrary
      // vendor text, which may contain the caller's key or uploaded content.
      noSpeech = kind === 'ASR' && response.status === 400 && typeof body.error?.message === 'string'
        && /^no speech (?:found|detected)[.!]?$/iu.test(body.error.message.trim());
    }
  } catch {} finally { await response.body?.cancel().catch(() => {}); }
  if (noSpeech) { const error = new VoiceError('语音识别服务未检测到有效语音（HTTP 400）；请靠近麦克风说话，并检查输入设备与录音音量。', 502, 'asr_no_speech'); error.upstreamStatus = response.status; return error; }
  const error = new VoiceError(kind + ' service rejected the request (' + response.status + ')' + (code ? '; ' + code : ''), 502, code || kind.toLowerCase() + '_http_' + response.status);
  error.upstreamStatus = response.status; return error;
}

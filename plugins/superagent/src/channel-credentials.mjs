import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';

const prefix = 'benchgo-channel:', keyRecord = 'benchgo-plugin/channel-key';
const storageKey = ref => `benchgo-plugin/channel-${ref.slice(prefix.length).replaceAll(':', '-')}`;
const channels = new Set(['feishu', 'wecom', 'qq', 'weixin', 'telegram', 'discord', 'whatsapp', 'email', 'webhook', 'api']);
const failure = () => Object.assign(new Error('渠道凭据不可用，请重新录入'), { status: 503 });

/** Owner writes secrets; adapters resolve opaque references. Public configuration contains no secrets. */
export function createChannelCredentials({ credentials }) {
  let disposed = false;
  const assertOpen = () => { if (disposed) throw failure(); };
  const key = async () => {
    assertOpen();
    if (!credentials?.modifyRecord || !credentials?.readRecord) throw failure();
    let record = await credentials.readRecord(keyRecord);
    if (!record) {
      const generated = randomBytes(32).toString('base64');
      await credentials.modifyRecord(keyRecord, async current => current ?? { kind: 'grant', payload: { key: generated } });
      record = await credentials.readRecord(keyRecord);
    }
    const bytes = Buffer.from(record?.payload?.key || '', 'base64');
    if (bytes.length !== 32) throw failure();
    return bytes;
  };
  return {
    async save({ channel, field, secret }) {
      assertOpen();
      if (!channels.has(channel) || !/^[a-zA-Z][a-zA-Z0-9]*Ref$/.test(field || '') || typeof secret !== 'string' || !secret.trim() || Buffer.byteLength(secret) > 65536) throw Object.assign(new Error('渠道、凭据字段或密钥无效'), { status: 400 });
      const ref = `${prefix}${channel}:${randomUUID()}`, iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', await key(), iv);
      cipher.setAAD(Buffer.from(ref));
      const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
      assertOpen();
      await credentials.modifyRecord(storageKey(ref), async () => ({ kind: 'grant', payload: { channel, field, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') } }));
      return { ref };
    },
    async resolve(ref) {
      assertOpen();
      if (typeof ref !== 'string') return undefined;
      if (!ref.startsWith(prefix)) return credentials?.resolve(ref);
      try {
        const record = await credentials.readRecord(storageKey(ref));
        if (!record) return undefined;
        const p = record.payload, decipher = createDecipheriv('aes-256-gcm', await key(), Buffer.from(p.iv, 'base64'));
        decipher.setAAD(Buffer.from(ref)); decipher.setAuthTag(Buffer.from(p.tag, 'base64'));
        const value = Buffer.concat([decipher.update(Buffer.from(p.ciphertext, 'base64')), decipher.final()]).toString('utf8');
        assertOpen();
        return { value, source: 'benchgo-channel' };
      } catch { throw failure(); }
    },
    dispose() { disposed = true; },
  };
}

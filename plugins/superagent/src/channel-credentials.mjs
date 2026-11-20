import { randomBytes, randomUUID, createCipheriv, createDecipheriv, createHash } from 'node:crypto';

const prefix = 'benchgo-channel:', keyRecord = 'benchgo-plugin/channel-key';
const storageKey = ref => `benchgo-plugin/channel-${ref.slice(prefix.length).replaceAll(':', '-')}`;
const channels = new Set(['feishu', 'wecom', 'qq', 'weixin', 'telegram', 'discord', 'slack', 'dingtalk', 'whatsapp', 'email']);
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
  const seal = async (binding, value) => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', await key(), iv);
    cipher.setAAD(Buffer.from(binding));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
  };
  const open = async (binding, payload) => {
    const decipher = createDecipheriv('aes-256-gcm', await key(), Buffer.from(payload.iv, 'base64'));
    decipher.setAAD(Buffer.from(binding)); decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  };
  return {
    async save({ channel, field, secret }) {
      assertOpen();
      if (!channels.has(channel) || !/^[a-zA-Z][a-zA-Z0-9]*Ref$/.test(field || '') || typeof secret !== 'string' || !secret.trim() || Buffer.byteLength(secret) > 65536) throw Object.assign(new Error('渠道、凭据字段或密钥无效'), { status: 400 });
      const ref = `${prefix}${channel}:${randomUUID()}`, sealed = await seal(ref, secret);
      assertOpen();
      await credentials.modifyRecord(storageKey(ref), async () => ({ kind: 'grant', payload: { channel, field, ...sealed } }));
      return { ref };
    },
    async resolve(ref) {
      assertOpen();
      if (typeof ref !== 'string') return undefined;
      if (!ref.startsWith(prefix)) return credentials?.resolve(ref);
      try {
        const record = await credentials.readRecord(storageKey(ref));
        if (!record) return undefined;
        const value = await open(ref, record.payload);
        assertOpen();
        return { value, source: 'benchgo-channel' };
      } catch { throw failure(); }
    },
    runtimeState({ channel, connectionId, profileId, accountId, credentialIdentity }) {
      const identity = JSON.stringify([channel, profileId, connectionId]);
      const storage = `benchgo-plugin/channel-state-${createHash('sha256').update(identity).digest('hex')}`;
      const binding = createHash('sha256').update(JSON.stringify([identity, accountId, credentialIdentity])).digest('hex');
      return {
        async read() {
          assertOpen();
          try {
            const record = await credentials.readRecord(storage);
            if (record?.payload?.binding !== binding) return undefined;
            return JSON.parse(await open(binding, record.payload));
          } catch { throw failure(); }
        },
        async write(state) {
          try {
            const sealed = await seal(binding, JSON.stringify(state));
            assertOpen();
            await credentials.modifyRecord(storage, async () => ({ kind: 'grant', payload: { binding, ...sealed } }));
          } catch { throw failure(); }
        },
      };
    },
    dispose() { disposed = true; },
  };
}

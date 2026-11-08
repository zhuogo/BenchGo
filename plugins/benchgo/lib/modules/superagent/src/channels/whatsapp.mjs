export { createWhatsAppAdapter } from '../whatsapp.mjs';
export const channelDefinition = { id: 'whatsapp', label: 'WhatsApp', defaults: { phoneNumberId: '', apiVersion: 'v23.0', accessTokenRef: '', appSecretRef: '', verificationTokenRef: '' }, capabilities: { externalActions: ['external-send'], direct: true, text: true, groups: false, attachments: false }, fields: [
  { key: 'phoneNumberId', label: '电话号码 ID', required: true },
  { key: 'accessTokenRef', label: 'Access Token 凭据', type: 'secretRef', required: true },
  { key: 'appSecretRef', label: 'App Secret 凭据', type: 'secretRef', required: true },
  { key: 'verificationTokenRef', label: '回调验证凭据', type: 'secretRef', required: true },
  { key: 'apiVersion', label: 'Graph API 版本', advanced: true },
] };

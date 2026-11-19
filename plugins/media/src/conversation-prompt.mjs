import { readFileSync } from 'node:fs';

/** Read the shipped source for each reply; file updates never depend on module cache eviction. */
export function readVoiceConversationPrompt(source = new URL('../prompts/conversation.md', import.meta.url)) {
  let prompt;
  try { prompt = readFileSync(source, 'utf8').trim(); }
  catch (cause) {
    throw Object.assign(new Error('实时语音交互提示词无法读取，请检查插件文件', { cause }), { code: 'VOICE_CONVERSATION_PROMPT_UNAVAILABLE' });
  }
  if (!prompt) throw Object.assign(new Error('实时语音交互提示词为空，请修复插件文件'), { code: 'VOICE_CONVERSATION_PROMPT_INVALID' });
  return prompt;
}

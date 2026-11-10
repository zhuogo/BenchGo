import { collectAuxiliaryText } from './auxiliary-request.mjs';

/** Injectable in either host: needs its local auxiliary configuration and LLM only. */
export function createExecutionAuxiliaryRequester({ llm, getConfig }) {
  return async function requestText({ purpose, instructions, input, signal, validate }) {
    const config = await getConfig();
    return collectAuxiliaryText({ llm, config, capability: 'summary', routePolicy: 'auxiliary-only',
      request: { purpose, signal, maxTokens: 768, messages: [
        { role: 'system', content: [{ type: 'text', text: instructions }] },
        { role: 'user', content: [{ type: 'text', text: JSON.stringify(input) }] },
      ] }, validate });
  };
}

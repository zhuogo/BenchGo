import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssessmentSourceReader } from '../src/assessment-source.mjs';
import { assessCandidates } from '../src/assessment.mjs';

const candidates = [{ candidateId: 'c', trigger: { id: 't', threadId: 'thread' }, context: { threadId: 'thread', messages: [{ triggerId: 'context' }] } }];
function reader() {
  return createAssessmentSourceReader({ candidates, database: { readIntakeEvent: id => ({ id, threadId: 'thread', content: 'x'.repeat(4000) + 'original tail', contentHash: 'hash' }) } });
}
test('source reads page original text and refuse hidden IDs, invalid ranges and excess requests', async () => {
  const read = reader();
  assert.equal((await read({ triggerId: 't' })).nextOffset, 4000);
  assert.equal((await read({ triggerId: 't', offset: 4000 })).content, 'original tail');
  await assert.rejects(read({ triggerId: 'secret' }), /上下文/);
  await assert.rejects(read({ triggerId: 't', length: 4001 }), /范围/);
  await assert.rejects(read({ triggerId: 't', offset: -1 }), /范围/);
  await assert.rejects(read({ triggerId: 't', offset: 5000 }), /越界/);
  await read({ triggerId: 'context' });
  await read({ triggerId: 't' });
  await assert.rejects(read({ triggerId: 't' }), /次数/);
});

test('Router performs only bounded original-source reads before final decisions', async () => {
  let rounds = 0;
  const llm = { async *stream(options) {
    assert.equal(options.model, 'aux/opaque');
    assert.deepEqual(options.tools.map(tool => tool.name), ['read_assessment_source']);
    if (++rounds === 1) {
      yield { type: 'block-end', block: { type: 'tool-call', id: 'call', name: 'read_assessment_source', arguments: '{"triggerId":"t","offset":4000}' } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    } else {
      const result = options.messages.at(-1);
      assert.equal(result.role, 'tool');
      assert.equal(result.toolCallId, 'call');
      assert.equal(JSON.parse(result.content[0].text).content, 'original tail');
      yield { type: 'text-delta', text: '{"decisions":[{"candidateId":"c","outcome":"ignore","reason":"discussion"}]}' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  } };
  assert.equal((await assessCandidates({ llm, model: { providerId: 'p', modelId: 'opaque/model' },
    routingConfig: { auxiliary: { capabilities: ['review'], models: [{ providerId: 'p', modelId: 'aux/opaque' }] } },
    candidates, readSource: reader(), rules: '' }))[0].outcome, 'ignore');
  assert.equal(rounds, 2);
});

test('Router rejects executable or endless source tools without finalizing decisions', async () => {
  for (const name of ['shell', 'read_assessment_source']) {
    let count = 0;
    const llm = { async *stream() {
      count++;
      yield { type: 'block-end', block: { type: 'tool-call', id: `call-${count}`, name, arguments: '{"triggerId":"t"}' } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    } };
    await assert.rejects(assessCandidates({ llm, model: { providerId: 'p', modelId: 'm' }, candidates, readSource: reader() }), name === 'shell' ? /无效工具/ : /次数/);
    assert.equal(count, name === 'shell' ? 1 : 9);
  }
});

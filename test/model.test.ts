import assert from 'node:assert/strict';
import test from 'node:test';
import { splitParagraphs } from '../shared/contracts.ts';
import type { Task } from '../shared/contracts.ts';
import { askModel } from '../server/model.ts';
import { makeInput, outputs } from './fixtures.ts';

test('OpenAI 請求使用專案金鑰及嚴格結構，只傳入必要文字', async (t) => {
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'isolated-test-key';
  t.after(() => {
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
  });
  const input = { ...makeInput(), source: '報名上限為 20 人。\n\n報名上限為 30 人。' };
  const at = new Date().toISOString();
  const task: Task = {
    ...input, paragraphs: splitParagraphs(input.source), sceneId: 'local-room',
    status: 'running', stage: 'review', createdAt: at, updatedAt: at, seq: 2, attempts: 1,
    failure: null, events: [], artifacts: { draft: { data: outputs.draft, model: 'fixture', savedAt: at, elapsedMs: 2 } },
  };
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer isolated-test-key');
    const payload = JSON.parse(String(options.body));
    assert.equal(payload.model, 'gpt-5.4-mini');
    assert.equal(payload.response_format.json_schema.name, 'office_review');
    assert.equal(payload.response_format.json_schema.strict, true);
    assert.equal(payload.store, false);
    assert.equal(payload.provider, undefined);
    const document = JSON.parse(payload.messages[1].content);
    assert.deepEqual(Object.keys(document).sort(), ['draft', 'goal', 'paragraphs', 'stage', 'title']);
    assert.deepEqual(document.paragraphs.map(({ text }: { text: string }) => text), ['報名上限為 20 人。', '報名上限為 30 人。']);
    assert.match(payload.messages[0].content, /矛盾/);
    return Response.json({ model: 'openai-fixture', choices: [{ message: { content: JSON.stringify(outputs.review) } }] });
  });
  const result = await askModel('review', task, new AbortController().signal);
  assert.equal(result.model, 'openai-fixture');
  assert.equal(JSON.parse(result.text).issues.length, 1);
});

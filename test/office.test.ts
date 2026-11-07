import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { sceneSchema, taskInput } from '../shared/contracts.ts';
import type { Stage, Task } from '../shared/contracts.ts';
import { markdown } from '../server/artifacts.ts';
import { createHttp, projectRoot } from '../server/http.ts';
import { TaskError } from '../server/model.ts';
import { Conflict, Office } from '../server/office.ts';
import { makeInput, fixtureModel, fixtureResponse, outputs } from './fixtures.ts';

async function until(read: () => boolean) {
  for (let attempt = 0; attempt < 100 && !read(); attempt++) await sleep(5);
  assert.ok(read(), '等待狀態更新逾時');
}

test('驗證 UTF-8 文字界線、換行和空白文件', () => {
  assert.equal(taskInput.parse({ ...makeInput(), source: '\uFEFF第一段\r\n\r\n第二段' }).source, '第一段\n\n第二段');
  assert.equal(taskInput.safeParse({ ...makeInput(), source: '𠀀'.repeat(10_000) }).success, true);
  assert.equal(taskInput.safeParse({ ...makeInput(), source: '𠀀'.repeat(10_001) }).success, false);
  assert.equal(taskInput.safeParse({ ...makeInput(), source: ' \r\n ' }).success, false);
});

test('三階段依序保存且 Markdown 安全，引用可回查', async (t) => {
  const office = new Office(':memory:', async (stage) => stage === 'draft'
    ? fixtureResponse({ ...outputs.draft, summary: '<script>危險</script>' })
    : fixtureModel(stage, {} as Task, new AbortController().signal), () => true);
  t.after(() => office.close());
  const task = office.create(makeInput(), 'ready');
  await until(() => office.get(task.id).status === 'completed');
  const result = office.get(task.id);
  assert.deepEqual(Object.keys(result.artifacts), ['draft', 'review', 'revision']);
  assert.deepEqual(result.events.map(({ seq }) => seq), result.events.map((_, index) => index + 1));
  assert.equal(result.attempts, 3);
  assert.equal(office.status().requestsToday, 3);
  assert.match(markdown(result, 'review')!, /\[P2\]\(#p2\)/);
  assert.match(markdown(result, 'revision')!, /R1/);
  assert.doesNotMatch(markdown(result, 'draft')!, /<script>/);
});

test('錯誤引用只修復一次，修好後才寫入成果', async (t) => {
  let repairs = 0;
  const office = new Office(':memory:', async (stage, task, signal, correction) => {
    if (stage !== 'review') return fixtureModel(stage, task, signal);
    if (correction) {
      repairs++;
      assert.match(correction, /短引文/);
      return fixtureResponse(outputs.review);
    }
    return fixtureResponse({ ...outputs.review, issues: [{
      ...outputs.review.issues[0], evidence: [{ paragraphId: 'P2', quote: '名額確定為一百名。' }],
    }] });
  }, () => true);
  t.after(() => office.close());
  const { id } = office.create(makeInput(), 'ready');
  await until(() => office.get(id).status === 'completed');
  assert.equal(repairs, 1);
  assert.equal(office.get(id).attempts, 4);
});

test('逾時重試從審查接續，舊事件序號不能重複派工', async (t) => {
  let failed = false;
  const calls: Stage[] = [];
  const office = new Office(':memory:', async (stage, task, signal) => {
    calls.push(stage);
    if (stage === 'review' && !failed) {
      failed = true;
      throw new TaskError('timeout', '測試逾時');
    }
    return fixtureModel(stage, task, signal);
  }, () => true);
  t.after(() => office.close());
  const { id } = office.create(makeInput(), 'ready');
  await until(() => office.get(id).status === 'paused');
  const before = office.get(id);
  assert.ok(before.artifacts.draft);
  assert.equal(before.artifacts.review, undefined);
  office.retry(id, before.seq);
  assert.throws(() => office.retry(id, before.seq), Conflict);
  await until(() => office.get(id).status === 'completed');
  assert.deepEqual(calls, ['draft', 'review', 'review', 'revision']);
});

test('同時只執行一個任務，取消後丟棄晚到回覆', async (t) => {
  let release!: (result: Awaited<ReturnType<typeof fixtureModel>>) => void;
  let signal: AbortSignal | undefined;
  const office = new Office(':memory:', async (_stage, _task, abort) => {
    signal = abort;
    return new Promise((resolve) => { release = resolve; });
  }, () => true);
  t.after(() => office.close());
  const input = makeInput();
  const { id } = office.create(input, 'ready');
  assert.equal(office.create(input, 'ready').id, id);
  assert.throws(() => office.create(makeInput(), 'ready'), Conflict);
  await until(() => !!release);
  office.cancel(id, office.get(id).seq);
  assert.equal(signal?.aborted, true);
  release(fixtureResponse(outputs.draft));
  await sleep(10);
  assert.equal(office.get(id).status, 'canceled');
  assert.deepEqual(office.get(id).artifacts, {});
  assert.equal(office.status().requestsToday, 1);
});

test('重啟後保留已完成階段和請求計數，中斷後由使用者接續', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'spatial-office-'));
  const filename = join(directory, 'test.sqlite');
  const before = new Office(filename, async (stage, task, signal) => {
    if (stage === 'review') return new Promise(() => {});
    return fixtureModel(stage, task, signal);
  }, () => true);
  const { id } = before.create(makeInput(), 'ready');
  await until(() => before.get(id).attempts === 2);
  before.close();
  const after = new Office(filename, fixtureModel, () => true);
  t.after(() => { after.close(); rmSync(directory, { recursive: true }); });
  after.recover();
  assert.equal(after.get(id).failure?.code, 'interrupted');
  assert.ok(after.get(id).artifacts.draft);
  assert.equal(after.status().requestsToday, 2);
  after.retry(id, after.get(id).seq);
  await until(() => after.get(id).status === 'completed');
  assert.equal(after.status().requestsToday, 4);
});

test('限流冷卻期間其他任務不送請求，五次任務上限與每日四十次上限生效', async (t) => {
  const limited = new Office(':memory:', async () => {
    throw new TaskError('rate_limit', '測試限流', true, new Date(Date.now() + 600_000).toISOString());
  }, () => true);
  t.after(() => limited.close());
  const a = limited.create(makeInput(), 'ready');
  await until(() => limited.get(a.id).status === 'paused');
  assert.throws(() => limited.retry(a.id, limited.get(a.id).seq), Conflict);
  const b = limited.create(makeInput(), 'ready');
  await until(() => limited.get(b.id).status === 'paused');
  assert.equal(limited.get(b.id).attempts, 0);
  assert.equal(limited.status().requestsToday, 1);

  const invalid = new Office(':memory:', async () => fixtureResponse({}), () => true);
  t.after(() => invalid.close());
  const c = invalid.create(makeInput(), 'ready');
  for (const requests of [2, 3, 4, 5]) {
    await until(() => invalid.get(c.id).status === 'paused');
    const task = invalid.get(c.id);
    assert.equal(task.attempts, requests);
    if (requests < 5) invalid.retry(c.id, task.seq);
    else {
      assert.equal(task.events.filter((event) => event.kind === 'repair').length, 1);
      assert.throws(() => invalid.retry(c.id, task.seq), Conflict);
    }
  }

  const daily = new Office(':memory:', fixtureModel, () => true);
  t.after(() => daily.close());
  for (let index = 0; index < 13; index++) {
    const { id } = daily.create(makeInput(), 'ready');
    await until(() => daily.get(id).status === 'completed');
  }
  const last = daily.create(makeInput(), 'ready');
  await until(() => daily.get(last.id).status === 'paused');
  assert.equal(daily.get(last.id).failure?.code, 'daily_quota');
  assert.equal(daily.get(last.id).attempts, 1);
  assert.equal(daily.status().requestsToday, 40);
});

test('HTTP 建立任務、下載、拒絕跨來源，WS 斷線後可讀取最新序號', async (t) => {
  const scene = sceneSchema.parse(JSON.parse(readFileSync(join(projectRoot, 'scene.example.json'), 'utf8')));
  const office = new Office(':memory:', fixtureModel, () => true);
  const http = createHttp(office, scene, projectRoot);
  t.after(http.close);
  http.server.listen(0, '127.0.0.1');
  await once(http.server, 'listening');
  const address = `127.0.0.1:${(http.server.address() as AddressInfo).port}`;
  const origin = `http://${address}`;
  const open = () => new WebSocket(`ws://${address}/events`, { origin });
  const client = open();
  await once(client, 'open');
  const seen: string[] = [];
  client.on('message', (event) => seen.push(String(event)));
  const input = makeInput();
  const response = await fetch(`${origin}/api/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  assert.equal(response.status, 201);
  await until(() => seen.some((event) => event.includes('"kind":"completed"')));
  client.terminate();
  const reconnected = open();
  await once(reconnected, 'open');
  const task: Task = await (await fetch(`${origin}/api/tasks/${input.id}`)).json();
  assert.equal(task.status, 'completed');
  assert.equal(task.events.at(-1)?.seq, task.seq);
  reconnected.terminate();
  const download = await fetch(`${origin}/api/tasks/${input.id}/artifacts/review`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition') ?? '', /review\.md/);
  assert.match(await download.text(), /報名人數上限/);
  assert.equal((await fetch(`${origin}/api/tasks`, { headers: { Origin: 'https://example.com' } })).status, 403);
});

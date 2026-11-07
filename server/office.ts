import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { dailyLimit, maxAttempts, splitParagraphs, stageLabels, stages } from '../shared/contracts.ts';
import type { Artifact, EventKind, Stage, Task, TaskEvent, TaskInput, TaskSummary } from '../shared/contracts.ts';
import { validateArtifact } from './artifacts.ts';
import { missingKeyMessage, TaskError } from './model.ts';
import type { Model } from './model.ts';

const taipei = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
});
const day = (time = new Date()) => taipei.format(time);
const nextDay = () => new Date(Date.parse(`${day()}T00:00:00+08:00`) + 86_400_000).toISOString();
const now = () => new Date().toISOString();
const firstPending = (task: Task) => stages.find((stage) => !task.artifacts[stage]) ?? null;

export class Conflict extends Error {}
export class Missing extends Error {}

export class Office {
  private db: DatabaseSync;
  private runs = new Map<string, AbortController>();
  private events = new EventEmitter();
  private model: Model;
  private ready: () => boolean;
  private closing = false;

  constructor(filename: string, model: Model, ready: () => boolean) {
    this.model = model;
    this.ready = ready;
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL, updated TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_running ON tasks(status) WHERE status = 'running';
      CREATE TABLE IF NOT EXISTS quota (day TEXT PRIMARY KEY, requests INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS openai_pause (id INTEGER PRIMARY KEY CHECK (id = 1), until TEXT NOT NULL);
    `);
  }

  recover() {
    for (const task of this.all('running')) {
      task.status = 'paused';
      task.failure = { code: 'interrupted', message: '工作室重新啟動。可從未完成的階段接續。', retryable: true };
      this.record(task, 'paused', task.failure.message);
    }
  }

  subscribe(listener: (event: TaskEvent) => void) {
    this.events.on('task', listener);
    return () => this.events.off('task', listener);
  }

  close() {
    this.closing = true;
    this.runs.forEach((controller) => controller.abort());
    this.db.close();
  }

  get(id: string): Task {
    const row = this.db.prepare('SELECT payload FROM tasks WHERE id = ?').get(id);
    if (!row) throw new Missing('找不到這個任務。');
    const task: Task = JSON.parse(String(row.payload));
    if (task.failure?.code === 'missing_key') task.failure.message = missingKeyMessage;
    return task;
  }

  private all(status?: Task['status']): Task[] {
    const rows = status
      ? this.db.prepare('SELECT payload FROM tasks WHERE status = ?').all(status)
      : this.db.prepare('SELECT payload FROM tasks ORDER BY updated DESC, id').all();
    return rows.map((row) => JSON.parse(String(row.payload)));
  }

  list(): TaskSummary[] {
    return this.all().map(({ id, title, sceneId, status, stage, createdAt, updatedAt, seq, attempts, failure }) =>
      ({ id, title, sceneId, status, stage, createdAt, updatedAt, seq, attempts, failure }));
  }

  status() {
    return { keyReady: this.ready(), requestsToday: this.requestsToday(), dailyLimit, retryAt: this.platformPause() };
  }

  create(input: TaskInput, sceneId: string): Task {
    const previous = this.db.prepare('SELECT id FROM tasks WHERE id = ?').get(input.id);
    if (previous) {
      const task = this.get(input.id);
      if (task.title !== input.title || task.goal !== input.goal || task.source !== input.source) {
        throw new Conflict('此任務編號已被使用，請重新整理後送出。');
      }
      return task;
    }
    this.assertIdle();
    const at = now();
    const task: Task = {
      ...input, sceneId, status: 'running', stage: 'draft', createdAt: at, updatedAt: at,
      seq: 0, attempts: 0, failure: null, paragraphs: splitParagraphs(input.source), artifacts: {}, events: [],
    };
    this.record(task, 'created', '任務已建立，派給企劃。');
    this.launch(task.id);
    return this.get(task.id);
  }

  cancel(id: string, seq: number): Task {
    const task = this.expected(id, seq);
    if (task.status !== 'running' && task.status !== 'paused') throw new Conflict('此任務無法取消。');
    task.status = 'canceled';
    task.failure = null;
    this.record(task, 'canceled', '任務已取消。');
    this.runs.get(id)?.abort();
    this.runs.delete(id);
    return task;
  }

  retry(id: string, seq: number): Task {
    const task = this.expected(id, seq);
    if (task.status !== 'paused' || !task.failure?.retryable || task.attempts >= maxAttempts) {
      throw new Conflict('此任務無法接續。');
    }
    const retryAt = [task.failure.retryAt, this.platformPause()].filter((value): value is string => !!value).sort().at(-1);
    if (retryAt && retryAt > now()) throw new Conflict('請等額度或路由冷卻時間結束後再試。');
    this.assertIdle();
    task.status = 'running';
    task.stage = firstPending(task);
    task.failure = null;
    this.record(task, 'retried', '接續尚未完成的階段。');
    this.launch(id);
    return this.get(id);
  }

  private expected(id: string, seq: number) {
    const task = this.get(id);
    if (task.seq !== seq) throw new Conflict('任務狀態已更新，請確認最新進度再操作。');
    return task;
  }

  private assertIdle() {
    if (this.db.prepare("SELECT id FROM tasks WHERE status = 'running'").get()) {
      throw new Conflict('工作室已有一個執行中的任務。');
    }
  }

  private requestsToday(today = day()) {
    return Number(this.db.prepare('SELECT requests FROM quota WHERE day = ?').get(today)?.requests ?? 0);
  }

  private platformPause() {
    const until = this.db.prepare('SELECT until FROM openai_pause WHERE id = 1').get()?.until;
    return typeof until === 'string' && until > now() ? until : undefined;
  }

  private record(task: Task, kind: EventKind, message: string, write?: () => void) {
    const at = now();
    const event: TaskEvent = { taskId: task.id, seq: ++task.seq, kind, stage: task.stage, at, message };
    task.updatedAt = at;
    task.events.push(event);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      write?.();
      this.db.prepare(`INSERT INTO tasks VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated = excluded.updated, payload = excluded.payload`)
        .run(task.id, task.status, at, JSON.stringify(task));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.events.emit('task', event);
  }

  private reserve(task: Task, repairing: boolean) {
    if (!this.ready()) throw new TaskError('missing_key', missingKeyMessage);
    if (task.attempts >= maxAttempts) throw new TaskError('task_quota', '這個任務已用完五次請求。', false);
    const until = this.platformPause();
    if (until) throw new TaskError('platform_pause', 'OpenAI API 正在限流，請稍後再試。', true, until);
    const today = day();
    task.attempts++;
    this.record(task, repairing ? 'repair' : 'request', repairing ? '正在請模型修正輸出。' : '已送出 OpenAI API 請求。', () => {
      if (this.requestsToday(today) >= dailyLimit) throw new TaskError('daily_quota', '今日四十次請求已用完。', true, nextDay());
      this.db.prepare('INSERT INTO quota VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET requests = requests + 1').run(today);
    });
  }

  private launch(id: string) {
    const controller = new AbortController();
    this.runs.set(id, controller);
    queueMicrotask(() => {
      this.run(id, controller).catch(() => console.error('任務存檔失敗，請檢查本機磁碟後重新啟動。'));
    });
  }

  private async run(id: string, controller: AbortController) {
    const current = () => !this.closing && this.runs.get(id) === controller && !controller.signal.aborted;
    try {
      while (current()) {
        const task = this.get(id);
        const stage = firstPending(task);
        if (!stage) return;
        task.stage = stage;
        this.record(task, 'started', `開始${stageLabels[stage]}。`);
        const passes = task.events.some((event) => event.stage === stage && event.kind === 'repair') ? 1 : 2;
        let correction: string | undefined;
        for (let pass = 0; pass < passes; pass++) {
          this.reserve(task, pass > 0);
          const result = await this.model(stage, task, controller.signal, correction);
          if (!current()) return;
          try {
            this.save(task, stage, result);
            break;
          } catch (error) {
            if (!(error instanceof TaskError) || error.failure.code !== 'output') throw error;
            if (pass + 1 === passes || task.attempts >= maxAttempts) throw error;
            correction = error.message;
          }
        }
      }
    } catch (error) {
      if (!current()) return;
      const task = this.get(id);
      const failure = error instanceof TaskError ? error.failure : {
        code: 'internal', message: '工作室處理失敗。請確認本機資料與網路。', retryable: true,
      };
      if (task.attempts >= maxAttempts) {
        failure.retryable = false;
        if (failure.code !== 'task_quota') failure.message += ' 這個任務已用完五次請求。';
      }
      const platformFailure = ['rate_limit', 'platform_quota', 'provider'].includes(failure.code);
      if (platformFailure && !failure.retryAt) failure.retryAt = nextDay();
      task.status = 'paused';
      task.failure = failure;
      this.record(task, 'paused', failure.message, platformFailure ? () => {
        this.db.prepare(`INSERT INTO openai_pause VALUES (1, ?)
          ON CONFLICT(id) DO UPDATE SET until = MAX(until, excluded.until)`).run(failure.retryAt!);
      } : undefined);
    } finally {
      if (this.runs.get(id) === controller) this.runs.delete(id);
    }
  }

  private save<S extends Stage>(task: Task, stage: S, result: Awaited<ReturnType<Model>>) {
    let data;
    try {
      data = validateArtifact(stage, result.text, task);
    } catch (error) {
      const message = error instanceof z.ZodError || error instanceof SyntaxError
        ? '請依照指定結構提供完整的 JSON 欄位。'
        : error instanceof Error ? error.message : '請檢查段落引文及審查編號。';
      throw new TaskError('output', message);
    }
    const artifact: Artifact<S> = { data, model: result.model, savedAt: now(), elapsedMs: result.elapsedMs };
    Object.assign(task.artifacts, { [stage]: artifact });
    if (stage === 'revision') task.status = 'completed';
    this.record(task, stage === 'revision' ? 'completed' : 'saved', `${stageLabels[stage]}已驗證並保存。`);
  }
}

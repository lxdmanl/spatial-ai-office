import { z } from 'zod';

export const stages = ['draft', 'review', 'revision'] as const;
export const stageSchema = z.enum(stages);
export type Stage = z.infer<typeof stageSchema>;
export const stageLabels: Record<Stage, string> = { draft: '企劃初稿', review: '審查意見', revision: '修訂成果' };
export const roleLabels = { planner: '企劃', reviewer: '審查' } as const;
export type Role = keyof typeof roleLabels;
export const stageRole: Record<Stage, Role> = { draft: 'planner', review: 'reviewer', revision: 'planner' };
export const statusLabels = { running: '處理中', paused: '已暫停', canceled: '已取消', completed: '已完成' } as const;
export type Status = keyof typeof statusLabels;
export const maxSource = 10_000;
export const maxAttempts = 5;
export const dailyLimit = 40;
export const countChars = (text: string) => Array.from(text).length;
export const normalizeSource = (text: string) => text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

export const taskInput = z.strictObject({
  id: z.uuid(),
  title: z.string().trim().min(1, '請輸入任務名稱').max(120),
  goal: z.string().trim().min(1, '請輸入任務目標').max(1000),
  source: z.string().transform(normalizeSource)
    .refine((value) => value.trim().length > 0, '請輸入原文')
    .refine((value) => countChars(value) <= maxSource, '原文最多 10,000 字元，請縮短後再送出'),
});
export type TaskInput = z.infer<typeof taskInput>;
export type Paragraph = { id: string; text: string };
export const splitParagraphs = (source: string): Paragraph[] => source.split(/\n(?:[^\S\n]*\n)+/)
  .filter((part) => part.trim().length > 0)
  .map((text, i) => ({ id: `P${i + 1}`, text }));

const prose = z.string().min(1).max(1800).refine((value) => !!value.trim(), '欄位不可只有空白');
const evidence = z.strictObject({ paragraphId: z.string(), quote: z.string().min(1).max(160) });
const evidenceList = z.array(evidence).max(5);
const items = z.array(prose).max(10);
const supported = z.array(z.strictObject({ statement: prose, evidence: evidenceList.min(1) })).max(10);
const draft = z.strictObject({
  summary: prose, proposal: items.min(1), assumptions: items, supported,
});
const review = z.strictObject({
  summary: prose,
  issues: z.array(z.strictObject({
    problem: prose, suggestion: prose, draftItem: z.number().int().min(1).nullable(), evidence: evidenceList.min(1),
  })).max(10),
});
const revision = z.strictObject({
  summary: prose, proposal: items.min(1), supported, assumptions: items, unresolved: items,
  changes: z.array(z.strictObject({ reviewId: z.string(), resolution: z.enum(['addressed', 'pending']), note: prose })).max(10),
});
export const outputSchemas = { draft, review, revision };
export type Outputs = { [S in Stage]: z.infer<(typeof outputSchemas)[S]> };
export type Evidence = z.infer<typeof evidence>;
export type Artifact<S extends Stage> = { data: Outputs[S]; model: string; savedAt: string; elapsedMs: number };
export type Artifacts = { [S in Stage]?: Artifact<S> };
export type Failure = { code: string; message: string; retryAt?: string; retryable: boolean };
export type EventKind = 'created' | 'started' | 'request' | 'repair' | 'saved' | 'paused' | 'retried' | 'canceled' | 'completed';
export interface TaskEvent {
  taskId: string; seq: number; kind: EventKind; stage: Stage | null; at: string; message: string;
}
export interface TaskSummary {
  id: string; title: string; sceneId: string; status: Status; stage: Stage | null;
  createdAt: string; updatedAt: string; seq: number; attempts: number; failure: Failure | null;
}
export interface Task extends TaskSummary {
  goal: string; source: string; paragraphs: Paragraph[]; artifacts: Artifacts; events: TaskEvent[];
}

const point = z.tuple([z.number(), z.number(), z.number()]);
const waypointList = z.array(point).min(2);
const interval = z.tuple([z.number(), z.number()]).refine(([min, max]) => min < max);
const assetPath = z.string().regex(/^\/assets\/[-\w/.]+$/)
  .refine((path) => !path.split('/').some((part) => part === '.' || part === '..'));
export const sceneSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/), name: z.string().min(1),
  splat: assetPath, robot: assetPath, attribution: z.string().min(1),
  camera: z.strictObject({ position: point, target: point, fov: z.number().min(20).max(100) }),
  transform: z.strictObject({ position: point, rotation: point, scale: z.number().positive() }),
  anchors: z.strictObject({ planner: point, reviewer: point, results: point }),
  routes: z.strictObject({ draft: waypointList, review: waypointList, revision: waypointList, completed: waypointList }),
  walkArea: z.strictObject({ x: interval, z: interval, floorY: z.number() }).optional(),
  robotScale: z.number().positive(),
});
export type Scene = z.infer<typeof sceneSchema>;

export const example = {
  title: '週末社群交流活動',
  goal: '整理成一份可執行的活動企劃，標記需要主辦方確認的事項。',
  source: '活動預計週六下午舉辦，場地為社區活動中心。目標是讓第一次見面的參與者有機會交流。\n\n活動將開放事前報名。現場安排簡短開場、分組交流和自由交流。\n\n志工兩名，分別負責報到與場地。預算以場地、文具及茶水為主。',
};

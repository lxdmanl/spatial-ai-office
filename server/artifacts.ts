import { outputSchemas, stageLabels } from '../shared/contracts.ts';
import type { Evidence, Outputs, Stage, Task } from '../shared/contracts.ts';

export function validateArtifact<S extends Stage>(stage: S, text: string, task: Task): Outputs[S] {
  const result = outputSchemas[stage].parse(JSON.parse(text)) as Outputs[Stage];
  const lookup = new Map(task.paragraphs.map(({ id, text }) => [id, text]));
  const checkEvidence = ({ paragraphId, quote }: Evidence) => {
    if (!quote.trim() || !lookup.get(paragraphId)?.includes(quote)) {
      throw new Error('引用段落必須存在，且短引文必須逐字出現在該段。');
    }
  };
  if ('supported' in result) {
    result.supported.forEach((item) => item.evidence.forEach(checkEvidence));
  }
  if ('issues' in result) {
    for (const issue of result.issues) {
      if (issue.draftItem !== null && issue.draftItem > (task.artifacts.draft?.data.proposal.length ?? 0)) {
        throw new Error('審查指向不存在的初稿提案項次。');
      }
      issue.evidence.forEach(checkEvidence);
    }
  }
  if ('changes' in result) {
    const expected = task.artifacts.review?.data.issues.map((_, index) => `R${index + 1}`) ?? [];
    const received = new Set(result.changes.map((item) => item.reviewId));
    if (result.changes.length !== expected.length || expected.some((id) => !received.has(id))) {
      throw new Error('每個審查編號都需要有且只有一項處理結果。');
    }
  }
  return result as Outputs[S];
}

const escapeMarkdown = (value: string) => value.replace(/[\r\n]+/g, ' ').replace(
  /[&<>\\`*_{}\[\]()#+.!|~:\-]/g, (character) => `&#${character.charCodeAt(0)};`,
);
const list = (items: string[]) => items.length ? items.map((item) => `- ${escapeMarkdown(item)}`).join('\n') : '（無）';
const refs = (items: Evidence[]) => items.map((ref) =>
  `  - [${ref.paragraphId}](#${ref.paragraphId.toLowerCase()})「${escapeMarkdown(ref.quote)}」`);

export function markdown(task: Task, stage: Stage) {
  const artifact = task.artifacts[stage];
  if (!artifact) return null;
  const { data, model, savedAt } = artifact;
  const sections = [`# ${stageLabels[stage]}｜${escapeMarkdown(task.title)}`, `模型 ${escapeMarkdown(model)} · ${savedAt}`, '## 摘要', escapeMarkdown(data.summary)];
  if ('proposal' in data) {
    sections.push('## AI 提案', list(data.proposal), '## 原文支持的內容',
      data.supported.flatMap((item) => [`- ${escapeMarkdown(item.statement)}`, ...refs(item.evidence)]).join('\n') || '（無）',
      '## 待確認假設', list(data.assumptions));
  }
  if ('issues' in data) {
    sections.push('## 審查問題', data.issues.map((issue, index) => [
      `### R${index + 1}`, escapeMarkdown(issue.problem),
      issue.draftItem === null ? '' : `初稿提案第 ${issue.draftItem} 項`,
      `建議：${escapeMarkdown(issue.suggestion)}`, ...refs(issue.evidence),
    ].filter(Boolean).join('\n\n')).join('\n\n') || '（無）');
  }
  if ('changes' in data) {
    sections.push('## 變更摘要', data.changes.map((change) =>
      `- ${change.reviewId} · ${change.resolution === 'addressed' ? '已處理' : '待確認'} · ${escapeMarkdown(change.note)}`).join('\n') || '（無）',
    '## 未解問題', list(data.unresolved));
  }
  const citations = [
    ...('supported' in data ? data.supported.flatMap((item) => item.evidence) : []),
    ...('issues' in data ? data.issues.flatMap((item) => item.evidence) : []),
  ];
  const cited = new Set(citations.map((ref) => ref.paragraphId));
  if (cited.size) {
    sections.push('## 引用原文', ...task.paragraphs.filter(({ id }) => cited.has(id)).map(({ id, text }) =>
      `### ${id}\n\n${text.split('\n').map((line) => `> ${escapeMarkdown(line)}`).join('\n')}`));
  }
  return sections.join('\n\n') + '\n';
}

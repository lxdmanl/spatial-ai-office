import { example } from '../shared/contracts.ts';
import type { Outputs } from '../shared/contracts.ts';
import type { Model } from '../server/model.ts';

export const makeInput = () => ({ ...example, id: crypto.randomUUID() });
const evidence = [{ paragraphId: 'P2', quote: '活動將開放事前報名。' }];
export const outputs: Outputs = {
  draft: {
    summary: '規劃週末社群交流活動。', proposal: ['先開放事前報名。'],
    assumptions: ['活動人數待確認。'], supported: [{ statement: '活動有事前報名。', evidence }],
  },
  review: {
    summary: '報名前需確認人數。', issues: [
      { problem: '原文未交代報名人數上限。', suggestion: '確認場地容量後再訂上限。', draftItem: 1, evidence },
    ],
  },
  revision: {
    summary: '確認容量後再開放報名。', proposal: ['依場地與志工安排確認名額，再開放報名。'],
    supported: [{ statement: '活動有事前報名。', evidence }], assumptions: [],
    changes: [{ reviewId: 'R1', resolution: 'pending', note: '等待主辦方確認名額。' }],
    unresolved: ['報名人數上限。'],
  },
};
export const fixtureResponse = (data: unknown) => ({ text: JSON.stringify(data), model: 'test-fixture', elapsedMs: 2 });
export const fixtureModel: Model = async (stage) => fixtureResponse(outputs[stage]);

import { smoke, TaskError } from './model.ts';

try {
  console.log(await smoke());
} catch (error) {
  console.error(error instanceof TaskError ? error.message : 'OpenAI API 測試失敗。');
  process.exitCode = 1;
}

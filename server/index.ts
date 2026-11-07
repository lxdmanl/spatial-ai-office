import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sceneSchema } from '../shared/contracts.ts';
import { Office } from './office.ts';
import { createHttp, projectRoot } from './http.ts';
import { askModel, hasKey } from './model.ts';

const directory = join(projectRoot, '.local');
mkdirSync(directory, { recursive: true });
const override = join(directory, 'scene.json');
const preset = ['ready', 'linford', 'kitchen'].find((name) => process.argv.includes(`--${name}`));
const config = preset
  ? join(projectRoot, `scene.${preset}.json`)
  : existsSync(override) ? override : join(projectRoot, 'scene.example.json');
const scene = sceneSchema.parse(JSON.parse(readFileSync(config, 'utf8')));
const office = new Office(join(directory, 'office.sqlite'), askModel, hasKey);
const http = createHttp(office, scene, projectRoot);
http.server.on('error', (error) => {
  console.error(`工作室無法啟動。${error.message}`);
  http.close();
  process.exitCode = 1;
});
http.server.listen(4174, '127.0.0.1', () => {
  office.recover();
  console.log('實景 AI 工作室 http://127.0.0.1:4174');
  if (!hasKey()) console.log('目前缺少 OPENAI_API_KEY。設定金鑰後可使用 AI 派工。');
});
process.once('SIGINT', http.close);
process.once('SIGTERM', http.close);

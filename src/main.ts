import './style.css';
import {
  countChars, dailyLimit, example, maxAttempts, maxSource, normalizeSource, roleLabels, stageLabels, stageRole, stages, statusLabels,
} from '../shared/contracts.ts';
import type { Evidence, Role, Scene, Stage, Task, TaskEvent, TaskSummary } from '../shared/contracts.ts';
import type { Room } from './room.ts';

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, css?: string) => {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (css) node.className = css;
  return node;
};
const button = (text: string, action: () => void, css?: string) => {
  const node = element('button', text, css);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
};
const clock = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', dateStyle: 'short', timeStyle: 'short' });
const title = byId<HTMLInputElement>('title');
const goal = byId<HTMLInputElement>('goal');
const source = byId<HTMLTextAreaElement>('source');
const form = byId<HTMLFormElement>('task-form');
let history: TaskSummary[] = [];
let selected: string | null = null;
let task: Task | null = null;
let room: Room | null = null;
let scene: Scene | null = null;
let selectedRole: Role | null = null;
let activeTab: Stage = 'draft';
let compare = false;
let refreshing = false;
let pendingRefresh = false;
let sending = false;
let requestId: string | undefined;
let socket: WebSocket | undefined;
let reconnect: ReturnType<typeof setTimeout> | undefined;
type Playback = { task: Task; index: number; timer?: ReturnType<typeof setTimeout> };
let playback: Playback | null = null;
let account = { keyReady: false, requestsToday: 0, dailyLimit, retryAt: undefined as string | undefined };

async function api<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(path, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : undefined);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '工作室暫時無法處理。');
  return result;
}

function showMessage(id: string, text = '') {
  const node = byId(id);
  node.textContent = text;
  node.hidden = !text;
}

function updateForm() {
  const length = countChars(normalizeSource(source.value));
  byId('source-count').textContent = `${length.toLocaleString()} / 10,000`;
  source.setCustomValidity(length > maxSource ? '原文超過 10,000 字元，請先縮短。' : '');
  byId<HTMLButtonElement>('submit').disabled = sending || !!playback || history.some((item) => item.status === 'running');
}

form.addEventListener('input', () => { requestId = undefined; updateForm(); showMessage('form-error'); });
byId('use-example').addEventListener('click', () => {
  title.value = example.title;
  goal.value = example.goal;
  source.value = example.source;
  requestId = undefined;
  showMessage('form-error');
  updateForm();
});
const file = byId<HTMLInputElement>('file');
file.setAttribute('aria-label', '匯入 UTF-8 的 .txt 或 .md');
file.addEventListener('change', async () => {
  const chosen = file.files?.[0];
  if (!chosen) return;
  try {
    if (!/\.(txt|md)$/i.test(chosen.name) || chosen.size > maxSource * 4 + 3) throw new Error();
    const content = normalizeSource(new TextDecoder('utf-8', { fatal: true }).decode(await chosen.arrayBuffer()));
    if (countChars(content) > maxSource) throw new Error();
    source.value = content;
    requestId = undefined;
    showMessage('form-error');
    updateForm();
  } catch {
    showMessage('form-error', '請選擇 10,000 字元以內的 UTF-8 .txt 或 .md 檔。');
  } finally {
    file.value = '';
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (sending || playback) return;
  sending = true;
  updateForm();
  showMessage('form-error');
  try {
    requestId ??= crypto.randomUUID();
    const created = await api<Task>('/api/tasks', { id: requestId, title: title.value, goal: goal.value, source: source.value });
    requestId = undefined;
    selectTask(created.id);
  } catch (error) {
    showMessage('form-error', error instanceof Error ? error.message : '派工失敗。');
  } finally {
    sending = false;
    updateForm();
    void refresh();
  }
});

function selectTask(id: string) {
  if (selected === id) return;
  stopReplay(false);
  selected = id;
  task = null;
  activeTab = 'draft';
  compare = false;
  showMessage('form-error');
  byId('citation').hidden = true;
  room?.resetRobots();
  render();
  void refresh();
}

async function refresh() {
  pendingRefresh = true;
  if (refreshing) return;
  refreshing = true;
  try {
    while (pendingRefresh) {
      pendingRefresh = false;
      const [items, status] = await Promise.all([api<TaskSummary[]>('/api/tasks'), api<typeof account>('/api/status')]);
      history = items;
      account = status;
      selected ??= history.find((item) => item.status === 'running')?.id ?? history[0]?.id ?? null;
      const id = selected;
      const entry = history.find((item) => item.id === id);
      if (id && entry && (!task || task.id !== id || task.seq < entry.seq)) {
        const updated = await api<Task>(`/api/tasks/${id}`);
        if (selected !== id) continue;
        const prior = task;
        task = updated;
        if (!playback && scene?.id === updated.sceneId) {
          if (prior?.id === id) {
            for (const event of updated.events.filter((event) => event.seq > prior.seq)) room?.onEvent(event);
          } else if (updated.status === 'running') {
            const event = updated.events.findLast((event) => event.kind === 'started');
            if (event) room?.onEvent(event);
          }
        }
      }
      render();
    }
  } catch {
    byId('connection').textContent = '暫時無法讀取任務';
  } finally {
    refreshing = false;
  }
}

function connect() {
  socket = new WebSocket(`ws://${location.host}/events`);
  socket.addEventListener('open', () => {
    byId('connection').textContent = '本機已連線';
    void refresh();
  });
  socket.addEventListener('message', () => { void refresh(); });
  socket.addEventListener('close', () => {
    byId('connection').textContent = '重新連線中';
    reconnect = setTimeout(connect, 1200);
  });
  socket.addEventListener('error', () => socket?.close());
}

async function changeTask(action: 'cancel' | 'retry') {
  if (!task || sending || playback) return;
  sending = true;
  renderProgress();
  showMessage('form-error');
  try {
    await api(`/api/tasks/${task.id}/${action}`, { seq: task.seq });
  } catch (error) {
    showMessage('form-error', error instanceof Error ? error.message : '操作失敗。');
  } finally {
    sending = false;
    renderProgress();
    void refresh();
  }
}
byId('cancel').addEventListener('click', () => void changeTask('cancel'));
byId('retry').addEventListener('click', () => void changeTask('retry'));

function visibleTask(): Task | null {
  if (!playback) return task;
  const events = playback.task.events.slice(0, playback.index + 1);
  const last = events.at(-1);
  const visible: Task = { ...playback.task, status: 'running', stage: last?.stage ?? null, events, artifacts: {}, failure: null };
  for (const event of events) {
    if (event.kind === 'saved') {
      if (event.stage === 'draft') visible.artifacts.draft = playback.task.artifacts.draft;
      if (event.stage === 'review') visible.artifacts.review = playback.task.artifacts.review;
    }
    if (event.kind === 'completed') {
      visible.artifacts.revision = playback.task.artifacts.revision;
      visible.status = 'completed';
    }
    if (event.kind === 'paused') visible.status = 'paused';
    if (event.kind === 'retried') visible.status = 'running';
    if (event.kind === 'canceled') visible.status = 'canceled';
  }
  return visible;
}

function replay() {
  if (!task || task.status === 'running' || playback) return;
  const recording: Playback = { task, index: -1 };
  playback = recording;
  room?.resetRobots();
  byId('citation').hidden = true;
  function step() {
    if (playback !== recording) return;
    const event = recording.task.events[++recording.index];
    if (scene?.id === recording.task.sceneId) room?.onEvent(event);
    render();
    const next = recording.task.events[recording.index + 1];
    if (!next) return;
    const interval = Math.max(260, Math.min(2600, Date.parse(next.at) - Date.parse(event.at)));
    recording.timer = setTimeout(step, interval);
  }
  step();
}
function stopReplay(update = true) {
  if (!playback) return;
  clearTimeout(playback.timer);
  playback = null;
  room?.resetRobots();
  byId('citation').hidden = true;
  if (update) render();
}
byId('replay').addEventListener('click', replay);
byId('stop-replay').addEventListener('click', () => stopReplay());

function renderProgress() {
  const current = visibleTask();
  const progress = byId('stages');
  progress.replaceChildren(...stages.map((stage, index) => {
    const active = current?.stage === stage;
    const saved = current?.artifacts[stage];
    const li = element('li');
    li.dataset.live = String(!!active && current.status === 'running');
    const label = saved ? '已保存' : active && current ? statusLabels[current.status] : '等待';
    li.append(element('strong', `0${index + 1} · ${stageLabels[stage]}`), element('span', label));
    return li;
  }));
  byId('task-status').textContent = playback ? '歷史回放' : current ? statusLabels[current.status] : '尚未派工';
  const issue = current?.failure;
  showMessage('task-error', issue
    ? `${issue.message}${issue.retryAt ? ` 可重試時間 ${clock.format(new Date(issue.retryAt))}。` : ''}`
    : playback && current?.sceneId !== scene?.id ? '此任務使用另一個場景，回放顯示歷史事件與成果。' : '');
  const anotherRunning = history.some((item) => item.status === 'running' && item.id !== current?.id);
  const cancel = byId<HTMLButtonElement>('cancel');
  cancel.hidden = !!playback || (current?.status !== 'running' && current?.status !== 'paused');
  cancel.disabled = sending;
  const retry = byId<HTMLButtonElement>('retry');
  retry.hidden = !!playback || current?.status !== 'paused' || !issue?.retryable || current.attempts >= maxAttempts;
  const retryAt = [issue?.retryAt, account.retryAt].filter((item): item is string => !!item).sort().at(-1);
  retry.disabled = sending || anotherRunning || !account.keyReady || (!!retryAt && Date.parse(retryAt) > Date.now());
  byId('replay').hidden = !!playback || !current || current.status === 'running';
  byId('stop-replay').hidden = !playback;
}

const roomHint = '拖曳旋轉 · 滾輪縮放 · 點選角色';
const firstPersonButton = byId<HTMLButtonElement>('first-person');

function roomIsBusy() {
  return !!playback || sending || history.some((item) => item.status === 'running');
}

function getMoveRole() {
  return roomIsBusy() ? null : selectedRole;
}

function updateWalkControls() {
  if (!room?.canMove) return;
  const firstPerson = room.firstPersonRole;
  firstPersonButton.hidden = false;
  firstPersonButton.disabled = !selectedRole || (!firstPerson && roomIsBusy());
  firstPersonButton.textContent = firstPerson ? '返回全景' : '第一人稱';
  firstPersonButton.setAttribute('aria-pressed', String(!!firstPerson));
}

function showWalkHint() {
  if (!room || room.count !== 2) return;
  if (room.firstPersonRole) {
    showMessage('room-status', `${roleLabels[room.firstPersonRole]}視角 · WASD 移動 · 空白鍵跳躍 · 拖曳轉向 · Esc 返回`);
  } else if (room.canMove && getMoveRole()) {
    showMessage('room-status', `已選取${roleLabels[selectedRole!]} · 點亮色框內的地板移動`);
  } else {
    showMessage('room-status', room.canMove && !roomIsBusy() ? '點 3D 角色進入第一人稱 · 拖曳旋轉 · 滾輪縮放' : roomHint);
  }
}

function pick(role: Role) {
  room?.exitFirstPerson();
  selectedRole = selectedRole === role ? null : role;
  renderRole();
  showWalkHint();
  room?.requestFrame();
}

function pickSceneRole(role: Role) {
  if (!room?.canMove || roomIsBusy()) {
    pick(role);
    return;
  }
  selectedRole = role;
  enterRoleView(role);
  renderRole();
}
for (const role of Object.keys(roleLabels) as Role[]) byId(role).addEventListener('click', () => pick(role));
function renderRole() {
  if (room?.firstPersonRole && roomIsBusy()) {
    room.exitFirstPerson();
    showWalkHint();
  }
  updateWalkControls();
  const current = visibleTask();
  for (const role of Object.keys(roleLabels) as Role[]) {
    byId(role).setAttribute('aria-pressed', String(selectedRole === role));
    const ownsStage = current?.stage && stageRole[current.stage] === role;
    const saved = stages.some((stage) => stageRole[stage] === role && current?.artifacts[stage]);
    byId(`${role}-state`).textContent = ownsStage ? statusLabels[current.status] : saved ? '已交接' : '待命';
  }
  const panel = byId('role-details');
  panel.hidden = !selectedRole;
  panel.replaceChildren();
  if (!selectedRole) return;
  const active = current?.stage && stageRole[current.stage] === selectedRole;
  const summary = selectedRole === 'planner' ? '整理原文、產出初稿，接收審查後修訂。' : '對照初稿和原文，提出問題及修改建議。';
  panel.append(element('h3', `${roleLabels[selectedRole]} · ${active ? statusLabels[current.status] : '待命'}`), element('p', summary));
  if (active && current.stage) panel.append(element('p', `當前階段 · ${stageLabels[current.stage]}`));
  const events = current?.events.filter((event) => event.stage && stageRole[event.stage] === selectedRole).slice(-5) ?? [];
  if (events.length) {
    const list = element('ol');
    for (const event of events) list.append(element('li', event.message));
    panel.append(list);
  }
  if (active && current.failure) panel.append(element('p', current.failure.message, 'error'));
}

function showCitation(current: Task, evidence: Evidence) {
  const paragraph = current.paragraphs.find(({ id }) => id === evidence.paragraphId);
  if (!paragraph) return;
  byId('citation').hidden = false;
  byId('citation-heading').textContent = `引用原文 · ${paragraph.id}`;
  const content = byId('citation-text');
  const offset = paragraph.text.indexOf(evidence.quote);
  content.replaceChildren(paragraph.text.slice(0, offset), element('mark', evidence.quote), paragraph.text.slice(offset + evidence.quote.length));
  byId('citation-heading').focus();
}

function renderArtifact(current: Task, stage: Stage) {
  const artifact = current.artifacts[stage];
  const card = element('article', undefined, 'artifact');
  card.append(element('h3', stageLabels[stage]));
  if (!artifact) { card.append(element('p', '這個階段的成果尚未完成。', 'empty')); return card; }
  const { data, model, elapsedMs } = artifact;
  const download = element('a', '下載 Markdown', 'download');
  download.href = `/api/tasks/${current.id}/artifacts/${stage}`;
  card.append(element('p', `${model} · ${(elapsedMs / 1000).toFixed(1)} 秒`, 'quiet'), download, element('h4', '摘要'), element('p', data.summary));
  function addSection(name: string, values: string[], ordered = false) {
    card.append(element('h4', name));
    const list = element(ordered ? 'ol' : 'ul');
    values.forEach((value) => list.append(element('li', value)));
    card.append(values.length ? list : element('p', '（無）', 'quiet'));
  }
  const cite = (ref: Evidence) => button(`${ref.paragraphId}「${ref.quote}」`, () => showCitation(current, ref), 'cite');
  if ('proposal' in data) {
    addSection('AI 提案', data.proposal, true);
    card.append(element('h4', '原文支持的內容'));
    const supported = element('ul');
    for (const item of data.supported) {
      const li = element('li', item.statement);
      li.append(element('br'), ...item.evidence.map(cite));
      supported.append(li);
    }
    card.append(data.supported.length ? supported : element('p', '（無）', 'quiet'));
    addSection('待確認假設', data.assumptions);
  }
  if ('issues' in data) {
    card.append(element('h4', '審查問題'));
    if (!data.issues.length) card.append(element('p', '（無）', 'quiet'));
    for (const [index, issue] of data.issues.entries()) {
      const issueId = `R${index + 1}`;
      const heading = element('h4', issueId);
      heading.id = `issue-${issueId}`;
      heading.tabIndex = -1;
      card.append(heading, element('p', issue.problem), element('p', `建議：${issue.suggestion}`));
      if (issue.draftItem !== null) card.append(element('p', `初稿提案第 ${issue.draftItem} 項`, 'quiet'));
      card.append(...issue.evidence.map(cite));
    }
  }
  if ('changes' in data) {
    card.append(element('h4', '變更摘要'));
    for (const change of data.changes) {
      card.append(element('p', `${change.resolution === 'addressed' ? '已處理' : '待確認'} · ${change.note}`));
      card.append(button(`回查審查 ${change.reviewId}`, () => {
        activeTab = 'review';
        compare = false;
        renderResults();
        byId(`issue-${change.reviewId}`)?.focus();
      }, 'cite'));
    }
    if (!data.changes.length) card.append(element('p', '（無）', 'quiet'));
    addSection('未解問題', data.unresolved);
  }
  return card;
}

function renderResults() {
  const current = visibleTask();
  const canCompare = !!(current?.artifacts.draft && current.artifacts.revision);
  const compareButton = byId<HTMLButtonElement>('compare');
  compareButton.disabled = !canCompare;
  compareButton.setAttribute('aria-pressed', String(compare && canCompare));
  byId('output-tabs').replaceChildren(...stages.map((stage) => {
    const tab = button(stageLabels[stage], () => {
      activeTab = stage;
      compare = false;
      byId('citation').hidden = true;
      renderResults();
      byId(`tab-${stage}`).focus();
    });
    tab.id = `tab-${stage}`;
    tab.setAttribute('aria-pressed', String(!compare && stage === activeTab));
    return tab;
  }));
  const panel = byId('artifacts');
  panel.classList.toggle('comparing', compare && canCompare);
  panel.replaceChildren(...(!current ? [element('p', '成果通過驗證後會顯示在這裡。', 'empty')]
    : compare && canCompare ? [renderArtifact(current, 'draft'), renderArtifact(current, 'revision')]
    : [renderArtifact(current, activeTab)]));
}
byId('compare').addEventListener('click', () => {
  compare = !compare;
  byId('citation').hidden = true;
  renderResults();
});

function render() {
  const status = account.keyReady ? `${account.requestsToday} / ${account.dailyLimit}` : '金鑰未設定';
  byId('quota').textContent = `OpenAI API · ${status}`;
  updateForm();
  renderProgress();
  renderRole();
  renderResults();
  byId('history').replaceChildren(...(history.length ? history.map((item) => {
    const entry = button('', () => selectTask(item.id));
    entry.setAttribute('aria-pressed', String(item.id === selected));
    entry.append(element('span', item.title), element('span', statusLabels[item.status]));
    return entry;
  }) : [element('p', '任務建立後會保存在這台電腦。', 'empty')]));
}

async function startRoom() {
  try {
    scene = await api<Scene>('/api/scene');
    byId('scene-name').textContent = scene.name;
    byId('attribution').textContent = scene.attribution;
    if (scene.id === 'ready') byId('viewer').dataset.poster = 'ready';
    const { mountRoom } = await import('./room.ts');
    room = await mountRoom(byId('viewer'), scene, pickSceneRole, getMoveRole, (hint) => showMessage('room-status', hint));
    showWalkHint();
    updateWalkControls();
    byId<HTMLButtonElement>('reset-camera').disabled = false;
    byId<HTMLButtonElement>('walk-preview').disabled = room.count !== 2;
    const performance = byId<HTMLInputElement>('performance');
    performance.checked = room.performanceMode;
    performance.disabled = false;
    byId<HTMLButtonElement>('bench-splat').disabled = false;
    byId<HTMLButtonElement>('bench-robots').disabled = room.count !== 2;
    if (task?.status === 'running' && task.sceneId === scene.id) {
      const latest = task.events.findLast((event) => event.kind === 'started');
      if (latest) room.onEvent(latest);
    }
  } catch (error) {
    showMessage('room-status', error instanceof Error ? error.message : '3D 場景暫時無法載入。');
  }
}
function exitRoleView() {
  if (!room?.firstPersonRole) return;
  room.exitFirstPerson();
  updateWalkControls();
  showWalkHint();
}

function enterRoleView(role: Role) {
  if (!room?.enterFirstPerson(role)) {
    showMessage('room-status', '角色目前在可走區域外。');
    return;
  }
  updateWalkControls();
  showWalkHint();
}

firstPersonButton.addEventListener('click', () => {
  if (room?.firstPersonRole) {
    exitRoleView();
    return;
  }
  const role = getMoveRole();
  if (role) enterRoleView(role);
});
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !room?.firstPersonRole) return;
  exitRoleView();
  firstPersonButton.focus({ preventScroll: true });
});
byId('reset-camera').addEventListener('click', () => {
  if (room?.firstPersonRole) exitRoleView();
  else room?.resetCamera();
});
byId('walk-preview').addEventListener('click', () => {
  if (roomIsBusy()) return;
  exitRoleView();
  showMessage('room-status', '角色試走 · 場景測試');
  room?.preview();
});
byId<HTMLInputElement>('performance').addEventListener('change', (event) => {
  room?.setPerformance((event.currentTarget as HTMLInputElement).checked);
});
for (const [id, withRobots] of [['bench-splat', false], ['bench-robots', true]] as const) {
  byId(id).addEventListener('click', () => {
    exitRoleView();
    void room?.measure(withRobots, (message) => {
      showMessage('measurement', message);
      byId('last-measurement').textContent = message;
    });
  });
}
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) showMessage('measurement'); });

render();
connect();
void refresh();
void startRoom();
const statusTimer = setInterval(renderProgress, 1000);
window.addEventListener('pagehide', (event) => {
  if (event.persisted) return;
  clearInterval(statusTimer);
  clearTimeout(reconnect);
  if (socket) socket.onclose = null;
  socket?.close();
});

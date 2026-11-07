import { AnimComponentSystem, AnimTrack, Color, Entity, Quat, Ray, StandardMaterial, Vec3 } from 'playcanvas';
import type { Asset, MeshInstance } from 'playcanvas';
import { createViewer } from '@playcanvas/supersplat-viewer/viewer';
import { defaultSettings } from '@playcanvas/supersplat-viewer/settings';
import '@playcanvas/supersplat-viewer/viewer.css';
import { roleLabels, stageRole } from '../shared/contracts.ts';
import type { Role, Scene, TaskEvent } from '../shared/contracts.ts';

type Viewer = Awaited<ReturnType<typeof createViewer>>;
type Robot = { entity: Entity; meshes: MeshInstance[]; route: Vec3[]; animation: 'Idle' | 'Walking' };
const palette = { planner: '#74dbe7', reviewer: '#f9b981' };
const roles = ['planner', 'reviewer'] as const;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const vec = (coordinates: [number, number, number]) => new Vec3(...coordinates);

export type Room = Awaited<ReturnType<typeof mountRoom>>;

async function firstFrame(viewer: Viewer) {
  if (viewer.state.loaded) return;
  await new Promise<void>((resolve, reject) => {
    const listener = viewer.events.on('loaded:changed', (loaded: boolean) => {
      if (!loaded) return;
      clearTimeout(timeout);
      listener.off();
      resolve();
    });
    const timeout = setTimeout(() => {
      listener.off();
      reject(new Error('場景載入逾時。請檢查本機場景檔。'));
    }, 30_000);
  });
}

export async function mountRoom(
  container: HTMLElement,
  scene: Scene,
  onPick: (role: Role) => void,
  getMoveRole: () => Role | null,
  setHint: (text: string) => void,
) {
  const contents = fetch(scene.splat).then((response) => {
    if (!response.ok) throw new Error('找不到場景素材，請檢查本機場景設定。');
    return response;
  });
  const params = new URLSearchParams(location.search);
  const renderer = params.get('renderer') === 'webgl' ? 'webgl' : 'webgpu';
  const viewer = await createViewer({
    container, settings: { ...defaultSettings(), cameras: [{ initial: scene.camera }] },
    contentUrl: scene.splat, contents, renderer, ui: false, nofx: true, fullload: true,
  });
  const { app } = viewer;
  const canvas = app.graphicsDevice.canvas as HTMLCanvasElement;
  try {
    await firstFrame(viewer);
    const splat = app.root.findByName('gsplat');
    if (!splat) throw new Error('Viewer 未建立 Splat 實體。');
    const authored = splat.getLocalRotation().clone();
    const rotation = new Quat().setFromEulerAngles(...scene.transform.rotation);
    splat.setLocalRotation(rotation.mul(authored));
    splat.setLocalPosition(...scene.transform.position);
    splat.setLocalScale(scene.transform.scale, scene.transform.scale, scene.transform.scale);
    app.renderNextFrame = true;
  } catch (error) {
    viewer.destroy();
    throw error;
  }
  const camera = app.root.findComponent('camera')!;
  const robots = new Map<Role, Robot>();
  function faceCamera(role: Role, robot: Entity) {
    const [x, , z] = scene.anchors[role];
    const [cameraX, , cameraZ] = scene.camera.position;
    robot.setEulerAngles(0, Math.atan2(cameraX - x, cameraZ - z) * 180 / Math.PI, 0);
  }
  if (params.has('calibrate')) {
    const material = new StandardMaterial();
    material.diffuse = new Color(0.4, 0.8, 0.85);
    material.update();
    for (const [name, anchor] of Object.entries(scene.anchors)) {
      const marker = new Entity(name, app);
      marker.addComponent('render', { type: 'box', material });
      marker.setPosition(anchor[0], anchor[1] + 0.065, anchor[2]);
      marker.setLocalScale(0.2, 0.13, 0.2);
      app.root.addChild(marker);
    }
  }
  if (!app.systems.anim) app.systems.add(new AnimComponentSystem(app));

  try {
    const asset = await new Promise<Asset<'container'>>((resolve, reject) => {
      app.assets.loadFromUrl(scene.robot, 'container', (error, loaded) => {
        if (error || !loaded?.resource) reject(new Error('角色模型載入失敗，請檢查 GLB 檔案。'));
        else resolve(loaded);
      });
    });
    const resource = asset.resource!;
    for (const role of roles) {
      const robot = resource.instantiateRenderEntity();
      robot.name = roleLabels[role];
      app.root.addChild(robot);
      robot.setPosition(...scene.anchors[role]);
      robot.setLocalScale(scene.robotScale, scene.robotScale, scene.robotScale);
      faceCamera(role, robot);
      const materials = new Map<StandardMaterial, StandardMaterial>();
      const meshes = robot.findComponents('render').flatMap((render) => render.meshInstances);
      for (const mesh of meshes) {
        const material = mesh.material;
        if (!(material instanceof StandardMaterial) || material.name !== 'Main') continue;
        let colored = materials.get(material);
        if (!colored) {
          colored = material.clone();
          colored.diffuse = new Color().fromString(palette[role]);
          colored.update();
          materials.set(material, colored);
        }
        mesh.material = colored;
      }
      robot.addComponent('anim');
      for (const name of ['Idle', 'Walking'] as const) {
        const animation = resource.animations.find((clip) => (clip.resource as AnimTrack)?.name === name)?.resource as AnimTrack | undefined;
        if (!animation) throw new Error('角色缺少 Idle 或 Walking 動畫。');
        robot.anim!.assignAnimation(name, animation);
      }
      robot.anim?.baseLayer?.play('Idle');
      robots.set(role, { entity: robot, meshes, route: [], animation: 'Idle' });
    }
  } catch (error) {
    setHint(error instanceof Error ? error.message : '角色模型載入失敗。');
  }

  const position = new Vec3();
  const direction = new Vec3();
  const walkArea = scene.walkArea;
  const isWalkable = ({ x, z }: Vec3) => !!walkArea
    && x >= walkArea.x[0] && x <= walkArea.x[1] && z >= walkArea.z[0] && z <= walkArea.z[1];
  const moveColor = new Color(0.3, 0.88, 0.9);
  const moveOutline = walkArea ? [
    new Vec3(walkArea.x[0], walkArea.floorY + 0.045, walkArea.z[0]),
    new Vec3(walkArea.x[1], walkArea.floorY + 0.045, walkArea.z[0]),
    new Vec3(walkArea.x[1], walkArea.floorY + 0.045, walkArea.z[1]),
    new Vec3(walkArea.x[0], walkArea.floorY + 0.045, walkArea.z[1]),
  ] : [];
  let manualMove: Role | null = null;
  let firstPerson: {
    role: Role; yaw: number; pitch: number; inputEnabled: boolean; lift: number; jumpSpeed: number;
  } | null = null;
  const keys = new Set<string>();
  const movementKeys = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'];
  const eye = new Vec3();
  const lookAt = new Vec3();
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  let robotsVisible = true;
  let pointer: { id: number; x: number; y: number; dragged: boolean } | undefined;
  const ray = new Ray();
  const hit = new Vec3();
  canvas.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, dragged: false };
    if (firstPerson) {
      canvas.focus({ preventScroll: true });
      canvas.setPointerCapture(event.pointerId);
    }
  });
  canvas.addEventListener('pointermove', (event) => {
    if (pointer?.id !== event.pointerId) return;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    if (Math.hypot(dx, dy) > 7) pointer.dragged = true;
    if (!firstPerson) return;
    firstPerson.yaw -= dx * 0.004;
    firstPerson.pitch = clamp(firstPerson.pitch - dy * 0.004, -1.15, 1.15);
    pointer.x = event.clientX;
    pointer.y = event.clientY;
  });
  function clearPointer() {
    pointer = undefined;
  }
  canvas.addEventListener('pointercancel', clearPointer);
  canvas.addEventListener('lostpointercapture', clearPointer);
  canvas.addEventListener('dblclick', (event) => {
    if (firstPerson || (walkArea && getMoveRole())) event.stopImmediatePropagation();
  }, true);
  canvas.addEventListener('pointerup', (event) => {
    if (pointer?.id !== event.pointerId) return;
    const { x: startX, y: startY, dragged } = pointer;
    clearPointer();
    if (firstPerson) {
      event.stopImmediatePropagation();
      return;
    }
    if (!robotsVisible || dragged || Math.hypot(event.clientX - startX, event.clientY - startY) > 7) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    camera.screenToWorld(x, y, camera.nearClip, ray.origin);
    camera.screenToWorld(x, y, camera.farClip, ray.direction);
    ray.direction.sub(ray.origin).normalize();
    let nearest: Role | undefined;
    let distance = Infinity;
    for (const [role, { meshes }] of robots) {
      for (const mesh of meshes) {
        if (!mesh.aabb.intersectsRay(ray, hit)) continue;
        const delta = hit.distance(ray.origin);
        if (delta < distance) {
          distance = delta;
          nearest = role;
        }
      }
    }
    if (nearest) {
      event.stopImmediatePropagation();
      onPick(nearest);
      return;
    }
    const role = getMoveRole();
    if (!role || !walkArea) return;
    event.stopImmediatePropagation();
    const robot = robots.get(role);
    const distanceToFloor = (walkArea.floorY - ray.origin.y) / ray.direction.y;
    if (!robot || ray.direction.y >= -0.00001 || distanceToFloor <= 0) return;
    const target = ray.direction.clone().mulScalar(distanceToFloor).add(ray.origin);
    if (!isWalkable(target) || !isWalkable(robot.entity.getPosition())) {
      setHint('請點選亮色框線內的地板。');
      return;
    }
    clearManualMove();
    manualMove = role;
    robot.route = [target];
    setHint(`${roleLabels[role]}正在前往指定位置`);
    app.renderNextFrame = true;
  }, true);

  canvas.addEventListener('keydown', (event) => {
    if (!firstPerson || event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.code === 'Space') {
      event.preventDefault();
      if (!event.repeat && firstPerson.lift === 0 && firstPerson.jumpSpeed === 0) {
        firstPerson.jumpSpeed = scene.robotScale * 8;
      }
      return;
    }
    if (!movementKeys.includes(event.code)) return;
    event.preventDefault();
    keys.add(event.code);
  });
  canvas.addEventListener('keyup', (event) => { keys.delete(event.code); });
  canvas.addEventListener('blur', () => keys.clear());
  window.addEventListener('blur', () => { keys.clear(); clearPointer(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) keys.clear(); });

  function clearManualMove() {
    if (!manualMove) return;
    const robot = robots.get(manualMove);
    if (robot) robot.route = [];
    manualMove = null;
  }

  function enterFirstPerson(role: Role) {
    const robot = robots.get(role);
    if (!walkArea || !robot || !isWalkable(robot.entity.getPosition())) return false;
    exitFirstPerson();
    clearManualMove();
    robot.route = [];
    const [x, , z] = scene.camera.position;
    const [tx, , tz] = scene.camera.target;
    firstPerson = {
      role, yaw: Math.atan2(tx - x, tz - z), pitch: -0.1, inputEnabled: viewer.state.inputEnabled,
      lift: 0, jumpSpeed: 0,
    };
    viewer.state.inputEnabled = false;
    robot.entity.enabled = false;
    container.dataset.firstPerson = role;
    canvas.tabIndex = 0;
    canvas.setAttribute('aria-label', '第一人稱控制區');
    canvas.focus({ preventScroll: true });
    app.renderNextFrame = true;
    return true;
  }

  function exitFirstPerson() {
    if (!firstPerson) return;
    const robot = robots.get(firstPerson.role);
    if (robot && walkArea) {
      const { x, z } = robot.entity.getPosition();
      robot.entity.setPosition(x, walkArea.floorY, z);
      robot.entity.enabled = robotsVisible;
    }
    viewer.state.inputEnabled = firstPerson.inputEnabled;
    firstPerson = null;
    keys.clear();
    clearPointer();
    canvas.removeAttribute('tabindex');
    canvas.removeAttribute('aria-label');
    delete container.dataset.firstPerson;
    viewer.resetCamera();
    app.renderNextFrame = true;
  }

  function updateFirstPerson(dt: number) {
    if (!firstPerson || !walkArea) return;
    const robot = robots.get(firstPerson.role)!;
    const { yaw, pitch } = firstPerson;
    const pressed = (a: string, b: string) => Number(keys.has(a) || keys.has(b));
    const forward = pressed('KeyW', 'ArrowUp') - pressed('KeyS', 'ArrowDown');
    const right = pressed('KeyD', 'ArrowRight') - pressed('KeyA', 'ArrowLeft');
    const elapsed = Math.min(dt, 0.05);
    const step = elapsed * 2.1 / (Math.hypot(forward, right) || 1);
    const current = robot.entity.getPosition();
    const x = clamp(current.x + (Math.sin(yaw) * forward - Math.cos(yaw) * right) * step, ...walkArea.x);
    const z = clamp(current.z + (Math.cos(yaw) * forward + Math.sin(yaw) * right) * step, ...walkArea.z);
    if (firstPerson.lift > 0 || firstPerson.jumpSpeed > 0) {
      firstPerson.jumpSpeed -= scene.robotScale * 25 * elapsed;
      firstPerson.lift = Math.max(0, firstPerson.lift + firstPerson.jumpSpeed * elapsed);
      if (firstPerson.lift === 0) firstPerson.jumpSpeed = 0;
    }
    const height = walkArea.floorY + firstPerson.lift;
    robot.entity.setPosition(x, height, z);
    robot.entity.setEulerAngles(0, yaw * 180 / Math.PI, 0);
    eye.set(x, height + scene.robotScale * 3.05, z);
    lookAt.set(eye.x + Math.sin(yaw) * Math.cos(pitch), eye.y + Math.sin(pitch), eye.z + Math.cos(yaw) * Math.cos(pitch));
    camera.nearClip = 0.04;
    camera.entity.setPosition(eye);
    camera.entity.lookAt(lookAt);
    app.renderNextFrame = true;
  }

  function setAnimation(robot: Robot, animation: Robot['animation']) {
    if (robot.animation === animation) return;
    robot.animation = animation;
    robot.entity.anim?.baseLayer?.transition(animation, 0.18);
  }

  app.on('update', (dt: number) => {
    if (document.hidden || !robotsVisible) return;
    for (const robot of robots.values()) {
      const next = robot.route[0];
      if (next) {
        const here = robot.entity.getPosition();
        direction.sub2(next, here);
        const distance = direction.length();
        if (distance < 0.035 || reducedMotion.matches) {
          robot.entity.setPosition(next);
          robot.route.shift();
        } else {
          const step = Math.min(distance, Math.min(dt, 0.1) * 0.9);
          robot.entity.setEulerAngles(0, Math.atan2(direction.x, direction.z) * 180 / Math.PI, 0);
          robot.entity.setPosition(position.copy(direction).mulScalar(step / distance).add(here));
        }
      }
      setAnimation(robot, robot.route.length && !reducedMotion.matches ? 'Walking' : 'Idle');
      if (robot.entity.anim) robot.entity.anim.speed = reducedMotion.matches ? 0 : 1;
    }
    updateFirstPerson(dt);
    const role = getMoveRole();
    if (!firstPerson && !measuring && role && moveOutline.length) {
      for (let i = 0; i < moveOutline.length; i++) {
        app.drawLine(moveOutline[i], moveOutline[(i + 1) % moveOutline.length], moveColor);
      }
    }
    if (manualMove && robots.get(manualMove)?.route.length === 0) {
      if (manualMove === role) setHint(`${roleLabels[role]}已抵達 · 可再點地板移動`);
      manualMove = null;
    }
    if (robots.size && !reducedMotion.matches) app.renderNextFrame = true;
  });
  reducedMotion.addEventListener('change', () => { app.renderNextFrame = true; });

  function onEvent(event: TaskEvent) {
    if (event.kind === 'paused' || event.kind === 'canceled') {
      clearManualMove();
      robots.forEach((robot) => { robot.route = []; });
      return;
    }
    if (!event.stage || (event.kind !== 'started' && event.kind !== 'completed')) return;
    clearManualMove();
    const robot = robots.get(stageRole[event.stage]);
    if (!robot) return;
    const path = scene.routes[event.kind === 'completed' ? 'completed' : event.stage];
    robot.route = path.map(vec);
    app.renderNextFrame = true;
  }

  function resetRobots() {
    clearManualMove();
    for (const [role, robot] of robots) {
      robot.route = [];
      robot.entity.setPosition(...scene.anchors[role]);
      faceCamera(role, robot.entity);
      setAnimation(robot, 'Idle');
    }
    app.renderNextFrame = true;
  }

  function showRobots(visible: boolean) {
    robotsVisible = visible;
    robots.forEach(({ entity }) => { entity.enabled = visible; });
    app.renderNextFrame = true;
  }

  let measuring = false;
  async function measure(withRobots: boolean, label: (message: string) => void) {
    if (measuring) return;
    if (withRobots && robots.size !== 2) {
      label('須等兩個角色載入後才能測量。');
      return;
    }
    measuring = true;
    const wasVisible = robotsVisible;
    try {
      await container.parentElement!.requestFullscreen();
      resetRobots();
      showRobots(withRobots);
      viewer.resetCamera();
      label('開始測試，請持續小幅轉動鏡頭 30 秒。');
      await new Promise<void>((resolve) => setTimeout(resolve, 900));
      const startSize = `${canvas.width}×${canvas.height}`;
      const intervals: number[] = [];
      let previous = 0;
      const handle = app.on('postrender', () => {
        const now = performance.now();
        if (previous) intervals.push(now - previous);
        previous = now;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 30_000));
      handle.off();
      if (intervals.length < 15 || !document.fullscreenElement || startSize !== `${canvas.width}×${canvas.height}`) {
        label('這輪量測未完成。請保持全螢幕並持續轉動鏡頭。');
        return;
      }
      intervals.sort((a, b) => a - b);
      const median = intervals[Math.floor(intervals.length / 2)];
      const fps = (1000 / median).toFixed(1);
      const device = app.graphicsDevice;
      // The pinned engine exposes the active WebGPU adapter at runtime for diagnostics.
      const adapter = (device as { gpuAdapter?: { info?: { description?: string; architecture?: string } } }).gpuAdapter?.info;
      const gpu = adapter?.description || adapter?.architecture
        || ('unmaskedRenderer' in device ? device.unmaskedRenderer : device.deviceType);
      label(`${withRobots ? '雙角色' : '純 Splat'} · ${startSize} · 中位數 ${fps} FPS · ${gpu || device.deviceType}`);
    } catch {
      label('無法開始全螢幕量測，請在一般瀏覽器重試。');
    } finally {
      showRobots(wasVisible);
      measuring = false;
    }
  }

  return {
    count: robots.size, onEvent, resetRobots, measure, resetCamera: () => viewer.resetCamera(),
    requestFrame: () => { app.renderNextFrame = true; },
    canMove: !!walkArea,
    enterFirstPerson, exitFirstPerson,
    get firstPersonRole() { return firstPerson?.role ?? null; },
    get performanceMode() { return viewer.state.performanceMode; },
    setPerformance: (enabled: boolean) => {
      viewer.state.performanceMode = enabled;
      viewer.state.quality = enabled ? 'performance' : 'default';
    },
    preview: () => {
      clearManualMove();
      for (const [role, robot] of robots) {
        const route = scene.routes[role === 'planner' ? 'draft' : 'review'];
        robot.route = [...route.map(vec), vec(scene.anchors[role])];
      }
      app.renderNextFrame = true;
    },
  };
}

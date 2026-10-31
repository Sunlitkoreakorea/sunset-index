// 구름 단면도 3D 보기 — 해 지는 방향(+x) 0~500 km, 양옆 ±125 km, 구름 3층을 반투명 상자로
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';

const KM = 10; // 1 단위 = 10 km
const VZ = 9; // 높이 과장 배율 (12 km를 10.8 단위로)
const XB = [0, 15, 55, 115, 200, 300, 400, 500]; // 거리 칸 경계(km), 2D와 같음
export const LATERAL = [-100, -50, 0, 50, 100]; // 옆으로 떨어진 거리(km), +는 해를 볼 때 오른쪽
const LW = 50; // 옆 칸 폭(km)
const LAYERS = [
  { key: 'low', name: '하층', y0: 0, y1: 3 },
  { key: 'mid', name: '중층', y0: 3, y1: 8 },
  { key: 'high', name: '상층', y0: 8, y1: 12 },
];
const hy = (km) => (km / KM) * VZ;

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888888';

export function createScene(container, { distances }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const canvas = renderer.domElement;
  canvas.setAttribute('aria-label', '구름 3D 보기, 끌어서 돌리기');
  container.appendChild(canvas);

  const labels = document.createElement('div');
  labels.className = 's3-labels';
  container.appendChild(labels);
  const tip = document.createElement('div');
  tip.className = 's3-tip';
  tip.hidden = true;
  container.appendChild(tip);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, 1.6, 0.1, 1000);
  camera.position.set(-16, 27, 52);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(24, 3, 0);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 14;
  controls.maxDistance = 140;
  controls.maxPolarAngle = THREE.MathUtils.degToRad(86);
  controls.update();
  canvas.style.touchAction = 'pan-y'; // 휴대폰: 세로로 밀면 페이지 스크롤, 가로로 밀면 회전

  /* ---------- 고정된 것: 땅, 격자, 관측자, 해 ---------- */
  const mats = {
    ground: new THREE.MeshBasicMaterial(),
    grid: new THREE.LineBasicMaterial({ transparent: true, opacity: 0.7 }),
    text: new THREE.MeshBasicMaterial(),
    accent: new THREE.MeshBasicMaterial(),
  };
  const xMax = XB[XB.length - 1] / KM;
  const zHalf = (LATERAL[LATERAL.length - 1] + LW / 2) / KM;

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(xMax + 4, zHalf * 2 + 2), mats.ground);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(xMax / 2, -0.02, 0);
  scene.add(ground);

  const gp = [];
  for (const x of XB) gp.push(x / KM, 0, -zHalf, x / KM, 0, zHalf);
  for (let i = 0; i <= LATERAL.length; i++) {
    const z = (-zHalf * 2 * (LATERAL.length - i)) / LATERAL.length + zHalf;
    gp.push(0, 0, z, xMax, 0, z);
  }
  const gridGeo = new THREE.BufferGeometry();
  gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(gp, 3));
  scene.add(new THREE.LineSegments(gridGeo, mats.grid));

  const person = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.2, 0.7, 12), mats.text);
  body.position.y = 0.35;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 16, 12), mats.text);
  head.position.y = 0.88;
  person.add(body, head);
  scene.add(person);

  const sun = new THREE.Mesh(new THREE.SphereGeometry(1.6, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), mats.accent);
  sun.position.set(xMax + 3.5, 0, 0);
  scene.add(sun);

  /* ---------- 글자 (거리·층 이름) ---------- */
  const labelDefs = [
    ...[0, 150, 300, 450].map((km) => ({ text: km === 450 ? '450 km' : String(km), pos: new THREE.Vector3(km / KM, 0, zHalf + 1.4) })),
    ...LAYERS.map((L) => ({ text: L.name, pos: new THREE.Vector3(-1.6, (hy(L.y0) + hy(L.y1)) / 2, -zHalf) })),
  ];
  for (const d of labelDefs) {
    d.el = document.createElement('span');
    d.el.textContent = d.text;
    labels.appendChild(d.el);
  }

  /* ---------- 바뀌는 것: 구름 상자, 햇빛 길 ---------- */
  const dyn = new THREE.Group();
  scene.add(dyn);
  let pick = [];
  let last = null;
  let colors = {};

  function applyTheme() {
    colors = { low: css('--muted'), up: css('--accent'), text: css('--text'), faint: css('--faint') };
    mats.ground.color.set(css('--line'));
    mats.grid.color.set(colors.faint);
    mats.text.color.set(colors.text);
    mats.accent.color.set(colors.up);
    if (last) update(last.cells, last.info);
  }

  function clearDyn() {
    for (const o of [...dyn.children]) {
      dyn.remove(o);
      o.geometry?.dispose();
      o.material?.dispose();
    }
    pick = [];
  }

  /**
   * cells: [{ di, li, low, mid, high }] (구름량 %, 없으면 null)
   * info: { P: 햇빛 길 점수(0~1), worstKm: 가장 막힌 거리(km) 또는 null, sideNames: [왼쪽, 오른쪽] }
   */
  function update(cells, info) {
    last = { cells, info };
    clearDyn();
    for (const c of cells) {
      for (const L of LAYERS) {
        const v = c[L.key];
        if (v == null || v < 1) continue;
        const x0 = XB[c.di] / KM;
        const x1 = XB[c.di + 1] / KM;
        const z0 = (LATERAL[c.li] - LW / 2) / KM;
        const z1 = (LATERAL[c.li] + LW / 2) / KM;
        const gx = Math.min(0.25, (x1 - x0) * 0.08);
        const geo = new THREE.BoxGeometry(x1 - x0 - 2 * gx, hy(L.y1) - hy(L.y0) - 0.16, z1 - z0 - 0.5);
        const color = L.key === 'low' ? colors.low : colors.up;
        // 겹쳐 보여도 덩어리가 되지 않게 옅게
        const op = 0.04 + 0.3 * (v / 100);
        const box = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: op, depthWrite: false }));
        box.position.set((x0 + x1) / 2, (hy(L.y0) + hy(L.y1)) / 2, (z0 + z1) / 2);
        box.userData = { layer: L.name, km: distances[c.di], lat: LATERAL[c.li], v };
        const edge = new THREE.LineSegments(
          new THREE.EdgesGeometry(geo),
          new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.12 + 0.45 * (v / 100) }),
        );
        edge.position.copy(box.position);
        dyn.add(box, edge);
        pick.push(box);
      }
    }
    // 햇빛 길: 해에서 낮게 들어와 관측 지점 위(중층·상층 사이)에 닿는 빛
    const good = info.P >= 0.55;
    const curve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(xMax + 2, 0.3, 0),
      new THREE.Vector3(22, 0.1, 0),
      new THREE.Vector3(0.6, hy(8), 0),
    );
    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 80, 0.07, 8),
      new THREE.MeshBasicMaterial({ color: good ? colors.up : colors.low, transparent: !good, opacity: good ? 1 : 0.7 }),
    );
    dyn.add(tube);
    if (!good && info.worstKm != null) {
      let best = curve.getPoint(0);
      for (let i = 0; i <= 200; i++) {
        const p = curve.getPoint(i / 200);
        if (Math.abs(p.x - info.worstKm / KM) < Math.abs(best.x - info.worstKm / KM)) best = p;
      }
      const mark = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 12), new THREE.MeshBasicMaterial({ color: colors.text }));
      mark.position.copy(best);
      dyn.add(mark);
    }
  }

  /* ---------- 크기·그리기 ---------- */
  function resize() {
    const w = container.clientWidth || 300;
    const h = Math.round(Math.min(360, Math.max(240, w * 0.62)));
    renderer.setSize(w, h, true);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // 좁은 화면이면 전체가 들어오게 카메라를 뒤로 뺀다 (사용자가 돌리기 전까지만)
    if (!touched) {
      const k = Math.min(1.7, Math.max(1, 1.6 / camera.aspect));
      const dir = camera.position.clone().sub(controls.target).normalize();
      camera.position.copy(controls.target).addScaledVector(dir, baseDist * k);
      controls.update();
    }
  }
  const baseDist = camera.position.distanceTo(controls.target);
  let touched = false;
  controls.addEventListener('start', () => {
    touched = true;
  });
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  const v3 = new THREE.Vector3();
  function placeLabels() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    for (const d of labelDefs) {
      v3.copy(d.pos).project(camera);
      const off = v3.z > 1 || Math.abs(v3.x) > 1.1 || Math.abs(v3.y) > 1.1;
      d.el.style.visibility = off ? 'hidden' : 'visible';
      d.el.style.transform = `translate(${((v3.x + 1) / 2) * w}px, ${((1 - v3.y) / 2) * h}px) translate(-50%, -50%)`;
    }
  }

  let raf = 0;
  let running = false;
  let onScreen = true;
  let wanted = false;
  function frame() {
    raf = requestAnimationFrame(frame);
    controls.update();
    renderer.render(scene, camera);
    placeLabels();
  }
  function start() {
    if (running || !onScreen) return;
    running = true;
    frame();
  }
  function stop() {
    cancelAnimationFrame(raf);
    running = false;
  }
  const io = new IntersectionObserver((es) => {
    onScreen = es[0].isIntersecting;
    if (!onScreen) stop();
    else if (wanted) start();
  });
  io.observe(container);

  /* ---------- 칸 값 보기 (마우스 올리기 / 톡 누르기) ---------- */
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let tipTimer = 0;
  let down = null;
  function showTip(e) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(pick, false)[0];
    if (!hit) {
      tip.hidden = true;
      return;
    }
    const u = hit.object.userData;
    const names = last?.info.sideNames ?? ['왼쪽', '오른쪽'];
    const side = u.lat === 0 ? '' : ` · ${u.lat > 0 ? names[1] : names[0]} ${Math.abs(u.lat)} km`;
    tip.textContent = `${u.layer} · ${u.km} km${side} · ${Math.round(u.v)}%`;
    tip.style.left = `${e.clientX - r.left}px`;
    tip.style.top = `${e.clientY - r.top}px`;
    tip.hidden = false;
  }
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse' && e.buttons === 0) showTip(e);
  });
  canvas.addEventListener('pointerleave', () => {
    tip.hidden = true;
  });
  canvas.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY };
    tip.hidden = true;
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
    showTip(e);
    clearTimeout(tipTimer);
    if (e.pointerType !== 'mouse') tipTimer = setTimeout(() => (tip.hidden = true), 2500);
  });

  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener?.('change', applyTheme);
  applyTheme();

  return {
    update,
    start() {
      wanted = true;
      start();
    },
    stop() {
      wanted = false;
      stop();
    },
    // 확인용
    _debug: { scene, camera, controls, renderer, pick: () => pick },
  };
}

// 3D Ludo (three.js + models/ludo_set.glb): the board in one canvas, the dice in a tray below.
// It only draws what ludo.js hands it; the rules stay on the server.
// 1 unit = 1 board square, board centre at the origin.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const MODEL_URL = "/models/ludo_set.glb";
const COLORS = ["red", "green", "yellow", "blue"];
const INK = "#1f2433";
const GROUND = -0.7; // underside of the board frame
const TOKEN_SCALE = 1.2; // a little chunkier than the model, easier to hit with a finger
const DIE_HALF = 0.4;
const DIE_GAP = 0.75; // each die's distance from the tray centre
// Rotation (x, y, z) that puts each value on top; an unrotated die shows 1.
const DIE_FACE = {
  1: [0, 0, 0], 2: [-Math.PI / 2, 0, 0], 3: [0, 0, Math.PI / 2],
  4: [0, 0, -Math.PI / 2], 5: [Math.PI / 2, 0, 0], 6: [Math.PI, 0, 0],
};
const STACK = 0.17; // nudge for tokens sharing a square
const ROLL_TIME = 0.6;

const corners = (xs, ys, zs) => xs.flatMap((x) => ys.flatMap((y) => zs.map((z) => new THREE.Vector3(x, y, z))));
const BOARD_BOUNDS = corners([-8.15, 8.15], [GROUND, 0.6], [-8.15, 8.15]);
const TRAY_BOUNDS = corners([-DIE_GAP - 0.75, DIE_GAP + 0.75], [0, 2 * DIE_HALF + 0.5], [-0.75, 0.75]);

let modelPromise = null; // loaded once, cloned for each mounted board
const loadModel = () => (modelPromise ??= new GLTFLoader().loadAsync(MODEL_URL).catch((err) => {
  modelPromise = null;
  throw err;
}));

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const easeOut = (t) => 1 - (1 - t) ** 3;
const title = (s) => s[0].toUpperCase() + s.slice(1);

function ring(inner, outer, color) {
  const m = new THREE.Mesh(
    new THREE.RingGeometry(inner, outer, 48),
    new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false }),
  );
  m.rotation.x = -Math.PI / 2;
  m.renderOrder = 1;
  m.visible = false;
  return m;
}

// Gives each piece its own materials so one can glow or fade without touching the rest.
function ownMaterials(obj) {
  const mats = [];
  obj.traverse((o) => {
    if (!o.isMesh) return;
    o.material = o.material.clone();
    mats.push(o.material);
  });
  return mats;
}

function faceQuat(value, spin) {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...DIE_FACE[value]));
  return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spin).multiply(q);
}

// A renderer + lit scene with an invisible shadow-catching table at `floor`.
function stage(container, floor, shadowSize) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04);
  pmrem.dispose();
  scene.environment = env.texture;
  scene.environmentIntensity = 0.55;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8d93a0, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(5, 16, 7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
  Object.assign(sun.shadow.camera, { left: -11, right: 11, top: 11, bottom: -11, near: 1, far: 45 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);

  const table = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.ShadowMaterial({ opacity: 0.18 }));
  table.rotation.x = -Math.PI / 2;
  table.position.y = floor - 0.001;
  table.receiveShadow = true;
  scene.add(table);

  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 200);
  return {
    renderer, scene, camera, sun,
    dispose() {
      table.geometry.dispose();
      table.material.dispose();
      env.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}

// Fixed-angle camera, pulled back just far enough that `bounds` fill the canvas.
function fitCamera(st, container, bounds, look, elevationDeg) {
  const w = container.clientWidth;
  const h = container.clientHeight;
  if (!w || !h) return;
  const { renderer, camera } = st;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const el = THREE.MathUtils.degToRad(elevationDeg);
  const dir = new THREE.Vector3(0, Math.sin(el), Math.cos(el));
  const place = (dist) => {
    camera.position.copy(look).addScaledVector(dir, dist);
    camera.lookAt(look);
    camera.updateMatrixWorld();
  };
  let lo = 1, hi = 200;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    place(mid);
    const fits = bounds.every((p) => {
      const q = p.clone().project(camera);
      return Math.abs(q.x) <= 0.99 && Math.abs(q.y) <= 0.99;
    });
    if (fits) hi = mid; else lo = mid;
  }
  place(hi);
}

export async function createBoard3D(boardEl, trayEl, { onToken, onDie }) {
  const gltf = await loadModel();
  if (!boardEl.isConnected) return null; // the view was closed while loading

  // ---- board
  const board = stage(boardEl, GROUND, 1024);
  board.renderer.shadowMap.autoUpdate = false; // shadows only change when a token moves
  const set = gltf.scene.clone(true);
  set.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });
  board.scene.add(set);
  const extras = []; // rings we created, disposed on destroy

  const tokens = {};
  for (const color of COLORS) {
    tokens[color] = [0, 1, 2, 3].map((i) => {
      const obj = set.getObjectByName(`Token_${title(color)}_${i}`);
      obj.scale.setScalar(TOKEN_SCALE);
      const mats = ownMaterials(obj);
      mats.forEach((m) => { m.emissive?.copy(m.color); m.emissiveIntensity = 0; });
      const glow = ring(0.42, 0.58, INK);
      const mark = ring(0.42, 0.52, "#ffffff");
      board.scene.add(glow, mark);
      extras.push(glow, mark);
      return { obj, mats, glow, mark, from: new THREE.Vector3(), to: obj.position.clone(), t0: -1, dur: 0, hop: 0, movable: false, justMoved: false };
    });
  }

  // ---- dice tray
  const tray = stage(trayEl, 0, 512);
  Object.assign(tray.sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4 });
  const dice = [0, 1].map((d) => {
    const obj = set.getObjectByName(`Die_${d}`);
    tray.scene.add(obj); // moves it out of the board scene
    const mats = ownMaterials(obj);
    const x = d ? DIE_GAP : -DIE_GAP;
    obj.position.set(x, DIE_HALF, 0);
    obj.quaternion.copy(faceQuat(6 - d * 3, d ? 0.25 : -0.2)); // something showing before the first roll
    const sel = ring(0.6, 0.7, INK);
    sel.position.set(x, 0.004, 0);
    tray.scene.add(sel);
    extras.push(sel);
    return { obj, mats, sel, value: 0, q0: new THREE.Quaternion(), q1: obj.quaternion.clone(), axis: new THREE.Vector3(), t0: -1, ready: false, tappable: false };
  });

  const fit = () => {
    fitCamera(board, boardEl, BOARD_BOUNDS, new THREE.Vector3(0, -0.2, 0), 62);
    fitCamera(tray, trayEl, TRAY_BOUNDS, new THREE.Vector3(0, DIE_HALF, 0), 50);
    board.renderer.shadowMap.needsUpdate = true;
  };
  const resize = new ResizeObserver(fit);
  resize.observe(boardEl);
  resize.observe(trayEl);
  fit();

  // Board taps: the nearest movable token on screen, generous enough for fingers.
  function pickToken(e) {
    const canvas = board.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const radius = Math.max(26, rect.width / 17);
    let best = null;
    let bestD = Infinity;
    for (const color of COLORS) {
      tokens[color].forEach((t, i) => {
        if (!t.movable) return;
        const p = t.to.clone().setY(t.to.y + 0.45).project(board.camera);
        const d = Math.hypot((p.x + 1) / 2 * rect.width - px, (1 - p.y) / 2 * rect.height - py);
        if (d < radius && d < bestD) { bestD = d; best = () => onToken(color, i); }
      });
    }
    return best;
  }
  // Tray taps: left half is die 1, right half die 2.
  function pickDie(e) {
    const rect = tray.renderer.domElement.getBoundingClientRect();
    const d = e.clientX - rect.left < rect.width / 2 ? 0 : 1;
    return dice[d].tappable ? () => onDie(d) : null;
  }
  for (const [canvas, pick] of [[board.renderer.domElement, pickToken], [tray.renderer.domElement, pickDie]]) {
    canvas.addEventListener("click", (e) => pick(e)?.());
    canvas.addEventListener("pointermove", (e) => {
      if (e.pointerType === "mouse") canvas.style.cursor = pick(e) ? "pointer" : "";
    });
  }

  let first = true;
  function sync(s) {
    const inPlay = new Set(s.colors);
    for (const color of COLORS) for (const t of tokens[color]) t.obj.visible = inPlay.has(color);
    for (const p of s.pieces) {
      const t = tokens[p.color][p.token];
      const { r, c, span } = p.cell;
      const off = (span - 1) / 2;
      const to = new THREE.Vector3(c + off - 7 + p.n * STACK, p.home ? 0.05 : 0, r + off - 7 - p.n * STACK);
      if (!to.equals(t.to)) {
        t.from.copy(t.obj.position);
        t.to.copy(to);
        const dist = t.from.distanceTo(to);
        if (first) t.obj.position.copy(to);
        else {
          t.t0 = performance.now() / 1000;
          t.dur = Math.min(0.18 + dist * 0.02, 0.4);
          t.hop = Math.min(0.3 + dist * 0.04, 0.8);
        }
      }
      t.movable = p.movable;
      t.justMoved = p.justMoved;
    }
    board.renderer.shadowMap.needsUpdate = true;

    dice.forEach((d, i) => {
      const value = s.dice?.[i];
      d.tappable = s.tappable[i];
      d.ready = s.canRoll;
      d.mats.forEach((m) => {
        m.transparent = s.used[i];
        m.opacity = s.used[i] ? 0.3 : 1;
      });
      d.sel.visible = s.selected[i];
      d.sel.material.color.set(s.turnHex);
      if (!value) return;
      if (s.rolled) {
        d.q0.copy(d.obj.quaternion);
        d.q1.copy(faceQuat(value, (Math.random() - 0.5) * 0.8));
        d.axis.set(Math.random() - 0.5, 0.3, Math.random() - 0.5).normalize();
        d.t0 = performance.now() / 1000 + i * 0.06;
      } else if (value !== d.value && d.t0 < 0) {
        d.q1.copy(faceQuat(value, i ? 0.25 : -0.2));
        d.obj.quaternion.copy(d.q1);
      }
      d.value = value;
    });
    first = false;
  }

  const spinQ = new THREE.Quaternion();
  let raf = 0;
  let destroyed = false;
  function frame() {
    if (!boardEl.isConnected) { destroy(); return; }
    raf = requestAnimationFrame(frame);
    const now = performance.now() / 1000;
    const pulse = (Math.sin(now * 7) + 1) / 2;

    for (const color of COLORS) {
      for (const t of tokens[color]) {
        const pos = t.obj.position;
        if (t.t0 >= 0) {
          const k = Math.min((now - t.t0) / t.dur, 1);
          pos.lerpVectors(t.from, t.to, easeInOut(k));
          pos.y += Math.sin(Math.PI * k) * t.hop;
          if (k === 1) t.t0 = -1;
          board.renderer.shadowMap.needsUpdate = true;
        }
        const show = t.obj.visible;
        t.glow.visible = show && t.movable;
        t.mark.visible = show && t.justMoved && !t.movable;
        for (const r of [t.glow, t.mark]) r.position.set(pos.x, t.to.y + 0.015, pos.z);
        t.glow.scale.setScalar(1 + pulse * 0.18);
        t.glow.material.opacity = 1 - pulse * 0.5;
        t.mats.forEach((m) => { m.emissiveIntensity = t.movable ? 0.12 + pulse * 0.3 : 0; });
      }
    }

    for (const d of dice) {
      if (d.t0 >= 0 && now >= d.t0) {
        const k = Math.min((now - d.t0) / ROLL_TIME, 1);
        const e = easeOut(k);
        spinQ.setFromAxisAngle(d.axis, (1 - e) * Math.PI * 4);
        d.obj.quaternion.slerpQuaternions(d.q0, d.q1, e).premultiply(spinQ);
        d.obj.position.y = DIE_HALF + Math.abs(Math.sin(Math.PI * 2 * k)) * (1 - k) * 0.9;
        if (k === 1) { d.t0 = -1; d.obj.quaternion.copy(d.q1); }
      } else if (d.t0 < 0) {
        d.obj.position.y = DIE_HALF + (d.ready ? Math.abs(Math.sin(now * 3)) * 0.12 : 0);
      }
      d.sel.scale.setScalar(1 + pulse * 0.05);
    }

    board.renderer.render(board.scene, board.camera);
    tray.renderer.render(tray.scene, tray.camera);
  }
  frame();

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    cancelAnimationFrame(raf);
    resize.disconnect();
    for (const r of extras) { r.geometry.dispose(); r.material.dispose(); }
    for (const color of COLORS) for (const t of tokens[color]) t.mats.forEach((m) => m.dispose());
    for (const d of dice) d.mats.forEach((m) => m.dispose());
    board.dispose();
    tray.dispose();
  }

  return { sync, destroy };
}

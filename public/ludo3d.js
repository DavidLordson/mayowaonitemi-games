// 3D Ludo (three.js + models/ludo_set.glb). The dice are thrown onto the middle of the board.
// It only draws what ludo.js hands it; the rules stay on the server.
// 1 unit = 1 board square, board centre at the origin.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const MODEL_URL = "/models/ludo_set.glb";
const COLORS = ["red", "green", "yellow", "blue"];
const INK = "#1f2433";
const GROUND = -0.7; // underside of the board frame
const TOKEN_SCALE = 1.45; // chunkier than the model, easier to see and hit with a finger
const DIE_SCALE = 1.75;
const DIE_HALF = 0.4 * DIE_SCALE;
const DIE_REST_Y = 0.36 + DIE_HALF; // resting on the tip of the centre pyramid
const DIE_SPOTS = [[-0.78, 0.15], [0.78, -0.15]]; // where the dice land, middle of the board
// Board colours, a little darker than the model's whites so the track doesn't glare;
// darker again in dark mode.
const RECOLOR = {
  light: { Ludo_Field: "#8e95a1", Ludo_Tile: "#e6e8ec", Ludo_Pad: "#e6e8ec" },
  dark: { Ludo_Field: "#4a505d", Ludo_Tile: "#b4b8c1", Ludo_Pad: "#b4b8c1" },
};
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : darkQuery.matches;
};
// Rotation (x, y, z) that puts each value on top; an unrotated die shows 1.
const DIE_FACE = {
  1: [0, 0, 0], 2: [-Math.PI / 2, 0, 0], 3: [0, 0, Math.PI / 2],
  4: [0, 0, -Math.PI / 2], 5: [Math.PI / 2, 0, 0], 6: [Math.PI, 0, 0],
};
const STACK = 0.2; // nudge for tokens sharing a square
const ROLL_TIME = 0.75;

const corners = (xs, ys, zs) => xs.flatMap((x) => ys.flatMap((y) => zs.map((z) => new THREE.Vector3(x, y, z))));
const BOARD_BOUNDS = corners([-8.15, 8.15], [GROUND, 0.6], [-8.15, 8.15]);

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
  // Looking straight down, "up" on screen is the far edge of the board.
  camera.up.set(0, elevationDeg >= 89 ? 0 : 1, elevationDeg >= 89 ? -1 : 0);
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

export async function createBoard3D(boardEl, { onToken, onDie }) {
  const gltf = await loadModel();
  if (!boardEl.isConnected) return null; // the view was closed while loading

  // ---- board
  const board = stage(boardEl, GROUND, 1024);
  board.renderer.shadowMap.autoUpdate = false; // shadows only change when a token moves
  const set = gltf.scene.clone(true);
  const boardMats = [];
  set.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    for (const m of [o.material].flat()) if (RECOLOR.light[m.name]) boardMats.push(m);
  });
  const recolor = () => {
    const palette = RECOLOR[isDark() ? "dark" : "light"];
    for (const m of boardMats) m.color.set(palette[m.name]);
  };
  recolor();
  darkQuery.addEventListener("change", recolor);
  const themeWatch = new MutationObserver(recolor);
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  board.scene.add(set);
  const extras = []; // rings we created, disposed on destroy

  const tokens = {};
  for (const color of COLORS) {
    tokens[color] = [0, 1, 2, 3].map((i) => {
      const obj = set.getObjectByName(`Token_${title(color)}_${i}`);
      obj.scale.setScalar(TOKEN_SCALE);
      const mats = ownMaterials(obj);
      mats.forEach((m) => { m.emissive?.copy(m.color); m.emissiveIntensity = 0; });
      const glow = ring(0.5, 0.76, INK);
      const mark = ring(0.52, 0.62, "#ffffff");
      board.scene.add(glow, mark);
      extras.push(glow, mark);
      return { obj, mats, glow, mark, from: new THREE.Vector3(), to: obj.position.clone(), t0: -1, dur: 0, hop: 0, lift: 0, movable: false, selected: false, justMoved: false };
    });
  }

  // ---- dice, resting in the middle of the board
  const dice = [0, 1].map((d) => {
    const obj = set.getObjectByName(`Die_${d}`);
    const mats = ownMaterials(obj);
    const rest = new THREE.Vector3(DIE_SPOTS[d][0], DIE_REST_Y, DIE_SPOTS[d][1]);
    obj.scale.setScalar(DIE_SCALE);
    obj.position.copy(rest);
    obj.quaternion.copy(faceQuat(6 - d * 3, d ? 0.25 : -0.2)); // something showing before the first roll
    return { obj, mats, rest, from: new THREE.Vector3(), spinning: false, value: 0, q0: new THREE.Quaternion(), q1: obj.quaternion.clone(), axis: new THREE.Vector3(), t0: -1, ready: false, tappable: false };
  });

  const fit = () => {
    fitCamera(board, boardEl, BOARD_BOUNDS, new THREE.Vector3(0, -0.2, 0), 90);
    board.renderer.shadowMap.needsUpdate = true;
  };
  const resize = new ResizeObserver(fit);
  resize.observe(boardEl);
  fit();

  // Taps: the nearest tappable die or movable token on screen, generous enough for fingers.
  const canvas = board.renderer.domElement;
  function pick(e) {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const unit = rect.width / 16.5; // one board square in pixels
    let best = null;
    let bestD = Infinity;
    const consider = (world, radius, action) => {
      const p = world.clone().project(board.camera);
      const d = Math.hypot((p.x + 1) / 2 * rect.width - px, (1 - p.y) / 2 * rect.height - py);
      if (d < radius && d < bestD) { bestD = d; best = action; }
    };
    dice.forEach((d, i) => { if (d.tappable) consider(d.rest, Math.max(30, unit * 1.3), () => onDie(i)); });
    for (const color of COLORS) {
      tokens[color].forEach((t, i) => {
        if (t.movable) consider(t.to.clone().setY(t.to.y + 0.5), Math.max(26, unit * 0.8), () => onToken(color, i));
      });
    }
    return best;
  }
  canvas.addEventListener("click", (e) => pick(e)?.());
  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerType === "mouse") canvas.style.cursor = pick(e) ? "pointer" : "";
  });

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
      t.selected = p.selected;
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
      if (!value) return;
      if (s.rolled) {
        // Already tumbling (we started it on the tap): settle from there. Otherwise it's thrown
        // in from the near edge of the board, bouncing to a stop in the middle.
        if (d.spinning) d.from.copy(d.obj.position);
        else d.from.set(d.rest.x + (Math.random() - 0.5) * 3, d.rest.y + 3, 7.5);
        d.spinning = false;
        d.q0.copy(d.obj.quaternion);
        d.q1.copy(faceQuat(value, (Math.random() - 0.5) * 0.8));
        d.axis.set(Math.random() - 0.5, 0.3, Math.random() - 0.5).normalize();
        d.t0 = performance.now() / 1000 + i * 0.08;
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
        // The picked token floats up a little.
        const lift = t.selected ? 0.25 : 0;
        if (Math.abs(lift - t.lift) > 0.001) {
          t.lift += (lift - t.lift) * 0.3;
          board.renderer.shadowMap.needsUpdate = true;
        }
        if (t.t0 < 0) pos.y = t.to.y + t.lift;
        const show = t.obj.visible;
        // Only the picked token glows; the white ring marks the last move.
        t.glow.visible = show && t.selected;
        t.mark.visible = show && t.justMoved && !t.selected;
        for (const r of [t.glow, t.mark]) r.position.set(pos.x, t.to.y + 0.015, pos.z);
        t.glow.scale.setScalar(1 + pulse * 0.18);
        t.glow.material.opacity = 1 - pulse * 0.35;
        t.mats.forEach((m) => { m.emissiveIntensity = t.selected ? 0.12 + pulse * 0.3 : 0; });
      }
    }

    for (const d of dice) {
      if (d.spinning) {
        // Waiting for the server's numbers: tumble and hop on the spot.
        spinQ.setFromAxisAngle(d.axis, 0.35);
        d.obj.quaternion.premultiply(spinQ);
        d.obj.position.set(d.rest.x, d.rest.y + 0.9 * Math.abs(Math.sin(now * 9)), d.rest.z);
        board.renderer.shadowMap.needsUpdate = true;
      } else if (d.t0 >= 0 && now >= d.t0) {
        const k = Math.min((now - d.t0) / ROLL_TIME, 1);
        const e = easeOut(k);
        spinQ.setFromAxisAngle(d.axis, (1 - e) * Math.PI * 4);
        d.obj.quaternion.slerpQuaternions(d.q0, d.q1, e).premultiply(spinQ);
        d.obj.position.lerpVectors(d.from, d.rest, e);
        d.obj.position.y = d.rest.y + (d.from.y - d.rest.y) * (1 - e) * Math.abs(Math.cos(Math.PI * 1.5 * k));
        if (k === 1) { d.t0 = -1; d.obj.quaternion.copy(d.q1); d.obj.position.copy(d.rest); }
        board.renderer.shadowMap.needsUpdate = true;
      } else if (d.t0 < 0) {
        d.obj.scale.setScalar(DIE_SCALE * (d.ready ? 1 + pulse * 0.08 : 1)); // "tap me" when it's your roll
      }
    }

    board.renderer.render(board.scene, board.camera);
  }
  frame();

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    cancelAnimationFrame(raf);
    resize.disconnect();
    darkQuery.removeEventListener("change", recolor);
    themeWatch.disconnect();
    for (const r of extras) { r.geometry.dispose(); r.material.dispose(); }
    for (const color of COLORS) for (const t of tokens[color]) t.mats.forEach((m) => m.dispose());
    for (const d of dice) d.mats.forEach((m) => m.dispose());
    board.dispose();
  }

  // Start tumbling the dice as soon as Roll is tapped; sync() lands them when the numbers arrive.
  function startRoll() {
    for (const d of dice) {
      d.spinning = true;
      d.t0 = -1;
      d.obj.scale.setScalar(DIE_SCALE);
      d.axis.set(Math.random() - 0.5, 0.4, Math.random() - 0.5).normalize();
    }
  }
  // The roll failed or didn't change anything: put the dice back where they were.
  function stopRoll() {
    for (const d of dice) {
      if (!d.spinning) continue;
      d.spinning = false;
      d.obj.position.copy(d.rest);
      d.obj.quaternion.copy(d.q1);
    }
    board.renderer.shadowMap.needsUpdate = true;
  }

  return { sync, destroy, startRoll, stopRoll };
}

// Game sounds. Recordings in public/sounds/ (listed in FILES) play when present; anything
// without one falls back to a sound made in code (Web Audio), and voice lines without a
// recording ("rekt") use the phone's own voice. To add or swap one: mono MP3, <50 KB, named
// after the sound ("roll.mp3") or voice line ("voice-rekt.mp3"), listed in FILES.

// David's recordings (Pixabay + their own voice lines), trimmed and levelled to mono MP3s.
const FILES = ["roll", "land", "steps", "capture", "groan", "home", "turn", "win", "voice-chop", "voice-oya"];
const MUTE_KEY = "games-muted";

let ctx = null;
let master = null;
const buffers = new Map(); // name -> AudioBuffer, for FILES

function audio() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  // iPhones silence Web Audio when the side switch is on silent, unless the page asks for
  // the "playback" session (Safari 16.4+). Without this one phone hears nothing while the
  // other plays fine. Ignored by browsers that don't have it.
  try { navigator.audioSession.type = "playback"; } catch {}
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.6;
  master.connect(ctx.destination);
  for (const name of FILES) {
    fetch(`/sounds/${name}.mp3`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject()))
      .then((b) => ctx.decodeAudioData(b))
      .then((buf) => buffers.set(name, buf))
      .catch(() => {});
  }
  return ctx;
}

// Phones only allow sound after a tap: set it up and wake it on the first one.
const unlock = () => {
  const c = audio();
  if (c?.state === "suspended") c.resume();
};
for (const ev of ["pointerdown", "keydown", "touchend"]) window.addEventListener(ev, unlock, { capture: true, passive: true });

export const isMuted = () => {
  try { return localStorage.getItem(MUTE_KEY) === "1"; } catch { return false; }
};
export function setMuted(m) {
  try { localStorage.setItem(MUTE_KEY, m ? "1" : "0"); } catch {}
  if (m) window.speechSynthesis?.cancel();
}

// Nothing plays until the context is running. If it went to sleep (the phone locked, or a
// call came in) ask it to wake up, so the next sound is heard even if this one is missed.
function ready() {
  if (isMuted() || !ctx) return false;
  if (ctx.state === "running") return true;
  ctx.resume?.().catch(() => {});
  return false;
}

// Plays a recording; `maxDur` cuts it short with a quick fade (e.g. steps for a short move).
function playFile(name, delay = 0, maxDur = Infinity) {
  const buf = buffers.get(name);
  if (!buf) return false;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const t = ctx.currentTime + delay;
  if (maxDur < buf.duration) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(1, t + maxDur - 0.06);
    g.gain.linearRampToValueAtTime(0, t + maxDur);
    src.connect(g).connect(master);
    src.start(t);
    src.stop(t + maxDur);
  } else {
    src.connect(master);
    src.start(t);
  }
  return true;
}

// ---- building blocks
function tone(t, { freq, to = freq, type = "sine", dur = 0.15, vol = 0.4, attack = 0.005 }) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to !== freq) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

let noiseBuf = null;
function noise(t, { dur = 0.05, vol = 0.3, freq = 2000, q = 1, type = "bandpass" }) {
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.02);
}

// ---- the sounds
const SOUNDS = {
  // Dice shaken in the hand: a burst of little clicks.
  roll(t) {
    for (let i = 0; i < 9; i++) noise(t + i * 0.045 + Math.random() * 0.02, { dur: 0.03, vol: 0.35, freq: 2500 + Math.random() * 2500, q: 4 });
  },
  // Dice hitting the board: two knocks.
  land(t) {
    for (const [dt, v] of [[0, 0.5], [0.09, 0.3], [0.16, 0.15]]) {
      noise(t + dt, { dur: 0.06, vol: v, freq: 900, q: 2 });
      tone(t + dt, { freq: 180, to: 90, dur: 0.06, vol: v * 0.6 });
    }
  },
  // One tick per square moved (pass { steps }).
  steps(t, { steps = 1 } = {}) {
    const n = Math.min(steps, 12);
    for (let i = 0; i < n; i++) tone(t + i * 0.06, { freq: 1100 + i * 25, type: "triangle", dur: 0.04, vol: 0.18 });
  },
  // Heavy hit for a capture.
  capture(t) {
    tone(t, { freq: 140, to: 40, dur: 0.35, vol: 0.9 });
    noise(t, { dur: 0.18, vol: 0.6, freq: 400, q: 0.7, type: "lowpass" });
    tone(t + 0.02, { freq: 70, to: 35, type: "square", dur: 0.2, vol: 0.15 });
  },
  // "Awww": a sad slide down, for the one who got chopped.
  groan(t) {
    tone(t, { freq: 330, to: 300, type: "sawtooth", dur: 0.3, vol: 0.12, attack: 0.03 });
    tone(t + 0.3, { freq: 300, to: 160, type: "sawtooth", dur: 0.7, vol: 0.12, attack: 0.02 });
  },
  // A token gets home.
  home(t) {
    [784, 988, 1319].forEach((f, i) => tone(t + i * 0.08, { freq: f, type: "triangle", dur: 0.35, vol: 0.25 }));
  },
  // Your turn.
  turn(t) {
    tone(t, { freq: 880, dur: 0.12, vol: 0.25 });
    tone(t + 0.11, { freq: 1320, dur: 0.22, vol: 0.25 });
  },
  // Winner.
  win(t) {
    const notes = [523, 659, 784, 1047, 784, 1047];
    const times = [0, 0.12, 0.24, 0.36, 0.56, 0.68];
    notes.forEach((f, i) => tone(t + times[i], { freq: f, type: "square", dur: i === 5 ? 0.6 : 0.14, vol: 0.12 }));
    notes.forEach((f, i) => tone(t + times[i], { freq: f / 2, type: "triangle", dur: i === 5 ? 0.6 : 0.14, vol: 0.2 }));
  },
};

export function play(name, opts = {}, delay = 0) {
  if (!ready()) return;
  // Steps last about as long as the token's hop: longer moves play more of the recording.
  const maxDur = name === "steps" ? 0.25 + Math.min(opts.steps ?? 1, 12) * 0.08 : Infinity;
  if (playFile(name, delay, maxDur)) return;
  SOUNDS[name]?.(ctx.currentTime + delay, opts);
}

// A spoken line: the recording if there is one ("voice-<id>"), else the phone's own voice.
export function say(id, text, delay = 0) {
  if (!ready()) return;
  if (playFile(`voice-${id}`, delay)) return;
  const synth = window.speechSynthesis;
  if (!synth || !window.SpeechSynthesisUtterance) return;
  const u = new SpeechSynthesisUtterance(text.replace(/[^\p{L}\p{N}\s!?',.]/gu, ""));
  u.rate = 1.1;
  u.pitch = 1.2;
  setTimeout(() => { synth.cancel(); synth.speak(u); }, delay * 1000);
}

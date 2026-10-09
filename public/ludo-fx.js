// Capture effect for Ludo: big text, board shake and confetti in the victim's colour.
// Code-only for now; a Lottie / Rive animation can replace the text later.

import * as sound from "./sound.js";

// id names the recording that can replace the spoken line: public/sounds/voice-<id>.mp3
const ATTACK_LINES = [
  { id: "chop", text: "CHOP AM JOORRR!", speak: "Chop am jorrr!" },
  { id: "rekt", text: "Get rekt" },
  { id: "oya", text: "Oya go house!" },
];
const VICTIM_LINES = [{ text: "Dem don chop you! 😭" }, { text: "Ouch! Back to yard" }, { text: "Na wa o!" }];
const pickLine = (lines) => lines[Math.floor(Math.random() * lines.length)];
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// boardEl: the board on screen (shaken, confetti bursts from its middle). hex: victim's colour.
// victim: true when this phone's player was the one captured.
export function playCapture(boardEl, { hex, victim }) {
  const text = document.createElement("div");
  text.className = `capture-text${victim ? " victim" : ""}`;
  text.style.setProperty("--c", hex);
  text.style.setProperty("--tilt", `${(Math.random() * 10 - 5).toFixed(1)}deg`);
  const line = pickLine(victim ? VICTIM_LINES : ATTACK_LINES);
  text.textContent = line.text;
  document.body.appendChild(text);
  setTimeout(() => text.remove(), 1800);

  sound.play("capture");
  if (victim) {
    sound.play("groan", {}, 0.25);
    navigator.vibrate?.([120, 60, 200]);
  } else sound.say(line.id, line.speak ?? line.text, 0.2);
  if (reducedMotion()) return;

  boardEl.classList.remove("shake");
  void boardEl.offsetWidth; // restart the animation if one is still running
  boardEl.classList.add("shake");
  setTimeout(() => boardEl.classList.remove("shake"), 600);

  confetti(boardEl.getBoundingClientRect(), hex);
}

function confetti(rect, hex) {
  const canvas = document.createElement("canvas");
  canvas.className = "capture-confetti";
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  document.body.appendChild(canvas);
  const g = canvas.getContext("2d");
  g.scale(dpr, dpr);

  const shades = [hex, hex, hex, "#ffffff", mix(hex, "#000000", 0.3)];
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const bits = Array.from({ length: 140 }, () => {
    const a = Math.random() * Math.PI * 2;
    const v = 4 + Math.random() * 9;
    return {
      x: cx, y: cy,
      vx: Math.cos(a) * v, vy: Math.sin(a) * v - 5,
      w: 6 + Math.random() * 6, h: 3 + Math.random() * 4,
      rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.4,
      color: shades[Math.floor(Math.random() * shades.length)],
    };
  });

  const start = performance.now();
  const LIFE = 1700;
  function frame(now) {
    const t = now - start;
    g.clearRect(0, 0, w, h);
    g.globalAlpha = Math.max(0, 1 - Math.max(0, t - LIFE * 0.6) / (LIFE * 0.4));
    for (const b of bits) {
      b.vy += 0.32;
      b.vx *= 0.985;
      b.x += b.vx;
      b.y += b.vy;
      b.rot += b.vr;
      g.save();
      g.translate(b.x, b.y);
      g.rotate(b.rot);
      g.scale(1, Math.cos(b.rot * 2)); // flutter
      g.fillStyle = b.color;
      g.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
      g.restore();
    }
    if (t < LIFE) requestAnimationFrame(frame);
    else canvas.remove();
  }
  requestAnimationFrame(frame);
}

function mix(a, b, k) {
  const n = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const [x, y] = [n(a), n(b)];
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * k)).join(",")})`;
}

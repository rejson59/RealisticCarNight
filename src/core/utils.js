import * as THREE from 'three';

// Deterministic RNG so the city is identical on every launch/device.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export function canvasTexture(canvas, { repeat = null, srgb = true, aniso = 4 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  t.needsUpdate = true;
  return t;
}

/* ---------------- Building facade: dark glass + lit windows ---------------- */
export function facadeTextures(seed) {
  const rnd = mulberry32(seed);
  const W = 256, H = 512;
  const map = makeCanvas(W, H);
  const emi = makeCanvas(W, H);
  const mc = map.getContext('2d');
  const ec = emi.getContext('2d');

  mc.fillStyle = '#141924'; mc.fillRect(0, 0, W, H);
  ec.fillStyle = '#000000'; ec.fillRect(0, 0, W, H);

  // concrete/floor bands + mullions
  for (let y = 0; y < H; y += 18) {
    mc.fillStyle = 'rgba(0,0,0,0.5)';
    mc.fillRect(0, y, W, 2);
  }
  for (let x = 0; x < W; x += 21) {
    mc.fillStyle = 'rgba(0,0,0,0.45)';
    mc.fillRect(x, 0, 2, H);
  }
  const cols = 12, rows = 28;
  const cw = W / cols, ch = H / rows;
  const palette = ['#ffd9a0', '#ffe9c4', '#cfe2ff', '#a8f0dc', '#ffb46b', '#e8f4ff'];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * cw + 3, y = r * ch + 4;
      const w = cw - 6, h = ch - 8;
      // glass (always slightly visible in albedo)
      mc.fillStyle = `rgba(${20 + rnd() * 18 | 0},${26 + rnd() * 18 | 0},${38 + rnd() * 20 | 0},1)`;
      mc.fillRect(x, y, w, h);
      if (rnd() < 0.34) {
        const col = palette[(rnd() * palette.length) | 0];
        const a = 0.55 + rnd() * 0.45;
        ec.globalAlpha = a;
        ec.fillStyle = col;
        ec.fillRect(x, y, w, h);
        // inner structure: blinds / partial light
        if (rnd() < 0.5) {
          ec.globalAlpha = a * 0.35;
          ec.fillStyle = '#000';
          const bh = h * (0.2 + rnd() * 0.5);
          ec.fillRect(x, y, w, bh);
        }
        ec.globalAlpha = 1;
        mc.fillStyle = 'rgba(255,240,210,0.10)';
        mc.fillRect(x, y, w, h);
      }
    }
  }
  return { map, emi };
}

/* ---------------- Neon advertisement atlas (4x4 cells) ---------------- */
export function neonAtlas() {
  const S = 1024, cell = S / 4;
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  const rnd = mulberry32(1337);
  const combos = [
    ['#ff2d78', '#7a1bff'], ['#00e5ff', '#0040ff'], ['#ff8a00', '#ff004c'],
    ['#00ffa2', '#00b3ff'], ['#ff00e5', '#4a00ff'], ['#ffe600', '#ff5e00'],
    ['#8aff00', '#00c853'], ['#00fff2', '#7c4dff'],
  ];
  for (let cy = 0; cy < 4; cy++) {
    for (let cx = 0; cx < 4; cx++) {
      const x = cx * cell, y = cy * cell;
      const [c1, c2] = combos[(rnd() * combos.length) | 0];
      const grad = g.createLinearGradient(x, y, x + cell, y + cell);
      grad.addColorStop(0, c1); grad.addColorStop(1, c2);
      g.fillStyle = grad; g.fillRect(x, y, cell, cell);
      // fake content: bars, circles, "text"
      g.fillStyle = 'rgba(0,0,0,0.35)';
      const kind = (rnd() * 3) | 0;
      if (kind === 0) {
        for (let i = 0; i < 5; i++) {
          g.fillRect(x + 20, y + 30 + i * 42, cell - 40 - rnd() * 90, 18);
        }
      } else if (kind === 1) {
        g.beginPath();
        g.arc(x + cell / 2, y + cell / 2, cell * 0.28, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = 'rgba(255,255,255,0.85)';
        g.beginPath();
        g.arc(x + cell / 2, y + cell / 2, cell * 0.16, 0, Math.PI * 2);
        g.fill();
      } else {
        g.fillRect(x + 16, y + 16, cell - 32, cell * 0.3);
        g.fillStyle = 'rgba(255,255,255,0.8)';
        g.fillRect(x + 30, y + 30, cell - 60, cell * 0.12);
        g.fillStyle = 'rgba(0,0,0,0.45)';
        for (let i = 0; i < 3; i++) g.fillRect(x + 24, y + cell * 0.55 + i * 34, cell - 48 - rnd() * 80, 14);
      }
      // scanlines
      g.fillStyle = 'rgba(0,0,0,0.16)';
      for (let sy = y; sy < y + cell; sy += 6) g.fillRect(x, sy, cell, 2);
    }
  }
  return c;
}

/* ---------------- Asphalt + wet roughness + puddle mask ---------------- */
export function asphaltTextures() {
  const S = 512;
  const rnd = mulberry32(777);
  const albedo = makeCanvas(S, S);
  const a = albedo.getContext('2d');
  a.fillStyle = '#232a34'; a.fillRect(0, 0, S, S);
  for (let i = 0; i < 9000; i++) {
    const v = 30 + rnd() * 34;
    a.fillStyle = `rgba(${v | 0},${(v + 2) | 0},${(v + 5) | 0},0.5)`;
    a.fillRect(rnd() * S, rnd() * S, 1.6, 1.6);
  }
  // darker wet patches
  for (let i = 0; i < 40; i++) {
    const r = 20 + rnd() * 90;
    const g = a.createRadialGradient(rnd() * S, rnd() * S, 0, rnd() * S, rnd() * S, r);
    g.addColorStop(0, 'rgba(0,0,0,0.5)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    a.fillStyle = g; a.fillRect(0, 0, S, S);
  }

  // puddle mask (R = puddle, G = ripple noise)
  const mask = makeCanvas(S, S);
  const m = mask.getContext('2d');
  m.fillStyle = '#000'; m.fillRect(0, 0, S, S);
  for (let i = 0; i < 70; i++) {
    const x = rnd() * S, y = rnd() * S, r = 12 + rnd() * 70;
    const g = m.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    m.fillStyle = g;
    m.beginPath(); m.ellipse(x, y, r, r * (0.5 + rnd() * 0.7), rnd() * 3.14, 0, Math.PI * 2); m.fill();
  }
  // ripple noise in G channel
  const img = m.getImageData(0, 0, S, S);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = 100 + rnd() * 120;
    img.data[i + 1] = n;
  }
  m.putImageData(img, 0, 0);

  // roughness map: dry asphalt rough (light), puddles smooth (dark)
  const rough = makeCanvas(S, S);
  const r = rough.getContext('2d');
  r.fillStyle = '#b4b4b4'; r.fillRect(0, 0, S, S);
  r.globalAlpha = 1;
  r.drawImage(mask, 0, 0);
  r.globalCompositeOperation = 'difference';
  r.fillStyle = '#8c8c8c'; r.fillRect(0, 0, S, S);
  r.globalCompositeOperation = 'source-over';

  return { albedo, mask, rough };
}

/* ---------------- Radial glow sprites ---------------- */
export function radialTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)', size = 128, power = 1) {
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, inner);
  grad.addColorStop(0.35 ** power, inner.replace(/[\d.]+\)$/, '0.35)'));
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

export function lightPoolTexture() {
  const c = makeCanvas(128, 128);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, 'rgba(255,214,150,0.85)');
  grad.addColorStop(0.4, 'rgba(255,190,120,0.28)');
  grad.addColorStop(1, 'rgba(255,180,100,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return c;
}

export function headlightPoolTexture() {
  const c = makeCanvas(256, 256);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 4, 128, 128, 128);
  grad.addColorStop(0, 'rgba(225,238,255,0.55)');
  grad.addColorStop(0.35, 'rgba(205,225,255,0.20)');
  grad.addColorStop(0.7, 'rgba(190,215,255,0.06)');
  grad.addColorStop(1, 'rgba(180,210,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  return c;
}

/** light pool + vertical wet streak in ONE decal (fewer additive quads) */
export function poolStreakTexture() {
  const c = makeCanvas(128, 256);
  const g = c.getContext('2d');
  // pool (top-down radial)
  const pool = g.createRadialGradient(64, 128, 4, 64, 128, 62);
  pool.addColorStop(0, 'rgba(255,214,150,0.75)');
  pool.addColorStop(0.45, 'rgba(255,190,120,0.22)');
  pool.addColorStop(1, 'rgba(255,180,100,0)');
  g.fillStyle = pool;
  g.save();
  g.translate(0, 0);
  g.scale(1, 1);
  g.beginPath(); g.ellipse(64, 128, 62, 46, 0, 0, Math.PI * 2); g.fill();
  g.restore();
  // vertical streak along the decal's length
  for (let x = 0; x < 128; x++) {
    const fx = (x - 64) / 64;
    const a = Math.exp(-fx * fx * 7.0);
    g.fillStyle = `rgba(255,216,165,${(a * 0.4).toFixed(3)})`;
    g.fillRect(x, 0, 1, 256);
  }
  // fade both ends
  const fade = g.createLinearGradient(0, 0, 0, 256);
  fade.addColorStop(0, 'rgba(0,0,0,1)');
  fade.addColorStop(0.18, 'rgba(0,0,0,0)');
  fade.addColorStop(0.82, 'rgba(0,0,0,0)');
  fade.addColorStop(1, 'rgba(0,0,0,1)');
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = fade;
  g.fillRect(0, 0, 128, 256);
  g.globalCompositeOperation = 'source-over';
  return c;
}

/** vertical wet-road light streak (used under street lamps) */
export function streakTexture() {
  const c = makeCanvas(64, 256);
  const g = c.getContext('2d');
  for (let x = 0; x < 64; x++) {
    const fx = (x - 32) / 32;
    const a = Math.exp(-fx * fx * 5.5);
    g.fillStyle = `rgba(255,214,160,${(a * 0.55).toFixed(3)})`;
    g.fillRect(x, 0, 1, 256);
  }
  // fade the ends
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, 'rgba(0,0,0,1)');
  grad.addColorStop(0.25, 'rgba(0,0,0,0)');
  grad.addColorStop(0.75, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,1)');
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 256);
  g.globalCompositeOperation = 'source-over';
  return c;
}

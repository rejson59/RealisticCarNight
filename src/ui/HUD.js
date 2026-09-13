import { CITY } from '../world/City.js';

/** Speedometer gauge, minimap, toasts, score/trip/perf overlays. */
export class HUD {
  constructor() {
    this.gauge = document.getElementById('gauge');
    this.gctx = this.gauge.getContext('2d');
    this.mini = document.getElementById('minimap');
    this.mctx = this.mini.getContext('2d');
    this.tierBox = document.getElementById('tierBox');
    this.fpsBox = document.getElementById('fpsBox');
    this.toastEl = document.getElementById('toast');
    this.hud = document.getElementById('hud');
    this.scoreBox = document.getElementById('scoreBox');
    this.scoreVal = document.getElementById('scoreVal');
    this.comboBox = document.getElementById('comboBox');
    this.driftBox = document.getElementById('driftBox');
    this.driftVal = document.getElementById('driftVal');
    this.tripDist = document.getElementById('tripDist');
    this.tripTime = document.getElementById('tripTime');
    this.radioNow = document.getElementById('radioNow');
    this.perfBox = document.getElementById('perfBox');
    this.hintsBox = document.getElementById('kbhints');
    this.toastTimer = 0;
    this.fpsAcc = 0;
    this.fpsN = 0;
    this.rotate = false;
    this._setupSizes();
    this._staticMap = null;
  }

  _setupSizes() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const [c, size] of [[this.gauge, 190], [this.mini, 168]]) {
      c.width = size * dpr;
      c.height = size * dpr;
      c.style.width = `${size}px`;
      c.style.height = `${size}px`;
    }
    this.dpr = dpr;
  }

  show() { this.hud.style.display = 'block'; }

  toast(msg, ms = 2600) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastEl.classList.remove('show'), ms);
  }

  setTier(label) { this.tierBox.textContent = label; }
  setHints(on) { if (this.hintsBox) this.hintsBox.style.display = on ? 'block' : 'none'; }
  setRotate(on) { this.rotate = !!on; }

  setScore(score, combo, show) {
    if (!this.scoreBox) return;
    this.scoreBox.classList.toggle('hidden', !show);
    if (!show) return;
    this.scoreVal.textContent = String(score);
    this.comboBox.classList.toggle('off', combo <= 1);
    this.comboBox.textContent = `×${combo}`;
  }

  setDrift(pts, active) {
    if (!this.driftBox) return;
    this.driftBox.classList.toggle('off', !active);
    this.driftVal.textContent = String(Math.round(pts));
  }

  setTrip(km, clock) {
    if (this.tripDist) this.tripDist.textContent = `${km.toFixed(2)} km`;
    if (this.tripTime) this.tripTime.textContent = clock;
  }

  setRadio(name, on) {
    if (!this.radioNow) return;
    this.radioNow.classList.toggle('off', !on);
    this.radioNow.textContent = on ? `📻 ${name}` : '';
  }

  setPerf(text, on) {
    if (!this.perfBox) return;
    this.perfBox.classList.toggle('off', !on);
    if (on) this.perfBox.textContent = text;
  }

  buildStaticMap(city) {
    const c = document.createElement('canvas');
    const S = 168 * this.dpr;
    c.width = S; c.height = S;
    const g = c.getContext('2d');
    const range = CITY.EXTENT + CITY.ROAD * 2;
    const k = S / range;
    const toPx = (v) => (v + range / 2) * k;
    g.fillStyle = 'rgba(5,9,16,0.92)';
    g.fillRect(0, 0, S, S);
    g.fillStyle = 'rgba(30,40,58,0.55)';
    for (let i = 0; i < CITY.N; i++) {
      const cx = -CITY.HALF + i * CITY.S + CITY.S / 2;
      g.fillRect(toPx(cx - CITY.BLOCK / 2), toPx(cx - CITY.BLOCK / 2), CITY.BLOCK * k, CITY.BLOCK * k);
    }
    g.strokeStyle = 'rgba(120,140,170,0.5)';
    g.lineWidth = Math.max(1.5, CITY.ROAD * k * 0.5);
    for (const L of city.roadLines) {
      g.beginPath(); g.moveTo(toPx(L), 0); g.lineTo(toPx(L), S); g.stroke();
      g.beginPath(); g.moveTo(0, toPx(L)); g.lineTo(S, toPx(L)); g.stroke();
    }
    g.strokeStyle = 'rgba(35,190,150,0.55)';
    g.lineWidth = Math.max(1.2, 3 * this.dpr * 0.6);
    for (const curve of city.elevCurves) {
      g.beginPath();
      for (let i = 0; i <= 90; i++) {
        const p = curve.getPointAt((i / 90) % 1);
        const x = toPx(p.x), y = toPx(p.z);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
    }
    this._staticMap = c;
    this._mapK = k;
    this._mapRange = range;
  }

  drawMinimap(car, trafficPositions, rings) {
    if (!this._staticMap) return;
    const g = this.mctx;
    const S = this.mini.width;
    g.clearRect(0, 0, S, S);
    const k = this._mapK;
    const range = this._mapRange;
    const toPx = (v) => (v + range / 2) * k;
    const rot = this.rotate ? Math.PI - car.heading : 0;

    g.save();
    if (rot) {
      g.translate(S / 2, S / 2);
      g.rotate(rot);
      g.translate(-S / 2, -S / 2);
    }
    g.drawImage(this._staticMap, 0, 0);

    // traffic
    g.fillStyle = 'rgba(255,205,120,0.9)';
    for (let i = 0; i < trafficPositions.length; i += 2) {
      g.fillRect(toPx(trafficPositions[i]) - 1.5, toPx(trafficPositions[i + 1]) - 1.5, 3, 3);
    }
    // collectible rings
    if (rings && rings.length) {
      g.lineWidth = 1.4 * this.dpr * 0.7;
      g.strokeStyle = 'rgba(120,240,255,0.95)';
      for (let i = 0; i < rings.length; i += 2) {
        g.beginPath();
        g.arc(toPx(rings[i]), toPx(rings[i + 1]), 2.6 * this.dpr * 0.7, 0, Math.PI * 2);
        g.stroke();
      }
    }
    // car
    g.save();
    g.translate(toPx(car.pos.x), toPx(car.pos.z));
    g.rotate(Math.PI - car.heading - rot);
    g.fillStyle = '#6fe3ff';
    g.beginPath();
    g.moveTo(0, -6 * this.dpr * 0.6);
    g.lineTo(4 * this.dpr * 0.6, 5 * this.dpr * 0.6);
    g.lineTo(-4 * this.dpr * 0.6, 5 * this.dpr * 0.6);
    g.closePath();
    g.fill();
    g.restore();
    g.restore();

    // frame (+ a north tick when the map rotates)
    g.strokeStyle = 'rgba(110,227,255,0.25)';
    g.lineWidth = 1 * this.dpr;
    g.strokeRect(0.5, 0.5, S - 1, S - 1);
    if (rot) {
      g.save();
      g.translate(S / 2, S / 2);
      g.rotate(-rot);
      g.strokeStyle = 'rgba(234,246,255,0.75)';
      g.lineWidth = 1.6 * this.dpr;
      g.beginPath();
      g.moveTo(0, -S / 2 + 4 * this.dpr);
      g.lineTo(0, -S / 2 + 10 * this.dpr);
      g.stroke();
      g.restore();
    }
  }

  drawGauge(kmh, gear, braking) {
    const g = this.gctx;
    const S = this.gauge.width;
    const cx = S / 2, cy = S / 2;
    const R = S * 0.42;
    g.clearRect(0, 0, S, S);
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    g.beginPath();
    g.arc(cx, cy, R + 6 * this.dpr, 0, Math.PI * 2);
    g.fillStyle = 'rgba(6,10,18,0.55)';
    g.fill();
    g.lineWidth = 5 * this.dpr;
    g.strokeStyle = 'rgba(90,110,140,0.35)';
    g.beginPath(); g.arc(cx, cy, R, a0, a1); g.stroke();
    const t = Math.min(1, kmh / 240);
    const grad = g.createLinearGradient(0, S, S, 0);
    grad.addColorStop(0, '#28d7fe');
    grad.addColorStop(1, '#ff2d78');
    g.strokeStyle = grad;
    g.lineWidth = 5 * this.dpr;
    g.lineCap = 'round';
    g.beginPath(); g.arc(cx, cy, R, a0 + (a1 - a0) * t); g.stroke();
    g.lineWidth = 1.4 * this.dpr;
    g.strokeStyle = 'rgba(200,220,255,0.5)';
    for (let v = 0; v <= 240; v += 20) {
      const a = a0 + (a1 - a0) * (v / 240);
      const r1 = R - 6 * this.dpr, r2 = R - 12 * this.dpr;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      g.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      g.stroke();
    }
    g.fillStyle = '#eaf6ff';
    g.font = `600 ${26 * this.dpr}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(Math.round(kmh)), cx, cy - 2 * this.dpr);
    g.font = `500 ${9 * this.dpr}px system-ui, sans-serif`;
    g.fillStyle = 'rgba(190,215,240,0.75)';
    g.fillText('km/h', cx, cy + 14 * this.dpr);
    g.font = `700 ${12 * this.dpr}px system-ui, sans-serif`;
    g.fillStyle = braking ? '#ff5468' : '#7fe8c8';
    g.fillText(gear, cx, cy + 30 * this.dpr);
  }

  fps(dt) {
    this.fpsAcc += dt; this.fpsN += 1;
    if (this.fpsAcc >= 0.5) {
      const f = Math.round(this.fpsN / this.fpsAcc);
      this.fpsBox.textContent = `${f} FPS`;
      this.lastFps = f;
      this.fpsAcc = 0; this.fpsN = 0;
    }
  }
}

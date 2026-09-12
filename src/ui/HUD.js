import { CITY } from '../world/City.js';

/** Speedometer gauge, minimap, toasts, overlays. */
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
    this.toastTimer = 0;
    this.fpsAcc = 0;
    this.fpsN = 0;
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
    // blocks
    g.fillStyle = 'rgba(30,40,58,0.55)';
    for (let i = 0; i < CITY.N; i++) {
      const cx = -CITY.HALF + i * CITY.S + CITY.S / 2;
      g.fillRect(toPx(cx - CITY.BLOCK / 2), toPx(cx - CITY.BLOCK / 2), CITY.BLOCK * k, CITY.BLOCK * k);
    }
    // roads
    g.strokeStyle = 'rgba(120,140,170,0.5)';
    g.lineWidth = Math.max(1.5, CITY.ROAD * k * 0.5);
    for (const L of city.roadLines) {
      g.beginPath(); g.moveTo(toPx(L), 0); g.lineTo(toPx(L), S); g.stroke();
      g.beginPath(); g.moveTo(0, toPx(L)); g.lineTo(S, toPx(L)); g.stroke();
    }
    // elevated
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

  drawMinimap(car, trafficPositions) {
    if (!this._staticMap) return;
    const g = this.mctx;
    const S = this.mini.width;
    g.clearRect(0, 0, S, S);
    g.drawImage(this._staticMap, 0, 0);
    const k = this._mapK;
    const range = this._mapRange;
    const toPx = (v) => (v + range / 2) * k;
    // traffic
    g.fillStyle = 'rgba(255,205,120,0.9)';
    for (let i = 0; i < trafficPositions.length; i += 2) {
      g.fillRect(toPx(trafficPositions[i]) - 1.5, toPx(trafficPositions[i + 1]) - 1.5, 3, 3);
    }
    // car
    g.save();
    g.translate(toPx(car.pos.x), toPx(car.pos.z));
    g.rotate(-car.heading + Math.PI);
    g.fillStyle = '#6fe3ff';
    g.beginPath();
    g.moveTo(0, -6 * this.dpr * 0.6);
    g.lineTo(4 * this.dpr * 0.6, 5 * this.dpr * 0.6);
    g.lineTo(-4 * this.dpr * 0.6, 5 * this.dpr * 0.6);
    g.closePath();
    g.fill();
    g.restore();
    // frame
    g.strokeStyle = 'rgba(110,227,255,0.25)';
    g.lineWidth = 1 * this.dpr;
    g.strokeRect(0.5, 0.5, S - 1, S - 1);
  }

  drawGauge(kmh, gear, braking) {
    const g = this.gctx;
    const S = this.gauge.width;
    const cx = S / 2, cy = S / 2;
    const R = S * 0.42;
    g.clearRect(0, 0, S, S);
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    // dial bg
    g.beginPath();
    g.arc(cx, cy, R + 6 * this.dpr, 0, Math.PI * 2);
    g.fillStyle = 'rgba(6,10,18,0.55)';
    g.fill();
    // track
    g.lineWidth = 5 * this.dpr;
    g.strokeStyle = 'rgba(90,110,140,0.35)';
    g.beginPath(); g.arc(cx, cy, R, a0, a1); g.stroke();
    // speed arc
    const t = Math.min(1, kmh / 240);
    const grad = g.createLinearGradient(0, S, S, 0);
    grad.addColorStop(0, '#28d7fe');
    grad.addColorStop(1, '#ff2d78');
    g.strokeStyle = grad;
    g.lineWidth = 5 * this.dpr;
    g.lineCap = 'round';
    g.beginPath(); g.arc(cx, cy, R, a0, a0 + (a1 - a0) * t); g.stroke();
    // ticks
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
    // digital
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
      this.fpsBox.textContent = `${Math.round(this.fpsN / this.fpsAcc)} FPS`;
      this.fpsAcc = 0; this.fpsN = 0;
    }
  }
}

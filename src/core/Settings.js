/**
 * Persistent user settings (localStorage) with change notifications.
 * Everything the menu/garage touches lives here so the game can re-apply the
 * whole configuration from one place (`main._applySettings`).
 */
const KEY = 'rcn.settings.v1';

export const PAINTS = [
  { name: 'Czerń nocy', hex: '#11131a' },
  { name: 'Grafit', hex: '#2b3038' },
  { name: 'Biały perłowy', hex: '#c7ccd6' },
  { name: 'Czerwień neon', hex: '#5a0f18' },
  { name: 'Granat', hex: '#101f3a' },
  { name: 'Turkus', hex: '#0e3b45' },
  { name: 'Butelkowa zieleń', hex: '#0f2c22' },
  { name: 'Fiolet ultra', hex: '#2c1145' },
  { name: 'Bursztyn', hex: '#4a3413' },
];

export const GLOWS = [
  { name: 'Brak', hex: null },
  { name: 'Cyjan', hex: '#28d7fe' },
  { name: 'Magenta', hex: '#ff2d78' },
  { name: 'Zieleń', hex: '#3dffa8' },
  { name: 'Fiolet', hex: '#9a5cff' },
  { name: 'Bursztyn', hex: '#ffb46b' },
  { name: 'Lód', hex: '#bfe9ff' },
];

export const HEADLIGHTS = [
  { name: 'Białe LED', hex: '#cfe0ff' },
  { name: 'Halogen', hex: '#ffd9a0' },
  { name: 'Lodowy błękit', hex: '#9fd8ff' },
  { name: 'Różowy neon', hex: '#ff9ad5' },
  { name: 'Zielony', hex: '#a8ffcf' },
  { name: 'Bursztyn', hex: '#ffc46b' },
];

export const QUALITY_MODES = [
  { id: 'auto', name: 'AUTO (dopasuje się sama)' },
  { id: 0, name: 'NISKA' },
  { id: 1, name: 'ŚREDNIA' },
  { id: 2, name: 'WYSOKA' },
  { id: 3, name: 'ULTRA' },
];

export const RAIN_MODES = [
  { id: 'auto', name: 'AUTO (tylko ULTRA)' },
  { id: 'on', name: 'Zawsze pada' },
  { id: 'off', name: 'Bez deszczu' },
];

export const DEFAULTS = {
  // garage
  paint: PAINTS[0].hex,
  glow: GLOWS[1].hex,
  headlights: HEADLIGHTS[0].hex,
  // graphics
  quality: 'auto',
  traffic: 1,
  rain: 'auto',
  fov: 0,           // -10..+10 degrees on top of the speed-dependent FOV
  reflections: 1,   // 0.5 / 1 / 1.5 multiplier of the tier resolution
  // audio
  master: 0.8,
  engine: 0.8,
  radio: 0.45,
  radioOn: true,
  station: 0,
  // gameplay / HUD
  camera: 0,
  objectives: true,
  hints: true,
  minimapRotate: false,
  perf: false,
  firstRun: true,
};

export class Settings {
  constructor() {
    this.data = { ...DEFAULTS };
    this.listeners = new Set();
    this.load();
  }

  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.data = { ...DEFAULTS, ...parsed };
        // sanity: clamp numbers back into range if the stored value is odd
        this.data.traffic = Number.isFinite(this.data.traffic)
          ? Math.min(2, Math.max(0, this.data.traffic)) : 1;
        this.data.master = Math.min(1, Math.max(0, +this.data.master || 0));
        this.data.engine = Math.min(1, Math.max(0, +this.data.engine || 0));
        this.data.radio = Math.min(1, Math.max(0, +this.data.radio || 0));
        this.data.fov = Math.min(10, Math.max(-10, +this.data.fov || 0));
        this.data.reflections = Math.min(2, Math.max(0.5, +this.data.reflections || 1));
      }
    } catch { /* private mode / disabled storage — defaults are fine */ }
  }

  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch { /* ignore */ }
  }

  get(k) { return this.data[k]; }

  set(k, v) {
    if (this.data[k] === v) return false;
    this.data[k] = v;
    this.save();
    this._emit(k, v);
    return true;
  }

  /** change several keys but notify (and re-apply) only once */
  patch(obj) {
    let changed = false;
    for (const [k, v] of Object.entries(obj)) {
      if (this.data[k] !== v) { this.data[k] = v; changed = true; }
    }
    if (changed) { this.save(); this._emit('*', null); }
    return changed;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(k, v) { for (const fn of this.listeners) fn(k, v, this.data); }

  reset() {
    this.data = { ...DEFAULTS, firstRun: false };
    this.save();
    this._emit('*', null);
  }
}

/* ------------------------------------------------- session records (bests) */
const RKEY = 'rcn.records.v1';
export const RECORD_DEFAULTS = {
  score: 0, rings: 0, distance: 0, topSpeed: 0, drift: 0, time: 0,
};

export class Records {
  constructor() {
    this.data = { ...RECORD_DEFAULTS };
    try {
      const raw = localStorage.getItem(RKEY);
      if (raw) this.data = { ...RECORD_DEFAULTS, ...JSON.parse(raw) };
    } catch { /* ignore */ }
  }

  save() { try { localStorage.setItem(RKEY, JSON.stringify(this.data)); } catch { /* ignore */ } }

  /** submit a finished session, returns the list of beaten records */
  submit(session) {
    const beaten = [];
    const map = {
      score: 'punkty', rings: 'pierścienie', distance: 'dystans',
      topSpeed: 'prędkość maks.', drift: 'drift', time: 'czas jazdy',
    };
    for (const k of Object.keys(RECORD_DEFAULTS)) {
      const v = session[k] || 0;
      if (v > (this.data[k] || 0)) { this.data[k] = v; beaten.push(map[k] || k); }
    }
    if (beaten.length) this.save();
    return beaten;
  }

  clear() { this.data = { ...RECORD_DEFAULTS }; this.save(); }
}

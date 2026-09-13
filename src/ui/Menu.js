import {
  PAINTS, GLOWS, HEADLIGHTS, QUALITY_MODES, RAIN_MODES, LUT_MODES, SHADOW_MODES,
} from '../core/Settings.js';

/**
 * Settings / garage panel. Everything is rendered from the Settings store, so
 * the UI never holds its own state — a change is written, persisted and then
 * re-applied by main through `onApply`.
 */
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};

const fmt = (n, unit = '') => `${Math.round(n)}${unit}`;

export class Menu {
  /**
   * @param {object} opts
   * @param {import('../core/Settings.js').Settings} opts.settings
   * @param {import('../core/Settings.js').Records} opts.records
   * @param {{name:string}[]} opts.stations radio station list
   * @param {(key:string, value:any)=>void} opts.onApply
   * @param {()=>object} opts.session live session stats
   * @param {()=>object|null} opts.stats live render-pipeline stats
   */
  constructor({ settings, records, stations = [], onApply, session = () => ({}), stats = () => null }) {
    this.settings = settings;
    this.records = records;
    this.stations = stations;
    this.onApply = onApply || (() => {});
    this.session = session;
    this.stats = stats;
    this.root = document.getElementById('menu');
    this.tabsEl = document.getElementById('menuTabs');
    this.bodyEl = document.getElementById('menuBody');
    this.tabs = [
      { id: 'garage', name: '🚗 Garaż' },
      { id: 'gfx', name: '✨ Grafika' },
      { id: 'audio', name: '🔊 Dźwięk' },
      { id: 'game', name: '🎮 Gra' },
    ];
    this.tab = 'garage';
    this._buildTabs();
    document.getElementById('menuClose')?.addEventListener('click', () => this.close());
    this.root?.addEventListener('pointerdown', (e) => { if (e.target === this.root) this.close(); });
    this.render();
  }

  get isOpen() { return !!this.root && !this.root.classList.contains('hidden'); }

  open(tab) {
    if (!this.root) return;
    if (tab) this.setTab(tab);
    this.root.classList.remove('hidden');
    this.render();
  }

  close() { this.root?.classList.add('hidden'); }

  toggle(tab) { this.isOpen ? this.close() : this.open(tab); }

  setTab(id) {
    this.tab = id;
    for (const b of this.tabsEl.children) b.classList.toggle('active', b.dataset.tab === id);
    this.render();
  }

  _buildTabs() {
    if (!this.tabsEl) return;
    this.tabsEl.textContent = '';
    for (const t of this.tabs) {
      const b = el('button', `tab${t.id === this.tab ? ' active' : ''}`, t.name);
      b.dataset.tab = t.id;
      b.addEventListener('click', () => this.setTab(t.id));
      this.tabsEl.appendChild(b);
    }
  }

  _set(key, value) {
    this.settings.set(key, value);
    this.onApply(key, value);
    this.render();
  }

  /* --------------------------------------------------------- primitives */
  _section(title, hint) {
    const s = el('div', 'sect');
    s.appendChild(el('h3', null, title));
    if (hint) s.appendChild(el('p', 'hint', hint));
    this.bodyEl.appendChild(s);
    return s;
  }

  _row(parent, label, valueText) {
    const r = el('div', 'row');
    r.appendChild(el('span', 'lbl', label));
    const v = el('span', 'val', valueText ?? '');
    r.appendChild(v);
    parent.appendChild(r);
    return { row: r, value: v };
  }

  _swatches(parent, list, current, key) {
    const box = el('div', 'swatches');
    for (const opt of list) {
      const b = el('button', 'sw');
      const active = (opt.hex ?? null) === (current ?? null);
      b.classList.toggle('active', active);
      b.title = opt.name;
      if (opt.hex) {
        b.style.background = `linear-gradient(140deg, ${opt.hex}, ${opt.hex} 55%, rgba(255,255,255,.22))`;
        b.style.boxShadow = active ? `0 0 0 2px #0a0e18, 0 0 16px ${opt.hex}` : `0 0 0 1px rgba(255,255,255,.14)`;
      } else {
        b.innerHTML = '<span class="no">✕</span>';
      }
      b.addEventListener('click', () => this._set(key, opt.hex));
      box.appendChild(b);
    }
    parent.appendChild(box);
    return box;
  }

  _slider(parent, { label, key, min, max, step, unit = '', scale = 1, digits = 0 }) {
    const cur = this.settings.get(key);
    const { value } = this._row(parent, label, `${(cur * scale).toFixed(digits)}${unit}`);
    const input = el('input');
    input.type = 'range';
    input.min = min; input.max = max; input.step = step; input.value = cur;
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      value.textContent = `${(v * scale).toFixed(digits)}${unit}`;
      this.settings.set(key, v);
      this.onApply(key, v);
    });
    parent.appendChild(input);
    return input;
  }

  _select(parent, { label, key, options }) {
    this._row(parent, label);
    const sel = el('select');
    const cur = this.settings.get(key);
    for (const o of options) {
      const opt = el('option', null, o.name);
      opt.value = String(o.id);
      if (String(o.id) === String(cur)) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => {
      const raw = sel.value;
      // numeric ids stay numbers, everything else (lut/shadow mode) stays a string
      const v = /^-?[0-9.]+$/.test(raw) ? Number(raw) : raw;
      this._set(key, v);
    });
    parent.appendChild(sel);
    return sel;
  }

  _toggle(parent, { label, key, hint }) {
    const r = el('div', 'row toggle-row');
    const left = el('div', null);
    left.appendChild(el('span', 'lbl', label));
    if (hint) left.appendChild(el('p', 'hint', hint));
    r.appendChild(left);
    const sw = el('button', 'switch');
    const on = !!this.settings.get(key);
    sw.classList.toggle('on', on);
    sw.innerHTML = '<i></i>';
    sw.setAttribute('aria-pressed', String(on));
    sw.addEventListener('click', () => this._set(key, !on));
    r.appendChild(sw);
    parent.appendChild(r);
    return sw;
  }

  _button(parent, label, fn, cls = '') {
    const b = el('button', `mbtn ${cls}`, label);
    b.addEventListener('click', fn);
    parent.appendChild(b);
    return b;
  }

  /* -------------------------------------------------------------- render */
  render() {
    if (!this.bodyEl) return;
    this.bodyEl.textContent = '';
    if (this.tab === 'garage') this._renderGarage();
    else if (this.tab === 'gfx') this._renderGfx();
    else if (this.tab === 'audio') this._renderAudio();
    else this._renderGame();
  }

  _renderGarage() {
    const s = this.settings;
    let sec = this._section('Lakier', 'Kliknij kolor — zmiana jest natychmiastowa i zapisuje się na tym urządzeniu.');
    this._swatches(sec, PAINTS, s.get('paint'), 'paint');
    const custom = this._row(sec, 'Własny kolor');
    const picker = el('input');
    picker.type = 'color';
    picker.value = s.get('paint');
    picker.className = 'picker';
    picker.addEventListener('input', () => {
      s.set('paint', picker.value);
      this.onApply('paint', picker.value);
      custom.value.textContent = picker.value;
    });
    custom.row.appendChild(picker);
    custom.value.textContent = s.get('paint');

    sec = this._section('Neon podwozia', 'Świeci w mokrym asfalcie i w odbiciach — czysty klimat nocnego miasta.');
    this._swatches(sec, GLOWS, s.get('glow'), 'glow');

    sec = this._section('Reflektory', 'Barwa lamp, stożków światła i plamy na asfalcie.');
    this._swatches(sec, HEADLIGHTS, s.get('headlights'), 'headlights');

    sec = this._section('Podsumowanie');
    const name = (list, hex) => (list.find((o) => o.hex === hex)?.name) || hex || '—';
    this._row(sec, 'Lakier', name(PAINTS, s.get('paint')));
    this._row(sec, 'Podświetlenie', s.get('glow') ? name(GLOWS, s.get('glow')) : 'wyłączone');
    this._row(sec, 'Reflektory', name(HEADLIGHTS, s.get('headlights')));
    this._button(sec, 'Przywróć ustawienia fabryczne', () => {
      this.settings.reset();
      this.onApply('*', null);
      this.render();
    }, 'warn');
  }

  _renderGfx() {
    const sec = this._section('Jakość obrazu', 'AUTO mierzy FPS i samo przełącza poziomy z histerezą — najbezpieczniejsze na telefonach.');
    this._select(sec, { label: 'Poziom grafiki', key: 'quality', options: QUALITY_MODES });
    this._select(sec, { label: 'Deszcz', key: 'rain', options: RAIN_MODES });
    this._select(sec, { label: 'Cienie', key: 'shadowMode', options: SHADOW_MODES });
    this._slider(sec, { label: 'Gęstość ruchu ulicznego', key: 'traffic', min: 0, max: 2, step: 0.25, scale: 1, digits: 2, unit: '×' });
    this._slider(sec, { label: 'Odbicia w kałużach', key: 'reflections', min: 0.5, max: 2, step: 0.25, digits: 2, unit: '×' });
    this._slider(sec, { label: 'Pole widzenia (FOV)', key: 'fov', min: -10, max: 10, step: 1, digits: 0, unit: '°' });

    const pipe = this._section('Potok renderowania',
      'Scena rysowana jest w niższej rozdzielczości wewnętrznej i rekonstruowana czasowo (jitter + historia + clip wariancji), '
      + 'a na końcu ostrzona CAS i oceniana lutem 3D — ta sama rodzina technik co DLSS/FSR. Wyłączenie wraca do natywnej rozdzielczości z MSAA.');
    this._toggle(pipe, {
      label: 'Skalowanie czasowe (TAA)',
      key: 'upscale',
      hint: 'Więcej FPS przy tej samej ostrości. Wyłączone = natywna rozdzielczość + MSAA.',
    });
    this._toggle(pipe, {
      label: 'Ambient Occlusion',
      key: 'ao',
      hint: 'Miękkie cienie kontaktowe w szczelinach, pod autem i przy krawężnikach.',
    });
    this._toggle(pipe, {
      label: 'Głębia ostrości (bokeh)',
      key: 'dof',
      hint: 'Delikatne rozmycie tła — oddziela auto od neonów, świetne w trybie foto.',
    });
    this._select(pipe, { label: 'Profil kolorystyczny', key: 'lut', options: LUT_MODES });
    this._slider(pipe, {
      label: 'Ekspozycja (ACES)', key: 'exposure', min: 0.7, max: 1.6, step: 0.05, digits: 2,
    });

    const info = this._section('Aktualny stan');
    const tierRow = this._row(info, 'Poziom', document.getElementById('tierBox')?.textContent || '—');
    const fpsRow = this._row(info, 'FPS', document.getElementById('fpsBox')?.textContent || '—');
    this._row(info, 'Rozdzielczość', `${fmt(innerWidth)}×${fmt(innerHeight)} @ ${Math.min(devicePixelRatio || 1, 2).toFixed(2)}×`);
    const ps = this.stats?.() || null;
    if (ps && ps.internal) {
      this._row(info, 'Rozdzielczość wewnętrzna',
        `${fmt(ps.internal[0])}×${fmt(ps.internal[1])} (${Math.round(ps.scale * 100)}%)`);
      const fx = [
        ps.taa ? 'skalowanie czasowe' : (ps.msaa ? `MSAA ×${ps.msaa}` : 'bez AA'),
        ps.velocity && 'wektory ruchu',
        ps.ao && 'AO',
        ps.dof && 'DOF',
        ps.lut && ps.lut !== 'none' && `LUT ${ps.lut}`,
      ].filter(Boolean);
      this._row(info, 'Aktywne efekty', fx.join(' • ') || '—');
    }
    this._button(info, 'Odśwież', () => {
      tierRow.value.textContent = document.getElementById('tierBox')?.textContent || '—';
      fpsRow.value.textContent = document.getElementById('fpsBox')?.textContent || '—';
    });
  }

  _renderAudio() {
    const s = this.settings;
    const sec = this._section('Głośność');
    this._slider(sec, { label: 'Głośność ogólna', key: 'master', min: 0, max: 1, step: 0.05, scale: 100, digits: 0, unit: '%' });
    this._slider(sec, { label: 'Silnik, wiatr i opony', key: 'engine', min: 0, max: 1, step: 0.05, scale: 100, digits: 0, unit: '%' });
    this._slider(sec, { label: 'Radio', key: 'radio', min: 0, max: 1, step: 0.05, scale: 100, digits: 0, unit: '%' });

    const r = this._section('Radio nocne', 'Cztery proceduralne stacje — wszystko syntezowane w przeglądarce, bez plików audio.');
    this._toggle(r, { label: 'Radio włączone', key: 'radioOn' });
    this._select(r, {
      label: 'Stacja',
      key: 'station',
      options: this.stations.map((st, i) => ({ id: i, name: `${i + 1}. ${st.name} — ${st.desc}` })),
    });
    const btns = el('div', 'btnrow');
    r.appendChild(btns);
    this._button(btns, '⏮ Poprzednia', () => this._set('station', (s.get('station') + this.stations.length - 1) % this.stations.length));
    this._button(btns, '⏭ Następna', () => this._set('station', (s.get('station') + 1) % this.stations.length), 'accent');
  }

  _renderGame() {
    const sec = this._section('Rozgrywka');
    this._toggle(sec, { label: 'Neonowe pierścienie', key: 'objectives', hint: 'Zbieraj je jadąc — punkty, mnożnik combo i rekordy.' });
    this._toggle(sec, { label: 'Podpowiedzi klawiszy', key: 'hints' });
    this._toggle(sec, { label: 'Obracana minimapa', key: 'minimapRotate', hint: 'Włączone: mapa kręci się razem z autem. Wyłączone: północ u góry.' });
    this._toggle(sec, { label: 'Panel wydajności', key: 'perf', hint: 'Draw-calle, trójkąty, rozdzielczość odbić (klawisz G).' });

    const st = this.session() || {};
    const rec = this.records.data;
    const ses = this._section('Ta sesja');
    this._row(ses, 'Dystans', `${((st.distance || 0) / 1000).toFixed(2)} km`);
    this._row(ses, 'Czas', `${fmt((st.time || 0) / 60)} min`);
    this._row(ses, 'Prędkość maks.', `${fmt(st.topSpeed || 0)} km/h`);
    this._row(ses, 'Punkty', fmt(st.score || 0));
    this._row(ses, 'Pierścienie', fmt(st.rings || 0));
    this._row(ses, 'Drift', `${fmt(st.drift || 0)} pkt`);

    const best = this._section('Rekordy (zapisane w przeglądarce)');
    this._row(best, 'Najwięcej punktów', fmt(rec.score));
    this._row(best, 'Pierścienie', fmt(rec.rings));
    this._row(best, 'Najdalsza trasa', `${(rec.distance / 1000).toFixed(2)} km`);
    this._row(best, 'Prędkość maks.', `${fmt(rec.topSpeed)} km/h`);
    this._row(best, 'Drift', `${fmt(rec.drift)} pkt`);
    this._button(best, 'Wyzeruj rekordy', () => { this.records.clear(); this.render(); }, 'warn');

    const about = this._section('O grze');
    about.appendChild(el('p', 'hint',
      'Realistic Car Night — całe miasto, samochód, tekstury, dźwięk i muzyka generowane proceduralnie w przeglądarce. Zero zewnętrznych assetów, Three.js + Vite.'));
  }
}

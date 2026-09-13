/**
 * Nocne radio — cztery stacje w całości syntezowane w WebAudio (zero plików).
 * Scheduler planuje całe takty z wyprzedzeniem ~1.2 s, więc gra dalej nawet
 * gdy przeglądarka throttle'uje timery w tle.
 *
 * Wszystko idzie przez `bus` (głośność radia) -> master AudioEngine, więc
 * wyciszenie (M) ścisza też muzykę.
 */
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

export const STATIONS = [
  {
    name: 'NEON DRIVE 88.4', desc: 'synthwave', bpm: 100, swing: 0,
    chords: [
      { notes: [57, 60, 64], bass: 33 },
      { notes: [53, 57, 60], bass: 29 },
      { notes: [48, 52, 55], bass: 36 },
      { notes: [55, 59, 62], bass: 31 },
    ],
    drums: {
      kick: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
      snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
      hat: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1],
      gain: 0.9,
    },
    bass: { type: 'sawtooth', steps: 8, filter: 380, gain: 0.42 },
    arp: { type: 'square', filter: 2300, gain: 0.13, oct: 12 },
    pad: { type: 'sawtooth', gain: 0.075, filter: 1000 },
  },
  {
    name: 'MIDNIGHT LO-FI 91.1', desc: 'chill / lo-fi', bpm: 74, swing: 0.16,
    chords: [
      { notes: [57, 60, 64, 67], bass: 33 },
      { notes: [53, 57, 60, 64], bass: 29 },
      { notes: [52, 55, 59, 62], bass: 40 },
      { notes: [55, 59, 62, 66], bass: 31 },
    ],
    drums: {
      kick: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
      snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1],
      hat: [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0],
      gain: 0.45,
    },
    bass: { type: 'sine', steps: 2, filter: 300, gain: 0.5 },
    melody: { pent: [69, 72, 74, 76, 79, 81], gain: 0.16 },
    pad: { type: 'triangle', gain: 0.10, filter: 800 },
    crackle: true,
  },
  {
    name: 'TURBO PHONK 104.7', desc: 'phonk / bass', bpm: 134, swing: 0,
    chords: [
      { notes: [57, 60, 64], bass: 33 },
      { notes: [57, 60, 64], bass: 33 },
      { notes: [53, 57, 60], bass: 29 },
      { notes: [52, 56, 59], bass: 28 },
    ],
    drums: {
      kick: [1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0],
      snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
      hat: [1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 1],
      gain: 1.0,
    },
    bass: { type: 'sawtooth', steps: 8, filter: 260, gain: 0.55, drive: 24 },
    bell: { type: 'square', freq: [810, 960], gain: 0.07 },
    arp: { type: 'sawtooth', filter: 1500, gain: 0.08, oct: 0, sparse: true },
  },
  {
    name: 'AMBIENT NIGHT 107.9', desc: 'ambient / chillout', bpm: 60, swing: 0,
    chords: [
      { notes: [45, 52, 57, 64], bass: 33 },
      { notes: [41, 48, 53, 60], bass: 29 },
      { notes: [43, 50, 55, 62], bass: 31 },
      { notes: [40, 47, 52, 59], bass: 28 },
    ],
    drums: null,
    pad: { type: 'sawtooth', gain: 0.09, filter: 620 },
    shimmer: { type: 'sine', gain: 0.10 },
    sub: true,
  },
];

export class Radio {
  constructor() {
    this.ctx = null;
    this.station = 0;
    this.enabled = false;
    this.bar = 0;
    this.nextBarTime = 0;
    this.timer = null;
    this.onStation = null;      // (name) => {}
    this.volume = 0.45;
    this._rng = Math.random;
  }

  /** hook into the shared AudioContext of the game's audio engine */
  attach(ctx, dest) {
    if (this.ctx) return;
    this.ctx = ctx;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.bus.connect(dest);

    // dotted-eighth feedback delay = the classic synthwave space
    this.delay = ctx.createDelay(2);
    this.delay.delayTime.value = 0.36;
    this.fb = ctx.createGain(); this.fb.gain.value = 0.34;
    this.dlp = ctx.createBiquadFilter(); this.dlp.type = 'lowpass'; this.dlp.frequency.value = 2400;
    this.send = ctx.createGain(); this.send.gain.value = 1;
    this.send.connect(this.delay);
    this.delay.connect(this.dlp).connect(this.fb).connect(this.delay);
    this.dlp.connect(this.bus);

    const len = ctx.sampleRate * 1.5;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  get name() { return STATIONS[this.station].name; }

  setVolume(v) {
    this.volume = v;
    if (this.ctx) this.bus.gain.setTargetAtTime(this.enabled ? v : 0, this.ctx.currentTime, 0.2);
  }

  setEnabled(on) {
    if (!this.ctx) { this.enabled = on; return; }
    this.enabled = on;
    const t = this.ctx.currentTime;
    this.bus.gain.setTargetAtTime(on ? this.volume : 0, t, 0.35);
    if (on && !this.timer) {
      this.bar = 0;
      this.nextBarTime = t + 0.15;
      this._schedule();
      this.timer = setInterval(() => this._schedule(), 250);
      this.onStation?.(this.name);
    } else if (!on && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  setStation(i) {
    this.station = ((i % STATIONS.length) + STATIONS.length) % STATIONS.length;
    this.onStation?.(this.name);
  }

  next() { this.setStation(this.station + 1); }

  /* ----------------------------------------------------------- scheduler */
  _schedule() {
    if (!this.ctx || !this.enabled) return;
    const now = this.ctx.currentTime;
    let guard = 0;
    while (this.nextBarTime < now + 1.3 && guard++ < 8) {
      this._playBar(STATIONS[this.station], this.bar, this.nextBarTime);
      this.bar += 1;
      this.nextBarTime += (60 / STATIONS[this.station].bpm) * 4;
    }
  }

  _sw(t, s, st) { return t + s * (60 / st.bpm / 4) + (s % 2 ? st.swing * (60 / st.bpm / 4) * 0.5 : 0); }

  _playBar(st, bar, t) {
    const spb = 60 / st.bpm;
    const step = spb / 4;
    const chord = st.chords[bar % st.chords.length];

    if (st.drums) {
      const g = st.drums.gain;
      for (let s = 0; s < 16; s++) {
        const tt = this._sw(t, s, st);
        if (st.drums.kick[s]) this._kick(tt, 0.85 * g);
        if (st.drums.snare[s]) this._snare(tt, 0.4 * g);
        if (st.drums.hat[s]) this._hat(tt, (s % 4 === 2 ? 0.16 : 0.09) * g, s === 14);
      }
    }

    if (st.bass) {
      const per = 16 / st.bass.steps;
      for (let s = 0; s < 16; s += per) {
        const note = chord.bass + (st.bass.steps === 8 && s === 12 ? 7 : 0);
        this._voice({
          t: this._sw(t, s, st), freq: mtof(note), dur: step * per * 0.85,
          type: st.bass.type, gain: st.bass.gain, filter: st.bass.filter,
          drive: st.bass.drive, attack: 0.006, release: 0.06,
        });
      }
    }

    if (st.arp) {
      for (let s = 0; s < 16; s++) {
        if (st.arp.sparse && this._rng() > 0.4) continue;
        const deg = (s + bar) % chord.notes.length;
        const oct = ((s / 4) | 0) % 2 ? st.arp.oct : 0;
        this._voice({
          t: this._sw(t, s, st), freq: mtof(chord.notes[deg] + 12 + oct),
          dur: step * 0.55, type: st.arp.type, gain: st.arp.gain,
          filter: st.arp.filter, send: 0.45, attack: 0.004, release: 0.05,
        });
      }
    }

    if (st.melody && this._rng() < 0.85) {
      const hits = 2 + ((this._rng() * 3) | 0);
      for (let k = 0; k < hits; k++) {
        const s = (this._rng() * 16) | 0;
        const note = st.melody.pent[(this._rng() * st.melody.pent.length) | 0];
        this._voice({
          t: this._sw(t, s, st), freq: mtof(note), dur: step * 1.6,
          type: 'sine', gain: st.melody.gain, filter: 3200, send: 0.6,
          attack: 0.01, release: 0.25,
        });
      }
    }

    if (st.bell) {
      for (let s = 0; s < 16; s += 4) {
        if (this._rng() < 0.5) continue;
        const f = st.bell.freq[(s / 4) % 2 | 0];
        this._voice({
          t: this._sw(t, s, st), freq: f, dur: step * 0.5, type: st.bell.type,
          gain: st.bell.gain, filter: 4000, send: 0.35, attack: 0.002, release: 0.08,
        });
      }
    }

    if (st.shimmer) {
      for (let s = 0; s < 16; s += 2) {
        if (this._rng() < 0.55) continue;
        const note = chord.notes[(this._rng() * chord.notes.length) | 0] + 24;
        this._voice({
          t: this._sw(t, s, st), freq: mtof(note), dur: step * 2.2, type: st.shimmer.type,
          gain: st.shimmer.gain, send: 0.9, attack: 0.15, release: 0.9,
        });
      }
    }

    if (st.sub) {
      this._voice({
        t, freq: mtof(chord.bass - 12), dur: spb * 3.6, type: 'sine',
        gain: 0.3, attack: 1.1, release: 1.4,
      });
    }

    if (st.pad) {
      this._pad(t, chord.notes, spb * 4 * 0.96, st.pad);
    }

    if (st.crackle) {
      const n = 5 + ((this._rng() * 5) | 0);
      for (let k = 0; k < n; k++) {
        this._crackle(t + this._rng() * spb * 4, 0.02 + this._rng() * 0.05);
      }
    }
  }

  /* --------------------------------------------------------------- voices */
  _voice({ t, freq, dur, type = 'sine', gain = 0.2, filter = null, attack = 0.004, release = 0.1, send = 0, detune = 0, drive = 0 }) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.detune.value = detune;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + release);
    o.connect(g);
    let out = g;
    if (drive) {
      const sh = ctx.createWaveShaper();
      const k = drive;
      const curve = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) {
        const x = (i / 1023) * 2 - 1;
        curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
      }
      sh.curve = curve;
      g.connect(sh);
      out = sh;
    }
    if (filter) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = filter;
      f.Q.value = 1.1;
      out.connect(f);
      out = f;
    }
    out.connect(this.bus);
    if (send && this.send) {
      const s = ctx.createGain();
      s.gain.value = send;
      out.connect(s).connect(this.send);
    }
    o.start(t);
    o.stop(t + dur + release + 0.15);
  }

  _pad(t, notes, dur, cfg) {
    for (const n of notes) {
      for (const det of [-7, 7]) {
        this._voice({
          t, freq: mtof(n), dur, type: cfg.type, gain: cfg.gain / notes.length,
          filter: cfg.filter, attack: dur * 0.3, release: dur * 0.35, detune: det, send: 0.25,
        });
      }
    }
  }

  _kick(t, gain) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.11);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g).connect(this.bus);
    o.start(t); o.stop(t + 0.35);
  }

  _noiseSource() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    return src;
  }

  _snare(t, gain) {
    const ctx = this.ctx;
    const src = this._noiseSource();
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 1900; f.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    src.connect(f).connect(g).connect(this.bus);
    src.start(t); src.stop(t + 0.2);
  }

  _hat(t, gain, open) {
    const ctx = this.ctx;
    const src = this._noiseSource();
    const f = ctx.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = 7600;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (open ? 0.24 : 0.05));
    src.connect(f).connect(g).connect(this.bus);
    src.start(t); src.stop(t + (open ? 0.3 : 0.09));
  }

  _crackle(t, gain) {
    const ctx = this.ctx;
    const src = this._noiseSource();
    const f = ctx.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = 3200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    src.connect(f).connect(g).connect(this.bus);
    src.start(t); src.stop(t + 0.05);
  }
}

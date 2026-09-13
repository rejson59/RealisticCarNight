/**
 * Fully procedural game audio — no assets.
 *   engine (2 osc + sub) → engineBus ─┐
 *   wind / skid / rain  → engineBus ──┼→ master → speakers
 *   radio (Radio.js)    → radioBus  ──┤
 *   sfx (horn, thud, ring, combo)     ─┘
 * `engineBus` is the "silnik i otoczenie" slider, `radioBus` the radio slider,
 * `master` the master slider and the M mute.
 */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.started = false;
    this.volumes = { master: 0.8, engine: 0.8, radio: 0.45 };
    this.rain = 0;
  }

  start() {
    if (this.started) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 5;
    comp.attack.value = 0.004;
    comp.release.value = 0.22;
    this.master.connect(comp).connect(ctx.destination);

    this.engineBus = ctx.createGain();
    this.engineBus.gain.value = this.volumes.engine;
    this.engineBus.connect(this.master);

    this.radioBus = ctx.createGain();
    this.radioBus.gain.value = this.volumes.radio;
    this.radioBus.connect(this.master);

    // engine: two detuned oscillators + sub through a resonant lowpass
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 700;
    this.engineFilter.Q.value = 3;
    this.osc1 = ctx.createOscillator(); this.osc1.type = 'sawtooth';
    this.osc2 = ctx.createOscillator(); this.osc2.type = 'square'; this.osc2.detune.value = 12;
    this.sub = ctx.createOscillator(); this.sub.type = 'sine';
    const g1 = ctx.createGain(); g1.gain.value = 0.5;
    const g2 = ctx.createGain(); g2.gain.value = 0.22;
    const g3 = ctx.createGain(); g3.gain.value = 0.5;
    this.osc1.connect(g1).connect(this.engineFilter);
    this.osc2.connect(g2).connect(this.engineFilter);
    this.sub.connect(g3).connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain).connect(this.engineBus);

    // shared noise buffer for wind / skid / rain / sfx
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    const noise = (filterType, freq, q) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf; src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = filterType; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(f).connect(g).connect(this.engineBus);
      src.start();
      return { src, f, g };
    };
    this.wind = noise('bandpass', 500, 0.6);
    this.skid = noise('highpass', 900, 0.7);
    this.rainN = noise('lowpass', 1100, 0.4);
    this.rainN.src.loop = true;

    this.osc1.start(); this.osc2.start(); this.sub.start();
    this.started = true;
    this.setMuted(this.muted);
  }

  setMuted(m) {
    this.muted = m;
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.master.gain.setTargetAtTime(m ? 0 : this.volumes.master, this.ctx.currentTime, 0.15);
  }

  /** sliders: {master, engine, radio} each 0..1 */
  setVolumes(v) {
    Object.assign(this.volumes, v);
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (v.master !== undefined) this.master.gain.setTargetAtTime(this.muted ? 0 : v.master, t, 0.12);
    if (v.engine !== undefined) this.engineBus.gain.setTargetAtTime(v.engine, t, 0.12);
    if (v.radio !== undefined) this.radioBus.gain.setTargetAtTime(v.radio, t, 0.12);
  }

  get radioDest() { return this.radioBus; }

  /** parked / paused: engine idles down, wind dies out */
  setIdle(on) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.engineGain.gain.setTargetAtTime(on ? 0.09 : this._lastEngine || 0.16, t, 0.25);
    this.wind.g.gain.setTargetAtTime(on ? 0 : this._lastWind || 0, t, 0.3);
  }

  /** 0..1 rain intensity -> gentle broadband drizzle */
  setRain(amount) {
    this.rain = amount;
    if (!this.ctx) return;
    this.rainN.g.gain.setTargetAtTime(amount * 0.16, this.ctx.currentTime, 0.6);
    this.rainN.f.frequency.setTargetAtTime(900 + amount * 500, this.ctx.currentTime, 0.6);
  }

  /* --------------------------------------------------------------- sfx */
  _noise(t, dur, type, freq, q, gain, dest) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(dest || this.master);
    src.start(t); src.stop(t + dur + 0.05);
  }

  /** metal-on-metal thud for collisions, scaled 0..1 */
  thud(intensity) {
    if (!this.ctx || intensity <= 0.02) return;
    const t = this.ctx.currentTime;
    const k = Math.min(1, intensity);
    this._noise(t, 0.22, 'lowpass', 420 + k * 300, 0.8, 0.5 * k);
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.18);
    g.gain.setValueAtTime(0.6 * k, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + 0.35);
  }

  /** two-tone city horn */
  horn() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const f of [392, 494]) {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'square';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.14, t + 0.02);
      g.gain.setValueAtTime(0.14, t + 0.32);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 2200;
      o.connect(g).connect(lp).connect(this.master);
      o.start(t); o.stop(t + 0.55);
    }
  }

  /** neon ring pickup — sparkle that climbs with the combo */
  ring(combo = 1) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const base = 880 * Math.pow(2, Math.min(6, combo - 1) / 12);
    [0, 4, 7].forEach((semi, i) => {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = base * Math.pow(2, semi / 12);
      const t0 = t + i * 0.055;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(0.16, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.4);
      o.connect(g).connect(this.master);
      o.start(t0); o.stop(t0 + 0.45);
    });
    this._noise(t, 0.3, 'highpass', 5200, 0.8, 0.08);
  }

  /** drift milestone */
  drift(level) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(180 + level * 40, t);
    o.frequency.exponentialRampToValueAtTime(420 + level * 60, t + 0.16);
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 1400; f.Q.value = 2;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.12, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g).connect(f).connect(this.master);
    o.start(t); o.stop(t + 0.35);
  }

  /** engine / wind / skid follow the car every frame */
  update(car, input, dt) {
    if (!this.started || !this.ctx) return;
    const t = this.ctx.currentTime;
    const kmh = car.speedKmh;
    const gear = Math.min(5, Math.floor(kmh / 30));
    const inGear = (kmh - gear * 30) / 30;
    const rpm = 55 + inGear * 95 + input.throttle * 25 + (car.vf < 0 ? 30 : 0);
    this.osc1.frequency.setTargetAtTime(rpm, t, 0.08);
    this.osc2.frequency.setTargetAtTime(rpm * 0.5, t, 0.08);
    this.sub.frequency.setTargetAtTime(rpm * 0.25, t, 0.1);
    this.engineFilter.frequency.setTargetAtTime(350 + rpm * 9 + input.throttle * 500, t, 0.1);
    this._lastEngine = 0.16 + input.throttle * 0.1 + Math.min(0.12, kmh * 0.001);
    this._lastWind = Math.min(0.22, Math.pow(kmh / 220, 1.6) * 0.3);
    this.engineGain.gain.setTargetAtTime(this._lastEngine, t, 0.12);
    this.wind.g.gain.setTargetAtTime(this._lastWind, t, 0.2);
    this.wind.f.frequency.setTargetAtTime(400 + kmh * 8, t, 0.2);
    const skidding = (input.handbrake && kmh > 25) || Math.abs(car.vl) > 5;
    this.skid.g.gain.setTargetAtTime(skidding ? 0.05 + Math.min(0.1, Math.abs(car.vl) * 0.012) : 0, t, 0.06);
    void dt;
  }
}

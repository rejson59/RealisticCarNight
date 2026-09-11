/** Fully procedural engine / wind / skid audio — no assets needed. */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.started = false;
  }

  start() {
    if (this.started) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.0;
    this.master.connect(ctx.destination);

    // engine: two detuned oscillators through a lowpass
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0.0;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 700;
    this.engineFilter.Q.value = 3;
    this.osc1 = ctx.createOscillator();
    this.osc1.type = 'sawtooth';
    this.osc2 = ctx.createOscillator();
    this.osc2.type = 'square';
    this.osc2.detune.value = 12;
    this.sub = ctx.createOscillator();
    this.sub.type = 'sine';
    const g1 = ctx.createGain(); g1.gain.value = 0.5;
    const g2 = ctx.createGain(); g2.gain.value = 0.22;
    const g3 = ctx.createGain(); g3.gain.value = 0.5;
    this.osc1.connect(g1).connect(this.engineFilter);
    this.osc2.connect(g2).connect(this.engineFilter);
    this.sub.connect(g3).connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain).connect(this.master);

    // wind + skid: looped noise
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = ctx.createBufferSource();
    this.noise.buffer = buf;
    this.noise.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 500;
    this.windFilter.Q.value = 0.6;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.noise.connect(this.windFilter).connect(this.windGain).connect(this.master);

    this.noise2 = ctx.createBufferSource();
    this.noise2.buffer = buf;
    this.noise2.loop = true;
    this.skidFilter = ctx.createBiquadFilter();
    this.skidFilter.type = 'highpass';
    this.skidFilter.frequency.value = 900;
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    this.noise2.connect(this.skidFilter).connect(this.skidGain).connect(this.master);

    this.osc1.start(); this.osc2.start(); this.sub.start();
    this.noise.start(); this.noise2.start();
    this.started = true;
    this.setMuted(this.muted);
  }

  setMuted(m) {
    this.muted = m;
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.master.gain.setTargetAtTime(m ? 0 : 0.5, this.ctx.currentTime, 0.15);
  }

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
    this.engineGain.gain.setTargetAtTime(0.16 + input.throttle * 0.1 + Math.min(0.12, kmh * 0.001), t, 0.12);
    this.windGain.gain.setTargetAtTime(Math.min(0.22, Math.pow(kmh / 220, 1.6) * 0.3), t, 0.2);
    this.windFilter.frequency.setTargetAtTime(400 + kmh * 8, t, 0.2);
    const skidding = (input.handbrake && kmh > 25) || Math.abs(car.vl) > 5;
    this.skidGain.gain.setTargetAtTime(skidding ? 0.12 : 0, t, 0.06);
    void dt;
  }
}

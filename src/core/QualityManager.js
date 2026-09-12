export const TIER_NAMES = ['NISKA', 'ŚREDNIA', 'WYSOKA', 'ULTRA'];

export const TIER_SETTINGS = [
  { // 0 LOW — weak phones
    pixelRatio: 0.8, bloom: 0.65, bloomScale: 0.25, msaa: 0, traffic: 4,
    env: 0.35, shadows: false, vignette: false,
  },
  { // 1 MEDIUM
    pixelRatio: 1.2, bloom: 0.8, bloomScale: 0.35, msaa: 0, traffic: 7,
    env: 0.45, shadows: false, vignette: true,
  },
  { // 2 HIGH
    pixelRatio: 1.6, bloom: 0.95, bloomScale: 0.5, msaa: 4, traffic: 12,
    env: 0.6, shadows: true, vignette: true,
  },
  { // 3 ULTRA
    pixelRatio: 2.0, bloom: 1.05, bloomScale: 0.6, msaa: 4, traffic: 16,
    env: 0.75, shadows: true, vignette: true,
  },
];

/** Device guess + FPS-driven hysteresis so weak phones never melt. */
export class QualityManager {
  constructor() {
    this.tier = QualityManager.detect();
    this.resScale = 1;
    this.auto = true;
    this.samples = [];
    this.window = 0;
    this.cooldown = 6;
    this.goodStreak = 0;
    this.history = [];
  }

  static detect() {
    const ua = navigator.userAgent;
    const mobile = /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(ua)
      || (navigator.maxTouchPoints > 0 && Math.min(screen.width, screen.height) < 900);
    const cores = navigator.hardwareConcurrency || 4;
    const mem = navigator.deviceMemory || 4;
    if (!mobile) return cores >= 8 ? 2 : 1;
    if (cores >= 8 && mem >= 6) return 2;
    if (cores >= 6) return 1;
    return mem <= 2 ? 0 : 1;
  }

  /** manual cycle: AUTO -> NISKA -> ŚREDNIA -> WYSOKA -> ULTRA -> AUTO */
  cycle() {
    if (this.auto) {
      this.auto = false;
      this.tier = 0;
    } else if (this.tier < 3) {
      this.tier += 1;
    } else {
      this.auto = true;
    }
    this.cooldown = 6;
    this.goodStreak = 0;
    return { tier: this.tier, auto: this.auto, changed: true };
  }

  push(dt) {
    if (!this.auto) return null;
    this.cooldown -= dt;
    this.samples.push(dt);
    this.window += dt;
    if (this.window < 1.6) return null;
    const n = this.samples.length;
    let avg = 0;
    for (const s of this.samples) avg += s;
    avg /= n;
    this.samples.length = 0;
    this.window = 0;
    const fps = 1 / avg;
    this.history.push(fps);
    if (this.history.length > 40) this.history.shift();
    if (this.cooldown > 0) return null;

    if (fps < 44) {
      if (this.tier > 0) {
        this.tier -= 1;
        this.cooldown = 6;
        this.goodStreak = 0;
        return { tier: this.tier, auto: true, changed: true, reason: 'fps' };
      }
      if (this.resScale > 0.72) {
        this.resScale = 0.72; // dynamic resolution rescue for very weak GPUs
        this.cooldown = 6;
        return { tier: this.tier, auto: true, changed: true, reason: 'res' };
      }
    }
    if (fps > 56 && this.resScale < 1) {
      this.resScale = 1;
      this.cooldown = 6;
      return { tier: this.tier, auto: true, changed: true, reason: 'res' };
    }
    if (fps > 56) this.goodStreak += 1;
    else this.goodStreak = 0;
    if (this.goodStreak >= 4 && this.tier < 3) {
      this.tier += 1;
      this.cooldown = 10;
      this.goodStreak = 0;
      return { tier: this.tier, auto: true, changed: true, reason: 'fps' };
    }
    return null;
  }

  label() {
    return `${this.auto ? 'AUTO' : 'RĘCZNIE'} • ${TIER_NAMES[this.tier]}`;
  }
}

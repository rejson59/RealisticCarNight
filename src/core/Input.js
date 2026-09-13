/** Unified keyboard + touch input. */
export class Input {
  constructor(actions = {}) {
    this.state = { throttle: 0, brake: 0, left: false, right: false, handbrake: false };
    this.keys = new Set();
    this.touch = { throttle: 0, brake: 0, left: false, right: false, handbrake: false };
    this.actions = actions;

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      // don't hijack keys while the user is in a menu control (sliders, pickers)
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      this.keys.add(e.code);
      switch (e.code) {
        case 'KeyC': actions.camera?.(); break;
        case 'KeyM': actions.mute?.(); break;
        case 'KeyR': actions.reset?.(); break;
        case 'KeyH': actions.help?.(); break;
        case 'KeyQ': actions.quality?.(); break;
        case 'KeyT': actions.auto?.(); break;
        case 'KeyF': actions.photo?.(); break;
        case 'KeyP': actions.capture?.(); break;
        case 'KeyE': actions.horn?.(); break;
        case 'KeyN': actions.radioNext?.(); break;
        case 'KeyG': actions.perf?.(); break;
        case 'KeyO': actions.menu?.(); break;
        case 'Escape': actions.escape?.(); break;
        default: break;
      }
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    this._bindTouch();
  }

  _hold(id, on, off) {
    const el = document.getElementById(id);
    if (!el) return;
    const start = (e) => { e.preventDefault(); el.classList.add('active'); on(); };
    const end = (e) => { e.preventDefault?.(); el.classList.remove('active'); off(); };
    el.addEventListener('pointerdown', start);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', end);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _bindTouch() {
    this._hold('btn-gas', () => { this.touch.throttle = 1; }, () => { this.touch.throttle = 0; });
    this._hold('btn-brake', () => { this.touch.brake = 1; }, () => { this.touch.brake = 0; });
    this._hold('btn-left', () => { this.touch.left = true; }, () => { this.touch.left = false; });
    this._hold('btn-right', () => { this.touch.right = true; }, () => { this.touch.right = false; });
    this._hold('btn-hand', () => { this.touch.handbrake = true; }, () => { this.touch.handbrake = false; });
    const tap = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', (e) => { e.preventDefault(); fn(); });
    };
    tap('btn-cam', () => this.actions.camera?.());
    tap('btn-sound', () => this.actions.mute?.());
    tap('btn-help', () => this.actions.help?.());
    tap('btn-quality', () => this.actions.quality?.());
    tap('btn-auto', () => this.actions.auto?.());
  }

  get isTouch() {
    return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  }

  read() {
    const k = this.keys;
    const s = this.state;
    const kThrottle = k.has('KeyW') || k.has('ArrowUp') ? 1 : 0;
    const kBrake = k.has('KeyS') || k.has('ArrowDown') ? 1 : 0;
    s.throttle = Math.max(kThrottle, this.touch.throttle);
    s.brake = Math.max(kBrake, this.touch.brake);
    s.left = k.has('KeyA') || k.has('ArrowLeft') || this.touch.left;
    s.right = k.has('KeyD') || k.has('ArrowRight') || this.touch.right;
    s.handbrake = k.has('Space') || this.touch.handbrake;
    return s;
  }
}

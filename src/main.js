import * as THREE from 'three';

import { City } from './world/City.js';
import { Car } from './world/Car.js';
import { Traffic } from './world/Traffic.js';
import { Collectibles } from './world/Collectibles.js';
import { Input } from './core/Input.js';
import { AudioEngine } from './core/AudioEngine.js';
import { Radio, STATIONS } from './core/Radio.js';
import { QualityManager, TIER_SETTINGS, TIER_NAMES } from './core/QualityManager.js';
import { Autopilot } from './core/Autopilot.js';
import { Settings, Records, PAINTS } from './core/Settings.js';
import { HUD } from './ui/HUD.js';
import { Menu } from './ui/Menu.js';
import { Pipeline } from './render/Pipeline.js';
import { CameraRig, CAM_NAMES } from './render/CameraRig.js';
import { mulberry32 as mulberry } from './core/utils.js';

const hex = (s) => parseInt(String(s).replace('#', ''), 16);
const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

class Game {
  constructor() {
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setClearColor(0x05070d, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // OutputPass reads the exposure every frame; the stored user value is
    // applied by _applySettings('*') once the Settings store exists.
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // shadows update once per frame (the wet-mirror pass must not re-render them)
    this.renderer.shadowMap.autoUpdate = false;
    document.getElementById('app').appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.3, 3200);
    this.camera.position.set(0, 4, 70);

    this.settings = new Settings();
    this.records = new Records();
    this.quality = new QualityManager();
    this.hud = new HUD();
    this.audio = new AudioEngine();
    this.radio = new Radio();
    this.camRig = new CameraRig(this.camera);
    this.autopilot = new Autopilot();
    this.pipe = new Pipeline(this.renderer, this.scene, this.camera);
    this._blur = 0;

    this.started = false;
    this.time = 0;
    this.frame = 0;
    this.perfOn = false;
    this.session = { distance: 0, time: 0, topSpeed: 0, score: 0, rings: 0, drift: 0 };
    this._driftShown = 0;
    this._saved = false;
  }

  async boot() {
    const status = document.getElementById('loadStatus');
    const bar = document.getElementById('loadBar');
    const step = async (label, pct, fn) => {
      status.textContent = label;
      bar.style.width = `${pct}%`;
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 16)));
      fn();
    };

    await step('Generowanie nocnego miasta…', 25, () => {
      this.city = new City(this.scene, this.renderer);
    });
    await step('Budowanie samochodu…', 50, () => {
      this.car = new Car(this.scene);
      this.traffic = new Traffic(this.scene, this.city);
      // traffic acts as a soft collider for the player
      this.city.dynamicColliders = this.traffic.colliders;
    });
    await step('Neonowe pierścienie…', 62, () => {
      this.collectibles = new Collectibles(this.scene, this.city, 24);
      this.collectibles.onCollect = (points, combo) => this._onRing(points, combo);
    });
    await step('Odbicia i oświetlenie…', 78, () => {
      // bake environment IBL from the city (reflections off during bake)
      this.city.reflection.enabled = false;
      this.city.reflection.visible = false;
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this.envRT = pmrem.fromScene(this.scene, 0, 0.5, 2600);
      this.scene.environment = this.envRT.texture;
      pmrem.dispose();
    });
    await step('Lakier i odbicia auta…', 88, () => {
      // dedicated "night city studio" env for the car paint: dark dome with
      // bright neon strips => clean lacquer with colourful streak reflections
      const envScene = new THREE.Scene();
      const dome = new THREE.Mesh(
        new THREE.SphereGeometry(120, 24, 12),
        new THREE.ShaderMaterial({
          side: THREE.BackSide,
          vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
          fragmentShader: `varying vec3 vD;
            void main(){
              vec3 c = mix(vec3(0.020,0.028,0.045), vec3(0.004,0.006,0.012), smoothstep(0.0,0.4,vD.y));
              c += vec3(0.10,0.06,0.03) * pow(max(0.0,1.0-abs(vD.y)*4.0),2.0);
              gl_FragColor = vec4(c,1.0);
            }`,
        })
      );
      envScene.add(dome);
      const palette = [0xffb46b, 0x28d7fe, 0xff2d78, 0x9fffe0, 0xffe9c4, 0x7a8cff];
      const rr = mulberry(9182);
      for (let k = 0; k < 18; k++) {
        const m = new THREE.Mesh(
          new THREE.PlaneGeometry(26 + rr() * 30, 3 + rr() * 7),
          new THREE.MeshBasicMaterial({ color: new THREE.Color().setHex(palette[k % palette.length]).multiplyScalar(2.6) })
        );
        const a = rr() * Math.PI * 2;
        const y = -14 + rr() * 60;
        m.position.set(Math.cos(a) * 80, y, Math.sin(a) * 80);
        m.lookAt(0, y * 0.4, 0);
        envScene.add(m);
      }
      const moonP = new THREE.Mesh(new THREE.SphereGeometry(6, 12, 12),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 6, 6.5) }));
      moonP.position.set(40, 80, -60);
      envScene.add(moonP);
      const pmrem2 = new THREE.PMREMGenerator(this.renderer);
      // sigma <= 0.04: bigger values exceed PMREM's 20-sample cap and warn on boot
      this.carEnvRT = pmrem2.fromScene(envScene, 0.04, 1, 400);
      pmrem2.dispose();
      this.car.setEnvMaps(this.carEnvRT.texture, 2.6);
      envScene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    });
    await step('Prawie gotowe…', 94, () => {
      // place the chase camera behind the car before the first frame
      const fx = Math.sin(this.car.heading), fz = Math.cos(this.car.heading);
      this.camRig.pos.set(this.car.pos.x - fx * 8, 3.0, this.car.pos.z - fz * 8);
      this.camRig.look.set(this.car.pos.x + fx * 6, 1.2, this.car.pos.z + fz * 6);

      this.input = new Input({
        camera: () => this.toggleCamera(),
        mute: () => this.toggleMute(),
        reset: () => this.resetCar(),
        help: () => this.toggleHelp(),
        quality: () => this.cycleQuality(),
        auto: () => this.toggleAutopilot(),
        photo: () => this.togglePhoto(),
        capture: () => this.capturePhoto(),
        horn: () => this.honk(),
        radioNext: () => this.nextStation(),
        perf: () => this.togglePerf(),
        menu: () => this.toggleMenu(),
        escape: () => this.escape(),
      });
      this.menu = new Menu({
        settings: this.settings,
        records: this.records,
        stations: STATIONS,
        session: () => this.session,
        stats: () => this.pipe.stats,
        onApply: (key) => this._applySettings(key),
      });
      this.radio.onStation = (name) => {
        this.hud.setRadio(name, this.settings.get('radioOn'));
        if (this.started && this.settings.get('radioOn')) this.hud.toast(`📻 ${name}`, 2400);
      };
      this._buildStartScreen();
      // dynamic objects feed the motion-vector buffer used by TAA
      this.pipe.registerDynamic(this.car.group);
      this._applySettings('*');
      this.hud.buildStaticMap(this.city);
      this._bindUI();
      this._resize();
      window.addEventListener('resize', () => this._resize());
      this._bindPhotoControls();
      this._bindLifecycle();
    });
    await step('Gotowe!', 100, () => {
      this.clock = new THREE.Clock();
      document.getElementById('loading').classList.add('done');
      document.getElementById('start').classList.remove('hidden');
      if (this.input.isTouch) document.getElementById('touch').classList.add('visible');
      else if (this.settings.get('hints')) this.hud.setHints(true);
      this._loop();
    });
  }

  /* ------------------------------------------------------------- start */
  _buildStartScreen() {
    const wrap = document.getElementById('startPaint');
    if (wrap) {
      wrap.textContent = '';
      for (const p of PAINTS) {
        const b = document.createElement('button');
        b.className = 'paint-dot';
        b.title = p.name;
        b.style.background = `linear-gradient(140deg, ${p.hex}, ${p.hex} 55%, rgba(255,255,255,.25))`;
        if (p.hex === this.settings.get('paint')) b.classList.add('active');
        b.addEventListener('click', () => {
          this.settings.set('paint', p.hex);
          this.car.setPaint(hex(p.hex));
          for (const sib of wrap.children) sib.classList.toggle('active', sib === b);
        });
        wrap.appendChild(b);
      }
    }
    const rec = document.getElementById('startRecords');
    if (rec) {
      const r = this.records.data;
      if (r.score > 0 || r.distance > 500) {
        rec.textContent = `Twoje rekordy: ${Math.round(r.score)} pkt • ${Math.round(r.rings)} pierścieni • ${(r.distance / 1000).toFixed(1)} km • ${Math.round(r.topSpeed)} km/h`;
      } else {
        rec.textContent = 'Pierwsza jazda? Zbieraj neonowe pierścienie i śrubuj rekordy.';
      }
    }
  }

  _bindUI() {
    document.getElementById('startBtn').addEventListener('click', () => {
      document.getElementById('start').classList.add('hidden');
      this.started = true;
      this.audio.start();
      this.audio.setMuted(false);
      this.audio.setVolumes({
        master: this.settings.get('master'),
        engine: this.settings.get('engine'),
        radio: this.settings.get('radio'),
      });
      this.radio.attach(this.audio.ctx, this.audio.radioDest);
      this.radio.setVolume(this.settings.get('radio'));
      this.radio.setEnabled(this.settings.get('radioOn'));
      this.audio.setRain(this.city.rainOn ? 0.8 : 0);
      this.hud.show();
      if (this.settings.get('firstRun')) {
        this.settings.set('firstRun', false);
        this.hud.toast('Miłej jazdy 🌃  H — pomoc, O — garaż, T — autopilot', 5200);
      } else {
        this.hud.toast('Miłej jazdy 🌃  (H — pomoc)');
      }
      // celebrate records beaten in the previous session
      try {
        const beaten = JSON.parse(localStorage.getItem('rcn.beaten') || 'null');
        if (beaten && beaten.length) this.hud.toast(`🏆 Nowe rekordy: ${beaten.join(', ')}`, 4200);
        localStorage.removeItem('rcn.beaten');
      } catch { /* ignore */ }
    });
    document.getElementById('startGarage')?.addEventListener('click', () => this.toggleMenu(true));
    document.getElementById('helpClose').addEventListener('click', () => this.toggleHelp(false));
    document.getElementById('btn-cam')?.addEventListener('click', () => this.toggleCamera());
    document.getElementById('btn-photo')?.addEventListener('click', () => this.togglePhoto());
    document.getElementById('btn-sound')?.addEventListener('click', () => this.toggleMute());
    document.getElementById('btn-radio')?.addEventListener('click', () => this.nextStation());
    document.getElementById('btn-auto')?.addEventListener('click', () => this.toggleAutopilot());
    document.getElementById('btn-settings')?.addEventListener('click', () => this.toggleMenu());
    document.getElementById('btn-help')?.addEventListener('click', () => this.toggleHelp());
  }

  /** photo mode: drag to orbit, wheel/pinch to zoom */
  _bindPhotoControls() {
    const dom = this.renderer.domElement;
    let dragging = false;
    let px = 0, py = 0;
    dom.addEventListener('pointerdown', (e) => {
      if (!this.camRig.photo.active) return;
      dragging = true; px = e.clientX; py = e.clientY;
      dom.setPointerCapture?.(e.pointerId);
    });
    dom.addEventListener('pointermove', (e) => {
      if (!dragging || !this.camRig.photo.active) return;
      this.camRig.photoDrag(e.clientX - px, e.clientY - py);
      px = e.clientX; py = e.clientY;
    });
    const up = () => { dragging = false; };
    dom.addEventListener('pointerup', up);
    dom.addEventListener('pointercancel', up);
    dom.addEventListener('wheel', (e) => {
      if (!this.camRig.photo.active) return;
      e.preventDefault();
      this.camRig.photoZoom(e.deltaY);
    }, { passive: false });
  }

  _bindLifecycle() {
    const save = () => {
      if (this._saved) return;
      this._saved = true;
      const beaten = this.records.submit(this.session);
      if (beaten.length) {
        try { localStorage.setItem('rcn.beaten', JSON.stringify(beaten)); } catch { /* ignore */ }
      }
    };
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        save();
        this.audio.ctx?.suspend?.();
      } else {
        this.audio.ctx?.resume?.();
      }
    });
    // offline shell (production build only)
    if ('serviceWorker' in navigator && import.meta.env?.PROD) {
      // BASE_URL-aware: '/sw.js' would 404 on a GitHub Pages subpath
      const swUrl = `${import.meta.env.BASE_URL}sw.js`;
      navigator.serviceWorker.register(swUrl).catch(() => {});
    }
  }

  /* ----------------------------------------------------------- toggles */
  _paused() {
    return (this.menu && this.menu.isOpen) || !document.getElementById('help').classList.contains('hidden');
  }

  escape() {
    if (this.menu?.isOpen) this.toggleMenu(false);
    else if (!document.getElementById('help').classList.contains('hidden')) this.toggleHelp(false);
    else if (this.camRig.photo.active) this.togglePhoto(false);
  }

  toggleMenu(force) {
    if (!this.menu) return;
    const show = force !== undefined ? force : !this.menu.isOpen;
    if (show) this.menu.open();
    else this.menu.close();
    if (this.started) this.audio.setIdle(show);
  }

  toggleHelp(force) {
    const el = document.getElementById('help');
    const show = force !== undefined ? force : el.classList.contains('hidden');
    el.classList.toggle('hidden', !show);
    if (this.started) this.audio.setIdle(show);
  }

  toggleAutopilot(force) {
    const on = force !== undefined ? force : !this.autopilot.enabled;
    this.autopilot.enabled = on;
    if (on) this.autopilot.snap(this.car, this.city);
    document.getElementById('apBadge').classList.toggle('off', !on);
    this.hud.toast(on ? '🤖 Autopilot włączony — dowolny klawisz jazdy przejmuje kontrolę' : 'Autopilot wyłączony');
  }

  toggleCamera() {
    const m = this.camRig.cycle();
    this.settings.set('camera', m);
    this.hud.toast(CAM_NAMES[m]);
  }

  togglePhoto(force) {
    const on = force !== undefined ? force : !this.camRig.photo.active;
    this.camRig.setPhoto(on);
    this.pipe.setPhoto(on);
    // photo mode always renders at full internal resolution (screenshots)
    this.pipe.configure(this.quality.tier, this._pipeOpts());
    document.getElementById('photoBar').classList.toggle('off', !on);
    document.getElementById('hud').classList.toggle('photo', on);
    this.hud.toast(on
      ? '📷 Tryb foto: przeciągnij myszą/palcem, kółko = zoom, P = zapis PNG'
      : 'Koniec trybu foto');
  }

  toggleMute() {
    this.audio.setMuted(!this.audio.muted);
    document.getElementById('btn-sound').textContent = this.audio.muted ? '🔇' : '🔊';
    this.hud.toast(this.audio.muted ? 'Dźwięk wyciszony' : 'Dźwięk włączony');
  }

  honk() { this.audio.horn(); }

  nextStation() {
    if (!this.settings.get('radioOn')) {
      this.settings.set('radioOn', true);
      this._applySettings('radioOn');
    }
    this.settings.set('station', (this.settings.get('station') + 1) % STATIONS.length);
    this._applySettings('station');
  }

  togglePerf(force) {
    this.perfOn = force !== undefined ? force : !this.perfOn;
    this.settings.set('perf', this.perfOn);
    if (!this.perfOn) this.hud.setPerf('', false);
  }

  cycleQuality() {
    const res = this.quality.cycle();
    this.settings.set('quality', this.quality.auto ? 'auto' : this.quality.tier);
    this.applyTier(res.tier);
    this.hud.toast(this.quality.auto
      ? 'Auto-jakość: WŁĄCZONA'
      : `Jakość ustawiona ręcznie: ${TIER_NAMES[res.tier]}`);
    this.hud.setTier(this.quality.label());
  }

  resetCar() {
    const lines = this.city.roadLines;
    const nx = lines.reduce((a, b) => (Math.abs(b - this.car.pos.x) < Math.abs(a - this.car.pos.x) ? b : a));
    const nz = lines.reduce((a, b) => (Math.abs(b - this.car.pos.z) < Math.abs(a - this.car.pos.z) ? b : a));
    this.car.pos.set(nx, 0, nz);
    this.car.reset();
    this.car.heading = 0;
    this.hud.toast('Samochód ustawiony na środku skrzyżowania');
  }

  capturePhoto() {
    try {
      // a still capture must not be temporally blended with the previous frame
      this.pipe.resetHistory();
      this.pipe.render();
      const url = this.renderer.domElement.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = `realistic-car-night-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      this.hud.toast('💾 Zapisano zrzut ekranu (PNG)');
    } catch (err) {
      this.hud.toast(`Nie udało się zapisać: ${err.message}`);
    }
  }

  _onRing(points, combo) {
    this.audio.ring(combo - 1);
    this.session.rings += 1;
    const box = document.getElementById('scoreBox');
    box?.classList.remove('pop');
    void box?.offsetWidth;
    box?.classList.add('pop');
    if (combo > 1) this.hud.toast(`+${points} pkt — combo ×${combo}!`, 1400);
  }

  /* ---------------------------------------------------------- settings */
  _applySettings(changed = '*') {
    const d = this.settings.data;
    const all = changed === '*';
    const reTier = () => this.applyTier(this.quality.tier, true);

    if (all || changed === 'paint') this.car.setPaint(hex(d.paint));
    if (all || changed === 'glow') this.car.setUnderglow(d.glow);
    if (all || changed === 'headlights') this.car.setHeadlightColor(hex(d.headlights));
    if (all || changed === 'camera') this.camRig.setMode(d.camera);
    if (all || changed === 'fov') this.camRig.fovOffset = d.fov;
    if (all || changed === 'minimapRotate') this.hud.setRotate(d.minimapRotate);
    if (all || changed === 'hints') this.hud.setHints(!!d.hints && !this.input?.isTouch);
    if (all || changed === 'perf') this.perfOn = !!d.perf;
    if (all || changed === 'objectives') this.collectibles?.setEnabled(!!d.objectives);

    if (all || changed === 'quality') {
      const res = this.quality.setMode(d.quality);
      this.applyTier(res.tier, true);
      this.hud.setTier(this.quality.label());
    }
    if (all || changed === 'traffic' || changed === 'rain' || changed === 'reflections') reTier();
    if (all || changed === 'upscale' || changed === 'ao' || changed === 'dof' || changed === 'lut') {
      this.pipe.configure(this.quality.tier, this._pipeOpts());
    }
    if (all || changed === 'exposure') this.renderer.toneMappingExposure = d.exposure;
    if (all || changed === 'shadowMode') this._applyShadowMode(d.shadowMode);

    if (all || changed === 'master' || changed === 'engine' || changed === 'radio') {
      this.audio.setVolumes({ master: d.master, engine: d.engine, radio: d.radio });
      this.radio.setVolume(d.radio);
    }
    if (all || changed === 'radioOn') {
      this.radio.setEnabled(!!d.radioOn && this.started);
      this.hud.setRadio(this.radio.name, !!d.radioOn && this.started);
    }
    if (all || changed === 'station') {
      this.radio.setStation(d.station);
      if (d.radioOn && this.started) this.hud.setRadio(this.radio.name, true);
    }
  }

  /* -------------------------------------------------------------- tiers */
  applyTier(tier, first = false) {
    const s = TIER_SETTINGS[tier];
    const d = this.settings.data;
    const dpr = Math.min(window.devicePixelRatio || 1, s.pixelRatio) * (this.quality.resScale || 1);
    this.renderer.setPixelRatio(dpr);
    this.renderer.shadowMap.enabled = s.shadows;
    this.city.setQuality(tier, d.reflections);
    const rainOn = this.city.rainOn;
    this.car.setWet(rainOn);
    this.audio.setRain(rainOn ? 0.8 : 0);
    this.traffic.setCount(Math.round(s.traffic * d.traffic));
    this.scene.environmentIntensity = s.env;
    // the tier also changes devicePixelRatio, so the pipeline has to re-size its
    // buffers with it BEFORE the new profile is applied — otherwise the internal
    // render targets keep the previous dpr and no longer match the canvas
    this.pipe.setSize(innerWidth, innerHeight, dpr);
    this.pipe.configure(tier, this._pipeOpts());
    this._applyShadowMode(d.shadowMode);
    this._registerDynamic();
    this.hud.setTier(this.quality.label());
    if (!first) this.hud.toast(`Auto-dostosowanie grafiki: ${TIER_NAMES[tier]}`, 2000);
  }

  /** render-pipeline options straight from the settings store */
  _pipeOpts() {
    const d = this.settings.data;
    return {
      taa: d.upscale,
      ao: d.ao,
      dof: d.dof,
      lut: d.lut,
      photo: !!this.camRig?.photo.active,
    };
  }

  /**
   * Traffic cars are pooled and respawned by setCount(), so the motion-vector
   * registry is refreshed whenever the tier or the traffic slider changes.
   * Registration is idempotent — already-known meshes are skipped.
   */
  _registerDynamic() {
    if (!this.traffic) return;
    for (const c of this.traffic.cars) this.pipe.registerDynamic(c.mesh);
    for (const c of this.traffic.pool) this.pipe.registerDynamic(c);
  }

  /**
   * Shadow filtering. PCF Soft is the default (cheap, no bleeding); VSM adds a
   * separable blur for very soft penumbrae at the cost of a float shadow map.
   * Changing the algorithm invalidates the cached map, so it is dropped here.
   */
  _applyShadowMode(mode = 'auto') {
    const tier = this.quality.tier;
    const s = TIER_SETTINGS[tier];
    this.renderer.shadowMap.enabled = s.shadows;
    if (!s.shadows) return;
    const vsm = mode === 'vsm';
    const type = vsm ? THREE.VSMShadowMap : THREE.PCFSoftShadowMap;
    if (this.renderer.shadowMap.type !== type) {
      this.renderer.shadowMap.type = type;
      const moon = this.city?.moonLight;
      if (moon?.shadow.map) {
        moon.shadow.map.dispose();
        moon.shadow.map = null;   // reallocated with the right internal format
      }
    }
    const moon = this.city?.moonLight;
    if (moon) {
      // VSM blurs the map, so it needs a much smaller depth bias and a bit more
      // normal bias to avoid both acne and peter-panning.
      moon.shadow.radius = vsm ? 3.2 : 1;
      moon.shadow.blurSamples = vsm ? 12 : 4;
      moon.shadow.bias = vsm ? -0.00012 : -0.0006;
      moon.shadow.normalBias = vsm ? 0.6 : 0.4;
    }
    this.renderer.shadowMap.needsUpdate = true;
  }

  /* ------------------------------------------------------------- resize */
  _resize() {
    const w = innerWidth, h = innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    const s = TIER_SETTINGS[this.quality.tier];
    const dpr = Math.min(window.devicePixelRatio || 1, s.pixelRatio) * (this.quality.resScale || 1);
    this.pipe.setSize(w, h, dpr);
  }

  /* --------------------------------------------------------------- loop */
  _loop() {
    const tick = () => {
      requestAnimationFrame(tick);
      const rawDt = Math.min(0.05, this.clock.getDelta());
      this.time += rawDt;
      this.frame += 1;

      const paused = this.started && this._paused();
      const dt = paused ? 0 : rawDt;

      let input = this.started && !paused ? this.input.read() : {
        throttle: 0, brake: 0, left: false, right: false, handbrake: false,
      };
      if (this.autopilot.enabled && !paused) {
        const manual = input.throttle || input.brake || input.left || input.right || input.handbrake;
        if (manual) this.toggleAutopilot(false);
        else input = this.autopilot.update(dt, this.car, this.city, this.traffic.positions);
      }

      if (!paused) {
        this.car.update(dt, input, this.city);
        this.traffic.update(dt);
        this.city.update(dt, this.car.pos);
        this.collectibles.update(dt, this.car.pos, this.car);
        this.audio.update(this.car, input, dt);

        // session stats
        const ses = this.session;
        ses.distance += (this.car.speedKmh / 3.6) * dt;
        ses.time += dt;
        ses.topSpeed = Math.max(ses.topSpeed, this.car.speedKmh);
        ses.drift = Math.round(this.collectibles.drift);
        ses.score = this.collectibles.score + ses.drift;

        // impacts: thud + extra camera shake
        if (this.car.impact > 0.12 && this._lastImpact !== this.car.impact) {
          this.audio.thud(this.car.impact);
          this.camRig.shake = Math.min(0.22, this.camRig.shake + this.car.impact * 0.14);
        }
        this._lastImpact = this.car.impact;

        const res = this.quality.push(dt);
        if (res && res.changed) {
          this.settings.set('quality', this.quality.auto ? 'auto' : this.quality.tier);
          this.applyTier(res.tier);
        }
      }

      this.camRig.update(rawDt, this.car);
      // the light cones wash the frame out when the camera sits inside them
      this.car.setConesVisible(this.camRig.photo.active || this.camRig.mode === 0 || this.camRig.mode === 3);

      const kmhNow = this.car.speedKmh;
      const wantBlur = this.quality.tier >= 2 && !this.camRig.photo.active
        ? Math.min(1, Math.max(0, (kmhNow - 80) / 140)) : 0;
      this._blur += (wantBlur - this._blur) * Math.min(1, rawDt * 3);
      this.pipe.setTime(this.time);
      this.pipe.setSpeedBlur(this._blur);

      // HUD (throttled on purpose — canvas 2D costs CPU on phones)
      if (this.frame % 2 === 0) {
        const gear2 = this.car.vf < -0.5 ? 'R'
          : Math.abs(this.car.vf) < 0.4 ? 'N'
            : `D${Math.min(6, 1 + Math.floor(this.car.speedKmh / 34))}`;
        this.hud.drawGauge(this.car.speedKmh, gear2, input.brake > 0 || input.handbrake);
      }
      if (this.frame % 3 === 0) {
        this.hud.drawMinimap(this.car, this.traffic.positions, this.collectibles.positions);
      }
      if (this.frame % 4 === 0) {
        const ses = this.session;
        this.hud.setScore(ses.score, this.collectibles.combo, !!this.settings.get('objectives') && this.started);
        const drifting = this.car.skidAmount > 0.2 && kmhNow > 28;
        this.hud.setDrift(this.collectibles.drift, drifting);
        this.hud.setTrip(ses.distance / 1000, clock(ses.time));
      }
      if (this.perfOn && this.frame % 12 === 0) this._drawPerf();
      this.hud.fps(rawDt);

      // --- frame: jitter + matrices -> draw -> motion snapshot
      this.pipe.beginFrame();
      this.pipe.setFocus(this.camRig.pos.distanceTo(this.car.pos));
      this.renderer.shadowMap.needsUpdate = true;
      this.pipe.render();
      this.pipe.endFrame();
    };
    tick();
  }

  _drawPerf() {
    const info = this.renderer.info;
    const s = TIER_SETTINGS[this.quality.tier];
    const dpr = Math.min(window.devicePixelRatio || 1, s.pixelRatio) * (this.quality.resScale || 1);
    const lines = [
      `${this.hud.lastFps ?? '–'} FPS • ${(1000 / Math.max(1, this.hud.lastFps ?? 60)).toFixed(1)} ms`,
      `draw-calle ${info.render.calls} • trójkąty ${(info.render.triangles / 1000).toFixed(0)}k`,
      `odbicia ${this.city.reflRes}px co ${this.city.reflection.frameInterval} kl.`,
      `dpr ${dpr.toFixed(2)} • auta ${this.traffic.cars.length} • tier ${TIER_NAMES[this.quality.tier]}`,
      `wewnętrzna ${this.pipe.stats.internal?.join('×') ?? '–'} (${Math.round((this.pipe.stats.scale ?? 1) * 100)}%)`
        + ` • ${[this.pipe.stats.taa && 'TAA', this.pipe.stats.velocity && 'MV', this.pipe.stats.ao && 'AO',
          this.pipe.stats.dof && 'DOF'].filter(Boolean).join('+') || 'raster'}`,
      `tekstury ${info.memory.textures} • geometrie ${info.memory.geometries}`,
    ];
    this.hud.setPerf(lines.join('\n'), true);
  }
}

const game = new Game();
// handy for debugging in the browser console (`__game.pipe.stats`) and for tests
window.__game = game;
game.boot().catch((err) => {
  console.error(err);
  const el = document.getElementById('loadStatus');
  if (el) el.textContent = `Błąd startu: ${err.message}`;
});

export { game };

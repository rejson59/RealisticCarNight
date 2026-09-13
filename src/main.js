import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { City } from './world/City.js';
import { Car } from './world/Car.js';
import { Traffic } from './world/Traffic.js';
import { Input } from './core/Input.js';
import { AudioEngine } from './core/AudioEngine.js';
import { QualityManager, TIER_SETTINGS, TIER_NAMES } from './core/QualityManager.js';
import { Autopilot } from './core/Autopilot.js';
import { HUD } from './ui/HUD.js';
import { mulberry32 as mulberry } from './core/utils.js';

const VignetteShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uIntensity: { value: 1.0 },
    uBlur: { value: 0.0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uIntensity;
    uniform float uBlur;
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    void main(){
      vec2 uv = vUv;
      vec2 d = uv - 0.5;
      float ca = 0.0016 * uIntensity;
      vec3 col;
      if (uBlur > 0.001) {
        // radial speed blur (cheap motion blur at high speed), CA on the centre tap
        vec2 dir = d * uBlur * 0.055;
        vec3 acc = vec3(0.0);
        acc.r = texture2D(tDiffuse, uv + d * ca).r;
        acc.g = texture2D(tDiffuse, uv).g;
        acc.b = texture2D(tDiffuse, uv - d * ca).b;
        acc += texture2D(tDiffuse, uv - dir).rgb;
        acc += texture2D(tDiffuse, uv - dir * 2.0).rgb;
        acc += texture2D(tDiffuse, uv - dir * 3.0).rgb;
        col = acc * 0.25;
      } else {
        // subtle chromatic aberration towards edges
        col.r = texture2D(tDiffuse, uv + d * ca).r;
        col.g = texture2D(tDiffuse, uv).g;
        col.b = texture2D(tDiffuse, uv - d * ca).b;
      }
      // vignette
      float v = smoothstep(0.92, 0.30, length(d) * 1.35);
      col *= mix(0.62, 1.0, v);
      // subtle teal-shadow / warm-highlight grade
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col *= mix(vec3(0.80, 1.02, 1.06), vec3(1.07, 0.99, 0.91), smoothstep(0.02, 0.45, luma));
      // fine film grain
      float n = hash(uv * vec2(1920.0, 1080.0) + fract(uTime) * 137.0);
      col += (n - 0.5) * 0.028 * uIntensity;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

class Game {
  constructor() {
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setClearColor(0x05070d, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // shadows update once per frame (the wet-mirror pass must not re-render them)
    this.renderer.shadowMap.autoUpdate = false;
    document.getElementById('app').appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.3, 3200);
    this.camera.position.set(0, 4, 70);

    this.quality = new QualityManager();
    this.hud = new HUD();
    this.audio = new AudioEngine();
    this.camMode = 0; // 0 chase, 1 hood
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.started = false;
    this.time = 0;
    this.autopilot = new Autopilot();
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
    await step('Budowanie samochodu…', 55, () => {
      this.car = new Car(this.scene);
      this.traffic = new Traffic(this.scene, this.city);
      // traffic acts as a soft collider for the player
      this.city.dynamicColliders = this.traffic.colliders;
    });
    await step('Odbicia i oświetlenie…', 80, () => {
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
      this.carEnvRT = pmrem2.fromScene(envScene, 0.06, 1, 400);
      pmrem2.dispose();
      this.car.setEnvMaps(this.carEnvRT.texture, 2.6);
      envScene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    });
    await step('Prawie gotowe…', 92, () => {
      // place the chase camera behind the car before the first frame
      const fx = Math.sin(this.car.heading), fz = Math.cos(this.car.heading);
      this.camPos.set(this.car.pos.x - fx * 8, 3.0, this.car.pos.z - fz * 8);
      this.camLook.set(this.car.pos.x + fx * 6, 1.2, this.car.pos.z + fz * 6);
    });
    await step('Gotowe!', 100, () => {
      this.input = new Input({
        camera: () => this.toggleCamera(),
        mute: () => this.toggleMute(),
        reset: () => this.resetCar(),
        help: () => this.toggleHelp(),
        quality: () => this.cycleQuality(),
        auto: () => this.toggleAutopilot(),
      });
      this.applyTier(this.quality.tier, true);
      this.hud.buildStaticMap(this.city);
      this._bindUI();
      this._resize();
      window.addEventListener('resize', () => this._resize());
      this.clock = new THREE.Clock();
      document.getElementById('loading').classList.add('done');
      document.getElementById('start').classList.remove('hidden');
      if (this.input.isTouch) document.getElementById('touch').classList.add('visible');
      else document.getElementById('kbhints').style.display = 'block';
      this._loop();
    });
  }

  _bindUI() {
    document.getElementById('startBtn').addEventListener('click', () => {
      document.getElementById('start').classList.add('hidden');
      this.started = true;
      this.audio.start();
      this.audio.setMuted(false);
      this.hud.show();
      this.hud.toast('Miłej jazdy 🌃  (H — pomoc)');
    });
    document.getElementById('helpClose').addEventListener('click', () => this.toggleHelp(false));
  }

  toggleAutopilot(force) {
    const on = force !== undefined ? force : !this.autopilot.enabled;
    this.autopilot.enabled = on;
    if (on) this.autopilot.snap(this.car, this.city);
    document.getElementById('apBadge').classList.toggle('off', !on);
    this.hud.toast(on ? '🤖 Autopilot włączony — dowolny klawisz jazdy przejmuje kontrolę' : 'Autopilot wyłączony');
  }

  toggleHelp(force) {
    const el = document.getElementById('help');
    const show = force !== undefined ? force : el.classList.contains('hidden');
    el.classList.toggle('hidden', !show);
  }

  toggleCamera() {
    this.camMode = (this.camMode + 1) % 2;
    this.hud.toast(this.camMode === 0 ? 'Kamera: pościgowa' : 'Kamera: maska');
  }

  toggleMute() {
    this.audio.setMuted(!this.audio.muted);
    this.hud.toast(this.audio.muted ? 'Dźwięk wyciszony' : 'Dźwięk włączony');
  }

  cycleQuality() {
    const res = this.quality.cycle();
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

  /* ------------------------------------------------------------ tiers */
  applyTier(tier, first = false) {
    const s = TIER_SETTINGS[tier];
    const dpr = Math.min(window.devicePixelRatio || 1, s.pixelRatio) * (this.quality.resScale || 1);
    this.renderer.setPixelRatio(dpr);
    this.renderer.shadowMap.enabled = s.shadows;
    this.city.setQuality(tier);
    this.traffic.setCount(s.traffic);
    this.scene.environmentIntensity = s.env;
    this._buildComposer(s, dpr);
    this.hud.setTier(this.quality.label());
    if (!first) this.hud.toast(`Auto-dostosowanie grafiki: ${TIER_NAMES[tier]}`, 2000);
  }

  _buildComposer(s, dpr) {
    if (this.composer) {
      this.composer.dispose?.();
    }
    const w = Math.floor(innerWidth * dpr);
    const h = Math.floor(innerHeight * dpr);
    const rt = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      samples: s.msaa,
      depthBuffer: true,
    });
    const composer = new EffectComposer(this.renderer, rt);
    composer.setPixelRatio(dpr);
    composer.setSize(innerWidth, innerHeight);
    composer.addPass(new RenderPass(this.scene, this.camera));
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(Math.max(2, w * s.bloomScale), Math.max(2, h * s.bloomScale)),
      s.bloom, 0.38, 0.8
    );
    composer.addPass(bloom);
    if (s.vignette) {
      const vig = new ShaderPass(VignetteShader);
      vig.uniforms.uIntensity.value = tierGrain(this.quality.tier);
      composer.addPass(vig);
      this.vigPass = vig;
    } else {
      this.vigPass = null;
    }
    composer.addPass(new OutputPass());
    this.composer = composer;
  }

  /* ----------------------------------------------------------- resize */
  _resize() {
    const w = innerWidth, h = innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    const s = TIER_SETTINGS[this.quality.tier];
    const dpr = Math.min(window.devicePixelRatio || 1, s.pixelRatio) * (this.quality.resScale || 1);
    this.composer?.setSize(w, h);
    this.composer?.setPixelRatio(dpr);
  }

  /* ----------------------------------------------------------- camera */
  _updateCamera(dt) {
    const car = this.car;
    const kmh = car.speedKmh;
    const fx = Math.sin(car.heading), fz = Math.cos(car.heading);
    if (this.camMode === 0) {
      const dist = 6.3 + kmh * 0.040;
      const height = 2.05 + kmh * 0.008;
      const desired = new THREE.Vector3(
        car.pos.x - fx * dist, height, car.pos.z - fz * dist
      );
      const look = new THREE.Vector3(
        car.pos.x + fx * (6.5 + kmh * 0.06), 1.0, car.pos.z + fz * (6.5 + kmh * 0.06)
      );
      const k = 1 - Math.exp(-dt * 4.6);
      const kl = 1 - Math.exp(-dt * 7.5);
      this.camPos.lerp(desired, k);
      this.camLook.lerp(look, kl);
      const fov = 62 + Math.min(24, kmh * 0.11);
      if (Math.abs(this.camera.fov - fov) > 0.1) {
        this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 3);
        this.camera.updateProjectionMatrix();
      }
    } else {
      this.camPos.set(car.pos.x + fx * 0.35, 1.18, car.pos.z + fz * 0.35);
      this.camLook.set(car.pos.x + fx * 40, 1.0, car.pos.z + fz * 40);
      const fov = 70 + Math.min(18, kmh * 0.08);
      if (Math.abs(this.camera.fov - fov) > 0.1) {
        this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 3);
        this.camera.updateProjectionMatrix();
      }
    }
    // speed shake
    const shake = Math.pow(Math.min(1, kmh / 230), 2) * 0.045;
    this.camera.position.set(
      this.camPos.x + (Math.random() - 0.5) * shake,
      this.camPos.y + (Math.random() - 0.5) * shake,
      this.camPos.z + (Math.random() - 0.5) * shake
    );
    this.camera.lookAt(this.camLook);
  }

  /* ------------------------------------------------------------- loop */
  _loop() {
    const tick = () => {
      requestAnimationFrame(tick);
      const dt = Math.min(0.05, this.clock.getDelta());
      this.time += dt;
      let input = this.started ? this.input.read() : {
        throttle: 0, brake: 0, left: false, right: false, handbrake: false,
      };
      if (this.autopilot.enabled) {
        const manual = input.throttle || input.brake || input.left || input.right || input.handbrake;
        if (manual) this.toggleAutopilot(false);
        else input = this.autopilot.update(dt, this.car, this.city, this.traffic.positions);
      }
      this.car.update(dt, input, this.city);
      this.traffic.update(dt);
      this.city.update(dt, this.car.pos);
      this._updateCamera(dt);
      this.audio.update(this.car, input, dt);
      if (this.vigPass) {
        this.vigPass.uniforms.uTime.value = this.time;
        const kmhNow = this.car.speedKmh;
        const wantBlur = this.quality.tier >= 2 ? Math.min(1, Math.max(0, (kmhNow - 80) / 140)) : 0;
        this.vigPass.uniforms.uBlur.value += (wantBlur - this.vigPass.uniforms.uBlur.value) * Math.min(1, dt * 3);
      }

      const res = this.quality.push(dt);
      if (res && res.changed) {
        this.applyTier(res.tier);
      }

      // HUD (throttled on purpose — canvas 2D costs CPU on phones)
      this.frame = (this.frame || 0) + 1;
      if (this.frame % 2 === 0) {
        const gear2 = this.car.vf < -0.5 ? 'R'
        : Math.abs(this.car.vf) < 0.4 ? 'N'
          : `D${Math.min(6, 1 + Math.floor(this.car.speedKmh / 34))}`;
        this.hud.drawGauge(this.car.speedKmh, gear2, input.brake > 0 || input.handbrake);
      }
      if (this.frame % 3 === 0) this.hud.drawMinimap(this.car, this.traffic.positions);
      this.hud.fps(dt);

      this.renderer.shadowMap.needsUpdate = true;
      this.composer.render();
    };
    tick();
  }
}

function tierGrain(tier) {
  return tier >= 2 ? 1.0 : 0.6;
}

const game = new Game();
game.boot().catch((err) => {
  console.error(err);
  const el = document.getElementById('loadStatus');
  if (el) el.textContent = `Błąd startu: ${err.message}`;
});

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  mulberry32, facadeTextures, neonAtlas, asphaltTextures,
  canvasTexture, lightPoolTexture, radialTexture, streakTexture,
} from '../core/utils.js';
import { WetGroundReflection } from './PlanarReflection.js';

export const CITY = {
  BLOCK: 88,
  ROAD: 26,
  N: 7,
};
CITY.S = CITY.BLOCK + CITY.ROAD;              // grid pitch
CITY.EXTENT = CITY.N * CITY.S;                // city size
CITY.HALF = CITY.EXTENT / 2;

/**
 * The whole night city: wet roads, instanced towers with lit windows,
 * street lights, traffic lights, neon signs, elevated highways, sky & rain.
 */
export class City {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.rnd = mulberry32(20260911);
    this.tier = 2;
    this.time = 0;
    this.pillarColliders = [];
    this.haloItems = [];
    this.facadeMats = [];
    this.roadLines = [];
    for (let i = 0; i <= CITY.N; i++) this.roadLines.push(-CITY.HALF + i * CITY.S);

    this._buildGround();
    this._buildSky();
    this._buildBlocks();
    this._buildSkyline();
    this._buildStreetLights();
    this._buildTrafficLights();
    this._buildNeon();
    this._buildElevated();
    this._buildRoadMarkings();
    this._buildParked();
    this._buildHalos();
    this._buildRain();
    this._buildMoonLight();
  }

  /* ------------------------------------------------ ground & wet mirror */
  _buildGround() {
    const tex = asphaltTextures();
    this.puddleMask = canvasTexture(tex.mask, { repeat: [10, 10], srgb: false });
    const albedo = canvasTexture(tex.albedo, { repeat: [90, 90] });
    const rough = canvasTexture(tex.rough, { repeat: [90, 90], srgb: false });

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(CITY.EXTENT + 700, CITY.EXTENT + 700),
      new THREE.MeshStandardMaterial({
        map: albedo,
        roughnessMap: rough,
        roughness: 0.8,
        metalness: 0.3,
        color: 0xc0ccd8,
        envMapIntensity: 1.0,
      })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);
    this.ground = ground;

    // lane dashes (instanced, one draw call)
    const dashGeo = new THREE.PlaneGeometry(0.35, 3.2);
    dashGeo.rotateX(-Math.PI / 2);
    const dashMat = new THREE.MeshBasicMaterial({ color: 0x9aa4b0, transparent: true, opacity: 0.5 });
    const perRoad = Math.floor(CITY.EXTENT / 9);
    const dashes = new THREE.InstancedMesh(dashGeo, dashMat, perRoad * this.roadLines.length * 2);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    let di = 0;
    for (const L of this.roadLines) {
      for (let k = 0; k < perRoad; k++) {
        const p = -CITY.HALF + k * 9 + 4;
        e.set(0, 0, 0); q.setFromEuler(e);
        m.compose(new THREE.Vector3(p, 0.04, L), q, new THREE.Vector3(1, 1, 1));
        dashes.setMatrixAt(di++, m);
        e.set(0, Math.PI / 2, 0); q.setFromEuler(e);
        m.compose(new THREE.Vector3(L, 0.04, p), q, new THREE.Vector3(1, 1, 1));
        dashes.setMatrixAt(di++, m);
      }
    }
    dashes.count = di;
    dashes.instanceMatrix.needsUpdate = true;
    this.scene.add(dashes);

    // planar reflection (puddles) — resolution/visibility per quality tier
    this.reflection = new WetGroundReflection(CITY.EXTENT + 300, CITY.EXTENT + 300, 512, this.puddleMask);
    this.reflection.rotation.x = -Math.PI / 2;
    this.reflection.position.y = 0.10;
    this.scene.add(this.reflection);
  }

  /* -------------------------------------------------------------- sky */
  _buildSky() {
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(1900, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {},
        vertexShader: `
          varying vec3 vDir;
          void main(){
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
          }`,
        fragmentShader: `
          varying vec3 vDir;
          void main(){
            float h = vDir.y;
            vec3 zenith = vec3(0.003, 0.005, 0.011);
            vec3 mid    = vec3(0.007, 0.011, 0.024);
            vec3 horiz  = vec3(0.016, 0.023, 0.042);
            vec3 col = mix(horiz, mid, smoothstep(-0.02, 0.12, h));
            col = mix(col, zenith, smoothstep(0.10, 0.5, h));
            // warm city glow dome
            float glow = pow(max(0.0, 1.0 - abs(h + 0.01) * 5.0), 2.2);
            col += vec3(0.20, 0.12, 0.06) * glow;
            gl_FragColor = vec4(col, 1.0);
          }`,
      })
    );
    sky.frustumCulled = false;
    this.scene.add(sky);

    // stars
    const rnd = this.rnd;
    const N = 1400;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const a = rnd() * Math.PI * 2;
      const y = 0.06 + rnd() * 0.94;
      const r = Math.sqrt(1 - y * y);
      pos[i * 3] = Math.cos(a) * r * 1700;
      pos[i * 3 + 1] = y * 1700;
      pos[i * 3 + 2] = Math.sin(a) * r * 1700;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(g, new THREE.PointsMaterial({
      color: 0xbcd0ff, size: 1.6, sizeAttenuation: false,
      transparent: true, opacity: 0.45, depthWrite: false, fog: false,
    }));
    this.scene.add(this.stars);

    // moon + halo
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: canvasTexture(radialTexture('rgba(210,225,255,0.9)', 'rgba(210,225,255,0)')),
      transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
    }));
    halo.scale.setScalar(420);
    halo.position.set(720, 460, -980);
    this.scene.add(halo);
    const moon = new THREE.Sprite(new THREE.SpriteMaterial({
      map: canvasTexture(radialTexture('rgba(255,255,255,1)', 'rgba(220,230,255,0)', 128, 2.4)),
      transparent: true, depthWrite: false, fog: false,
    }));
    moon.scale.setScalar(70);
    moon.position.copy(halo.position);
    this.scene.add(moon);
  }

  /* ------------------------------------------- sidewalks + buildings */
  _buildBlocks() {
    const rnd = this.rnd;
    const { BLOCK, S, N, HALF } = CITY;

    // sidewalk slabs
    const slab = new THREE.InstancedMesh(
      new THREE.BoxGeometry(BLOCK, 0.34, BLOCK),
      new THREE.MeshStandardMaterial({ color: 0x14171c, roughness: 0.75, metalness: 0.1 }),
      N * N
    );
    slab.receiveShadow = true;
    const m4 = new THREE.Matrix4();
    let si = 0;
    this.plazas = [];
    this.buildings = [];
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const cx = -HALF + i * S + S / 2;
        const cz = -HALF + j * S + S / 2;
        m4.setPosition(cx, 0.17, cz);
        slab.setMatrixAt(si++, m4);
        if (rnd() < 0.14) this.plazas.push({ cx, cz });
      }
    }
    slab.instanceMatrix.needsUpdate = true;
    this.scene.add(slab);

    // facade texture variants -> 4 instanced meshes
    const VARIANTS = 4;
    const variants = [];
    for (let v = 0; v < VARIANTS; v++) {
      const t = facadeTextures(100 + v * 17);
      variants.push({
        map: canvasTexture(t.map, { aniso: 8 }),
        emi: canvasTexture(t.emi, { aniso: 8 }),
        items: [],
      });
    }

    const antennaItems = [];
    const beaconItems = [];

    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const cx = -HALF + i * S + S / 2;
        const cz = -HALF + j * S + S / 2;
        if (this.plazas.some((p) => p.cx === cx && p.cz === cz)) continue;
        const dc = Math.hypot(cx, cz);
        const layout = rnd();
        const lots = [];
        const inset = 5;
        const usable = BLOCK - inset * 2;
        if (layout < 0.42) {
          lots.push({ x: cx, z: cz, w: usable * (0.6 + rnd() * 0.4), d: usable * (0.6 + rnd() * 0.4) });
        } else if (layout < 0.78) {
          const horiz = rnd() < 0.5;
          for (let k = 0; k < 2; k++) {
            const off = (k - 0.5) * usable * 0.52;
            lots.push(horiz
              ? { x: cx + off, z: cz, w: usable * 0.44, d: usable * (0.6 + rnd() * 0.4) }
              : { x: cx, z: cz + off, w: usable * (0.6 + rnd() * 0.4), d: usable * 0.44 });
          }
        } else {
          for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) {
            if (rnd() < 0.18) continue;
            lots.push({
              x: cx + (a - 0.5) * usable * 0.5,
              z: cz + (b - 0.5) * usable * 0.5,
              w: usable * 0.42, d: usable * 0.42,
            });
          }
        }
        for (const lot of lots) {
          let h;
          if (dc < 150) h = 50 + rnd() * 85;
          else if (dc < 260) h = 24 + rnd() * 48;
          else h = 11 + rnd() * 24;
          if (rnd() < 0.1 && dc < 220) h *= 1.45;
          const v = variants[(rnd() * VARIANTS) | 0];
          v.items.push({ x: lot.x, z: lot.z, w: lot.w, d: lot.d, h, tint: 0.7 + rnd() * 0.4 });
          this.buildings.push({ x: lot.x, z: lot.z, w: lot.w, d: lot.d, h });
          if (h > 68 && rnd() < 0.8) {
            antennaItems.push({ x: lot.x, z: lot.z, h });
            beaconItems.push({ x: lot.x, z: lot.z, h: h + 6 + rnd() * 4 });
          }
        }
      }
    }

    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    boxGeo.translate(0, 0.5, 0);
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x0a0c10, roughness: 0.9 });
    variants.forEach((v) => {
      const mat = new THREE.MeshStandardMaterial({
        map: v.map,
        emissiveMap: v.emi,
        emissive: 0xffffff,
        emissiveIntensity: 1.45,
        roughness: 0.42,
        metalness: 0.55,
        envMapIntensity: 0.8,
      });
      // window UVs from world position (box projection) — no extra attributes,
      // works on every GPU and keeps floor heights consistent city-wide
      mat.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader.replace(
          '#include <uv_vertex>',
          `vec3 wPos = vec3(position);
           #ifdef USE_INSTANCING
             wPos = (instanceMatrix * vec4(position, 1.0)).xyz;
           #endif
           vec3 an = abs(normal);
           vec2 wuv;
           if (an.y > 0.5) { wuv = wPos.xz; }
           else if (an.x > 0.5) { wuv = wPos.zy; }
           else { wuv = wPos.xy; }
           wuv *= vec2(1.0 / 24.0, 1.0 / 42.0); // 12 bays x 28 floors per 24 m x 42 m
           #ifdef USE_MAP
             vMapUv = ( mapTransform * vec3( wuv, 1.0 ) ).xy;
           #endif
           #ifdef USE_EMISSIVEMAP
             vEmissiveMapUv = ( emissiveMapTransform * vec3( wuv, 1.0 ) ).xy;
           #endif`
        );
      };
      this.facadeMats.push({ mat, roofMat });
      const geo = boxGeo.clone();
      const im = new THREE.InstancedMesh(geo, [mat, mat, roofMat, roofMat, mat, mat], v.items.length);
      im.castShadow = true;
      im.receiveShadow = true;
      const col = new THREE.Color();
      v.items.forEach((it, k) => {
        m4.compose(
          new THREE.Vector3(it.x, 0.34, it.z),
          new THREE.Quaternion(),
          new THREE.Vector3(it.w, it.h, it.d)
        );
        im.setMatrixAt(k, m4);
        col.setScalar(it.tint);
        im.setColorAt(k, col);
      });
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      this.scene.add(im);
    });

    // antennas + beacons
    if (antennaItems.length) {
      const ant = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(0.12, 0.2, 8, 5),
        new THREE.MeshStandardMaterial({ color: 0x11141a, roughness: 0.8 }),
        antennaItems.length
      );
      antennaItems.forEach((a, k) => {
        m4.setPosition(a.x, a.h + 4, a.z);
        ant.setMatrixAt(k, m4);
      });
      ant.instanceMatrix.needsUpdate = true;
      this.scene.add(ant);
    }
    if (beaconItems.length) {
      const bg = new THREE.SphereGeometry(0.4, 6, 6);
      this.beacons = [];
      for (let phase = 0; phase < 2; phase++) {
        const items = beaconItems.filter((_, k) => k % 2 === phase);
        if (!items.length) continue;
        const bm = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 0.1, 0.12) });
        const bmesh = new THREE.InstancedMesh(bg, bm, items.length);
        items.forEach((a, k) => {
          m4.setPosition(a.x, a.h, a.z);
          bmesh.setMatrixAt(k, m4);
        });
        bmesh.instanceMatrix.needsUpdate = true;
        this.scene.add(bmesh);
        this.beacons.push({ mesh: bmesh, phase });
      }
    }

    // plaza trees
    if (this.plazas.length) {
      const trunkItems = [];
      const crownItems = [];
      for (const p of this.plazas) {
        const n = 8 + ((rnd() * 8) | 0);
        for (let k = 0; k < n; k++) {
          const x = p.cx + (rnd() - 0.5) * (BLOCK - 16);
          const z = p.cz + (rnd() - 0.5) * (BLOCK - 16);
          trunkItems.push({ x, z });
          crownItems.push({ x, z, s: 2.2 + rnd() * 2.4, y: 2.6 + rnd() * 1.6 });
        }
      }
      const trunks = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(0.16, 0.24, 3, 5),
        new THREE.MeshStandardMaterial({ color: 0x14100c, roughness: 0.95 }),
        trunkItems.length
      );
      trunkItems.forEach((t, k) => { m4.setPosition(t.x, 1.7, t.z); trunks.setMatrixAt(k, m4); });
      trunks.instanceMatrix.needsUpdate = true;
      const crowns = new THREE.InstancedMesh(
        new THREE.IcosahedronGeometry(1, 1),
        new THREE.MeshStandardMaterial({ color: 0x0a150e, roughness: 0.95 }),
        crownItems.length
      );
      crownItems.forEach((t, k) => {
        m4.compose(new THREE.Vector3(t.x, t.y, t.z), new THREE.Quaternion(), new THREE.Vector3(t.s, t.s * 1.2, t.s));
        crowns.setMatrixAt(k, m4);
      });
      crowns.instanceMatrix.needsUpdate = true;
      this.scene.add(trunks, crowns);
    }
  }

  /* --------------------------------------------------- street lights */
  _buildStreetLights() {
    const { ROAD, HALF } = CITY;
    const positions = [];
    for (const L of this.roadLines) {
      for (let s = -1; s <= 1; s += 2) {
        for (let p = -HALF + 12; p < HALF - 8; p += 26) {
          positions.push({ along: p, line: L, side: s, axisX: true });
          positions.push({ along: p, line: L, side: s, axisX: false });
        }
      }
    }
    const n = positions.length;
    const pole = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.09, 0.13, 8, 6),
      new THREE.MeshStandardMaterial({ color: 0x3a424c, roughness: 0.6, metalness: 0.6 }),
      n
    );
    const arm = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.08, 0.08, 2.4),
      pole.material, n
    );
    const head = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.5, 0.16, 1.1),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(3.4, 2.9, 2.1) }),
      n
    );
    const poolTex = canvasTexture(lightPoolTexture());
    const decal = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(17, 12),
      new THREE.MeshBasicMaterial({
        map: poolTex, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, color: 0xffc98a, opacity: 0.55,
      }),
      n
    );
    const streak = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(3.4, 34),
      new THREE.MeshBasicMaterial({
        map: canvasTexture(streakTexture()), transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, color: 0xffd9a8, opacity: 0.5,
      }),
      n
    );
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    positions.forEach((p, k) => {
      const off = ROAD / 2 - 1.3;
      const toward = ROAD / 2 - 2.8;
      let px, pz, hx, hz, rotY;
      if (p.axisX) {
        px = p.along; pz = p.line + p.side * off;
        hx = p.along; hz = p.line + p.side * toward;
        rotY = p.side > 0 ? Math.PI : 0;
      } else {
        pz = p.along; px = p.line + p.side * off;
        hz = p.along; hx = p.line + p.side * toward;
        rotY = p.side > 0 ? -Math.PI / 2 : Math.PI / 2;
      }
      m4.setPosition(px, 4, pz); pole.setMatrixAt(k, m4);
      e.set(0, rotY, 0); q.setFromEuler(e);
      m4.compose(new THREE.Vector3((px + hx) / 2, 7.95, (pz + hz) / 2), q, new THREE.Vector3(1, 1, 1));
      arm.setMatrixAt(k, m4);
      m4.compose(new THREE.Vector3(hx, 7.86, hz), q, new THREE.Vector3(1, 1, 1));
      head.setMatrixAt(k, m4);
      this.haloItems.push({ x: hx, y: 7.8, z: hz, c: [2.6, 2.1, 1.4], s: 5.0 });
      e.set(-Math.PI / 2, p.axisX ? 0 : Math.PI / 2, 0, 'YXZ'); q.setFromEuler(e);
      m4.compose(new THREE.Vector3(hx, 0.16, hz), q, new THREE.Vector3(1, 1, 1));
      decal.setMatrixAt(k, m4);
      // streak lies ALONG the road axis
      e.set(-Math.PI / 2, p.axisX ? Math.PI / 2 : 0, 0, 'YXZ'); q.setFromEuler(e);
      m4.compose(new THREE.Vector3(hx, 0.14, hz), q, new THREE.Vector3(1, 1, 1));
      streak.setMatrixAt(k, m4);
    });
    [pole, arm, head, decal, streak].forEach((mesh) => {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
    });
    this.lightDecals = decal;
    this.lightStreaks = streak;
  }

  /* -------------------------------------------------- traffic lights */
  _buildTrafficLights() {
    const { ROAD } = CITY;
    const rnd = this.rnd;
    const heads = { g: [], r: [], y: [] };
    const poles = [];
    for (const Lx of this.roadLines) {
      for (const Lz of this.roadLines) {
        for (let cx = -1; cx <= 1; cx += 2) {
          for (let cz = -1; cz <= 1; cz += 2) {
            const x = Lx + cx * (ROAD / 2 - 1.1);
            const z = Lz + cz * (ROAD / 2 - 1.1);
            poles.push({ x, z });
            const r = rnd();
            const bucket = r < 0.68 ? heads.g : r < 0.9 ? heads.r : heads.y;
            bucket.push({ x, z });
          }
        }
      }
    }
    const m4 = new THREE.Matrix4();
    const poleMesh = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.09, 0.11, 4.6, 5),
      new THREE.MeshStandardMaterial({ color: 0x14171b, roughness: 0.6, metalness: 0.5 }),
      poles.length
    );
    poles.forEach((p, k) => { m4.setPosition(p.x, 2.3, p.z); poleMesh.setMatrixAt(k, m4); });
    poleMesh.instanceMatrix.needsUpdate = true;
    this.scene.add(poleMesh);

    const colors = { g: new THREE.Color(0.35, 4.0, 1.6), r: new THREE.Color(4.0, 0.15, 0.15), y: new THREE.Color(4.0, 2.2, 0.2) };
    const haloC = { g: [0.25, 2.6, 1.0], r: [2.6, 0.12, 0.12], y: [2.6, 1.4, 0.12] };
    const hg = new THREE.BoxGeometry(0.24, 0.62, 0.24);
    for (const key of ['g', 'r', 'y']) {
      const items = heads[key];
      if (!items.length) continue;
      const mesh = new THREE.InstancedMesh(hg, new THREE.MeshBasicMaterial({ color: colors[key] }), items.length);
      items.forEach((p, k) => {
        m4.setPosition(p.x, 4.35, p.z); mesh.setMatrixAt(k, m4);
        this.haloItems.push({ x: p.x, y: 4.35, z: p.z, c: haloC[key], s: 2.0 });
      });
      mesh.instanceMatrix.needsUpdate = true;
      this.scene.add(mesh);
    }
  }

  /* ------------------------------------------- neon signs & billboards */
  _buildNeon() {
    const rnd = this.rnd;
    const atlas = canvasTexture(neonAtlas());
    atlas.wrapS = atlas.wrapT = THREE.ClampToEdgeWrapping;
    const quads = [];

    const pushQuad = (w, h, pos, rotY, cell) => {
      const g = new THREE.PlaneGeometry(w, h);
      const cx = cell % 4, cy = (cell / 4) | 0;
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) {
        const u = uv.getX(i), v = uv.getY(i);
        uv.setXY(i, (cx + u * 0.94 + 0.03) / 4, 1 - (cy + (1 - v) * 0.94 + 0.03) / 4);
      }
      g.rotateY(rotY);
      g.translate(pos.x, pos.y, pos.z);
      quads.push(g);
    };

    // big billboards on tower faces
    for (const b of this.buildings) {
      if (b.h < 16 || rnd() > 0.24) continue;
      const face = (rnd() * 4) | 0;
      const w = Math.min(face % 2 === 0 ? b.w : b.d, 18) * 0.85;
      const h = 7 + rnd() * 9;
      const y = Math.min(b.h - h / 2 - 2, 9 + rnd() * Math.max(4, b.h * 0.45));
      const off = 0.15;
      if (face === 0) pushQuad(w, h, { x: b.x, y, z: b.z + b.d / 2 + off }, 0, (rnd() * 16) | 0);
      else if (face === 1) pushQuad(w, h, { x: b.x, y, z: b.z - b.d / 2 - off }, Math.PI, (rnd() * 16) | 0);
      else if (face === 2) pushQuad(w, h, { x: b.x + b.w / 2 + off, y, z: b.z }, Math.PI / 2, (rnd() * 16) | 0);
      else pushQuad(w, h, { x: b.x - b.w / 2 - off, y, z: b.z }, -Math.PI / 2, (rnd() * 16) | 0);
    }
    // giant downtown screens
    const tall = [...this.buildings].sort((a, b) => b.h - a.h).slice(0, 10);
    for (const b of tall) {
      if (rnd() < 0.4) continue;
      const face = (rnd() * 4) | 0;
      const w = Math.min(face % 2 === 0 ? b.w : b.d, 26) * 0.9;
      const h = w * 0.55;
      const y = b.h * (0.55 + rnd() * 0.3);
      const off = 0.2;
      if (face === 0) pushQuad(w, h, { x: b.x, y, z: b.z + b.d / 2 + off }, 0, (rnd() * 16) | 0);
      else if (face === 1) pushQuad(w, h, { x: b.x, y, z: b.z - b.d / 2 - off }, Math.PI, (rnd() * 16) | 0);
      else if (face === 2) pushQuad(w, h, { x: b.x + b.w / 2 + off, y, z: b.z }, Math.PI / 2, (rnd() * 16) | 0);
      else pushQuad(w, h, { x: b.x - b.w / 2 - off, y, z: b.z }, -Math.PI / 2, (rnd() * 16) | 0);
    }
    // street-level shop signs around blocks
    const { S, N, HALF, BLOCK } = CITY;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const cx = -HALF + i * S + S / 2;
        const cz = -HALF + j * S + S / 2;
        const n = 5 + ((rnd() * 4) | 0);
        for (let k = 0; k < n; k++) {
          const side = (rnd() * 4) | 0;
          const w = 4.5 + rnd() * 5.5, h = 1.5 + rnd() * 1.8;
          const y = 3.6 + rnd() * 3.0;
          const t = (rnd() - 0.5) * (BLOCK - 20);
          const off = BLOCK / 2 + 0.12;
          if (side === 0) pushQuad(w, h, { x: cx + t, y, z: cz + off }, 0, (rnd() * 16) | 0);
          else if (side === 1) pushQuad(w, h, { x: cx + t, y, z: cz - off }, Math.PI, (rnd() * 16) | 0);
          else if (side === 2) pushQuad(w, h, { x: cx + off, y, z: cz + t }, Math.PI / 2, (rnd() * 16) | 0);
          else pushQuad(w, h, { x: cx - off, y, z: cz + t }, -Math.PI / 2, (rnd() * 16) | 0);
        }
      }
    }
    if (quads.length) {
      const merged = mergeGeometries(quads, false);
      const neon = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({
        map: atlas, color: new THREE.Color(2.3, 2.3, 2.4), fog: true,
      }));
      neon.frustumCulled = false;
      this.scene.add(neon);
      quads.forEach((g) => g.dispose());
    }
  }

  /* ---------------------------------------------- elevated highways */
  _buildElevated() {
    this.elevCurves = [];
    const loopPts = [];
    const rnd = this.rnd;
    const rot = 0.5;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const rx = 252 + (rnd() - 0.5) * 46;
      const rz = 208 + (rnd() - 0.5) * 46;
      const x = Math.cos(a) * rx, z = Math.sin(a) * rz;
      loopPts.push(new THREE.Vector3(
        x * Math.cos(rot) - z * Math.sin(rot), 11,
        x * Math.sin(rot) + z * Math.cos(rot)
      ));
    }
    const loop = new THREE.CatmullRomCurve3(loopPts, true, 'catmullrom', 0.5);
    const crossPts = [];
    for (let x = -CITY.HALF - 60; x <= CITY.HALF + 60; x += 90) {
      crossPts.push(new THREE.Vector3(x, 15.5 + Math.sin(x * 0.01) * 1.2, -95 + Math.sin(x * 0.004) * 70));
    }
    const cross = new THREE.CatmullRomCurve3(crossPts, false, 'catmullrom', 0.5);
    this.elevCurves.push(loop, cross);

    const deckMat = new THREE.MeshStandardMaterial({ color: 0x0c0e12, roughness: 0.5, metalness: 0.4, side: THREE.DoubleSide, envMapIntensity: 0.7 });
    const barrierMat = new THREE.MeshStandardMaterial({ color: 0x181c22, roughness: 0.6, metalness: 0.4, side: THREE.DoubleSide });
    const glowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.12, 1.7, 1.1), side: THREE.DoubleSide });

    const buildRibbon = (curve, closed) => {
      const M = closed ? 260 : 160;
      const W = 15;
      const surf = [], barrier = [], glow = [];
      const pillars = [], lamps = [];
      const up = new THREE.Vector3(0, 1, 0);
      for (let i = 0; i <= M; i++) {
        const t = i / M;
        const tt = closed ? t % 1 : t;
        const p = curve.getPointAt(tt);
        const tan = curve.getTangentAt(tt).setY(0).normalize();
        const side = new THREE.Vector3().crossVectors(tan, up).normalize();
        const l = p.clone().addScaledVector(side, W / 2);
        const r = p.clone().addScaledVector(side, -W / 2);
        surf.push(l.x, p.y, l.z, r.x, p.y, r.z);
        barrier.push(l.x, p.y, l.z, l.x, p.y + 1.1, l.z, r.x, p.y, r.z, r.x, p.y + 1.1, r.z);
        glow.push(l.x - side.x * 0.12, p.y + 0.95, l.z - side.z * 0.12, l.x - side.x * 0.12, p.y + 1.06, l.z - side.z * 0.12,
          r.x + side.x * 0.12, p.y + 0.95, r.z + side.z * 0.12, r.x + side.x * 0.12, p.y + 1.06, r.z + side.z * 0.12);
        if (i % 12 === 0 && i < M) pillars.push(p.clone());
        if (i % 20 === 10 && i < M) lamps.push({ p: p.clone(), side: side.clone() });
      }
      const idx = [];
      const rows = M + 1;
      for (let i = 0; i < rows - 1; i++) {
        const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
        idx.push(a, c, b, b, c, d);
      }
      const bidx = [];
      for (let i = 0; i < rows - 1; i++) {
        // barrier: verts per row = 4 (l0,l1,r0,r1)
        const o = i * 4;
        bidx.push(o + 0, o + 4, o + 1, o + 1, o + 4, o + 5);
        bidx.push(o + 2, o + 3, o + 6, o + 3, o + 7, o + 6);
      }
      const gidx = [];
      for (let i = 0; i < rows - 1; i++) {
        const o = i * 4;
        gidx.push(o + 0, o + 4, o + 1, o + 1, o + 4, o + 5);
        gidx.push(o + 2, o + 3, o + 6, o + 3, o + 7, o + 6);
      }
      const mk = (arr, indices) => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
        g.setIndex(indices);
        g.computeVertexNormals();
        return g;
      };
      const surfMesh = new THREE.Mesh(mk(surf, idx), deckMat);
      const barrierMesh = new THREE.Mesh(mk(barrier, bidx), barrierMat);
      const glowMesh = new THREE.Mesh(mk(glow, gidx), glowMat);
      surfMesh.receiveShadow = true;
      this.scene.add(surfMesh, barrierMesh, glowMesh);

      // pillars
      const m4 = new THREE.Matrix4();
      const pil = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(1.05, 1.35, 1, 8),
        new THREE.MeshStandardMaterial({ color: 0x101318, roughness: 0.85 }),
        pillars.length
      );
      pillars.forEach((p, k) => {
        m4.compose(new THREE.Vector3(p.x, p.y / 2, p.z), new THREE.Quaternion(), new THREE.Vector3(1, p.y, 1));
        pil.setMatrixAt(k, m4);
        this.pillarColliders.push({ x: p.x, z: p.z, r: 1.7 });
      });
      pil.instanceMatrix.needsUpdate = true;
      pil.castShadow = true;
      this.scene.add(pil);
      const cap = new THREE.InstancedMesh(
        new THREE.BoxGeometry(4.2, 1.2, 4.2),
        pil.material, pillars.length
      );
      pillars.forEach((p, k) => { m4.setPosition(p.x, p.y - 0.7, p.z); cap.setMatrixAt(k, m4); });
      cap.instanceMatrix.needsUpdate = true;
      this.scene.add(cap);

      // lamps on the deck
      if (lamps.length) {
        const lp = new THREE.InstancedMesh(
          new THREE.CylinderGeometry(0.07, 0.09, 4.4, 5),
          new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: 0.6, metalness: 0.6 }),
          lamps.length
        );
        const lh = new THREE.InstancedMesh(
          new THREE.BoxGeometry(0.4, 0.14, 0.9),
          new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 2.1, 1.5) }),
          lamps.length
        );
        lamps.forEach((L, k) => {
          const base = L.p.clone().addScaledVector(L.side, 7 * (k % 2 ? 1 : -1));
          m4.setPosition(base.x, base.y + 2.2, base.z);
          lp.setMatrixAt(k, m4);
          const hp = base.clone().addScaledVector(L.side, -1.2 * (k % 2 ? 1 : -1));
          m4.setPosition(hp.x, base.y + 4.35, hp.z);
          lh.setMatrixAt(k, m4);
        });
        lp.instanceMatrix.needsUpdate = true;
        lh.instanceMatrix.needsUpdate = true;
        this.scene.add(lp, lh);
      }
    };
    buildRibbon(loop, true);
    buildRibbon(cross, false);
  }

  /* --------------------------------------- distant skyline (backdrop) */
  _buildSkyline() {
    const rnd = this.rnd;
    const m4 = new THREE.Matrix4();
    const items = [[], []];
    for (let k = 0; k < 90; k++) {
      const a = rnd() * Math.PI * 2;
      const r = 470 + rnd() * 430;
      const w = 26 + rnd() * 38;
      const h = 90 + rnd() * 160;
      items[k % 2].push({ x: Math.cos(a) * r, z: Math.sin(a) * r, w, d: w * (0.7 + rnd() * 0.6), h });
    }
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    boxGeo.translate(0, 0.5, 0);
    items.forEach((list, vi) => {
      const { mat, roofMat } = this.facadeMats[vi];
      const im = new THREE.InstancedMesh(boxGeo.clone(), [mat, mat, roofMat, roofMat, mat, mat], list.length);
      list.forEach((it, k) => {
        m4.compose(new THREE.Vector3(it.x, 0, it.z), new THREE.Quaternion(), new THREE.Vector3(it.w, it.h, it.d));
        im.setMatrixAt(k, m4);
      });
      im.instanceMatrix.needsUpdate = true;
      im.frustumCulled = false;
      this.scene.add(im);
    });
  }

  /* --------------------------- crosswalks + edge lines + parked cars */
  _buildRoadMarkings() {
    const { ROAD } = CITY;
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    // zebra stripes at every intersection approach
    const stripes = [];
    for (const Lx of this.roadLines) {
      for (const Lz of this.roadLines) {
        for (let side = 0; side < 4; side++) {
          for (let t = -10; t <= 10; t += 2) {
            stripes.push({ Lx, Lz, side, t });
          }
        }
      }
    }
    const zebra = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.7, 3.6),
      new THREE.MeshBasicMaterial({ color: 0xbac4ce, transparent: true, opacity: 0.22, depthWrite: false }),
      stripes.length
    );
    stripes.forEach((sp, k) => {
      const off = ROAD / 2 + 2.2;
      let x, z, yaw;
      if (sp.side === 0) { x = sp.Lx + sp.t; z = sp.Lz - off; yaw = 0; }
      else if (sp.side === 1) { x = sp.Lx + sp.t; z = sp.Lz + off; yaw = 0; }
      else if (sp.side === 2) { x = sp.Lx - off; z = sp.Lz + sp.t; yaw = Math.PI / 2; }
      else { x = sp.Lx + off; z = sp.Lz + sp.t; yaw = Math.PI / 2; }
      e.set(-Math.PI / 2, yaw, 0, 'YXZ'); q.setFromEuler(e);
      m4.compose(new THREE.Vector3(x, 0.05, z), q, new THREE.Vector3(1, 1, 1));
      zebra.setMatrixAt(k, m4);
    });
    zebra.instanceMatrix.needsUpdate = true;
    zebra.frustumCulled = false;
    this.scene.add(zebra);

    // solid edge lines along every road
    const { HALF, EXTENT } = CITY;
    const geos = [];
    for (const L of this.roadLines) {
      for (const sd of [-1, 1]) {
        const gx = new THREE.PlaneGeometry(EXTENT, 0.32);
        gx.rotateX(-Math.PI / 2);
        gx.translate(0, 0.045, L + sd * (ROAD / 2 - 0.7));
        geos.push(gx);
        const gz = new THREE.PlaneGeometry(0.32, EXTENT);
        gz.rotateX(-Math.PI / 2);
        gz.translate(L + sd * (ROAD / 2 - 0.7), 0.045, 0);
        geos.push(gz);
      }
    }
    const merged = mergeGeometries(geos, false);
    const edges = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({
      color: 0x9aa4b0, transparent: true, opacity: 0.26, depthWrite: false,
    }));
    edges.frustumCulled = false;
    this.scene.add(edges);
    geos.forEach((g) => g.dispose());
    void HALF;
  }

  _buildParked() {
    const rnd = this.rnd;
    const { ROAD } = CITY;
    const geos = [];
    const palette = [
      [0.09, 0.10, 0.12], [0.16, 0.03, 0.04], [0.05, 0.08, 0.14],
      [0.12, 0.12, 0.13], [0.04, 0.10, 0.08], [0.20, 0.18, 0.16],
    ];
    const push = (geo, color) => {
      const col = new THREE.Color(...color);
      const count = geo.attributes.position.count;
      const arr = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) arr.set([col.r, col.g, col.b], i * 3);
      geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      geos.push(geo);
    };
    for (const L of this.roadLines) {
      for (let p = -CITY.HALF + 30; p < CITY.HALF - 20; p += 57) {
        for (const sd of [-1, 1]) {
          if (rnd() < 0.45) continue;
          const off = sd * (ROAD / 2 - 2.3);
          const alongX = rnd() < 0.5;
          const x = alongX ? p : L + off;
          const z = alongX ? L + off : p;
          const yaw = alongX ? Math.PI / 2 : 0;
          const col = palette[(rnd() * palette.length) | 0];
          const body = new THREE.BoxGeometry(1.8, 0.52, 4.4);
          body.translate(0, 0.62, 0);
          const cab = new THREE.BoxGeometry(1.6, 0.46, 2.2);
          cab.translate(0, 1.1, -0.15);
          body.rotateY(yaw); cab.rotateY(yaw);
          body.translate(x, 0, z); cab.translate(x, 0, z);
          push(body, col); push(cab, col.map((c) => c * 0.55));
        }
      }
    }
    const merged = mergeGeometries(geos, false);
    const parked = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({
      vertexColors: true, metalness: 0.75, roughness: 0.32, envMapIntensity: 1.2,
    }));
    parked.frustumCulled = false;
    this.scene.add(parked);
    geos.forEach((g) => g.dispose());
  }

  /* ------------------------------------ billboard halos around lamps */
  _buildHalos() {
    const items = this.haloItems;
    if (!items.length) return;
    const geo = new THREE.PlaneGeometry(1, 1);
    const colors = new Float32Array(items.length * 3);
    const m4 = new THREE.Matrix4();
    const mesh = new THREE.InstancedMesh(geo, new THREE.ShaderMaterial({
      vertexShader: `
        attribute vec3 aColor;
        varying vec3 vColor;
        varying vec2 vUv2;
        void main() {
          vec4 mv = viewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          float sx = length(instanceMatrix[0].xyz);
          float sy = length(instanceMatrix[1].xyz);
          mv.xy += position.xy * vec2(sx, sy);
          gl_Position = projectionMatrix * mv;
          vColor = aColor;
          vUv2 = uv;
        }`,
      fragmentShader: `
        varying vec3 vColor;
        varying vec2 vUv2;
        void main() {
          float d = length(vUv2 - 0.5) * 2.0;
          float a = pow(max(0.0, 1.0 - d), 2.6);
          gl_FragColor = vec4(vColor * a, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }), items.length);
    items.forEach((it, k) => {
      m4.compose(new THREE.Vector3(it.x, it.y, it.z), new THREE.Quaternion(), new THREE.Vector3(it.s, it.s, it.s));
      mesh.setMatrixAt(k, m4);
      colors.set(it.c, k * 3);
    });
    geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(colors, 3));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this.halos = mesh;
  }

  /* ------------------------------------------------------------- rain */
  _buildRain() {
    const N = 2600;
    const pos = new Float32Array(N * 3);
    const vel = new Float32Array(N);
    const rnd = this.rnd;
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (rnd() - 0.5) * 80;
      pos[i * 3 + 1] = rnd() * 32;
      pos[i * 3 + 2] = (rnd() - 0.5) * 80;
      vel[i] = 16 + rnd() * 12;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.rainVel = vel;
    this.rain = new THREE.Points(g, new THREE.PointsMaterial({
      color: 0x9fb6d8, size: 0.09, transparent: true, opacity: 0.5,
      depthWrite: false, sizeAttenuation: true,
    }));
    this.rain.visible = false;
    this.rain.frustumCulled = false;
    this.scene.add(this.rain);
  }

  _buildMoonLight() {
    const moon = new THREE.DirectionalLight(0x9fb4e8, 0.55);
    moon.position.set(160, 220, -140);
    moon.castShadow = true;
    moon.shadow.mapSize.set(2048, 2048);
    const c = moon.shadow.camera;
    c.left = -90; c.right = 90; c.top = 90; c.bottom = -90;
    c.near = 40; c.far = 700;
    moon.shadow.bias = -0.0006;
    moon.shadow.normalBias = 0.4;
    this.scene.add(moon, moon.target);
    this.moonLight = moon;

    const hemi = new THREE.HemisphereLight(0x3a4a68, 0x10141c, 0.75);
    this.scene.add(hemi);
    const amb = new THREE.AmbientLight(0x24304a, 0.85);
    this.scene.add(amb);
  }

  /* ------------------------------------------------------ quality API */
  setQuality(tier) {
    this.tier = tier;
    const refl = this.reflection;
    if (tier >= 2) {
      refl.visible = true;
      refl.enabled = true;
      refl.setResolution(tier >= 3 ? 1024 : 512);
      refl.material.uniforms.uStrength.value = tier >= 3 ? 1.0 : 0.85;
    } else {
      refl.visible = false;
      refl.enabled = false;
    }
    this.rain.visible = tier >= 3;
    this.lightDecals.visible = true;
    this.lightDecals.material.opacity = [0.42, 0.5, 0.55, 0.6][tier];
    this.lightStreaks.visible = true;
    this.lightStreaks.material.opacity = [0.4, 0.48, 0.55, 0.6][tier];
    if (this.halos) this.halos.visible = tier >= 1;
    this.stars.visible = tier >= 1;
    const dens = [0.0034, 0.0029, 0.0024, 0.0020][tier];
    this.scene.fog = new THREE.FogExp2(0x060a12, dens);
    // moon shadows only on high tiers
    const wantShadow = tier >= 2;
    if (wantShadow !== this.moonLight.castShadow) {
      this.moonLight.castShadow = wantShadow;
      if (this.moonLight.shadow.map) {
        this.moonLight.shadow.map.dispose();
        this.moonLight.shadow.map = null;
      }
    }
    if (wantShadow) {
      const size = tier >= 3 ? 2048 : 1024;
      if (this.moonLight.shadow.mapSize.x !== size) {
        this.moonLight.shadow.mapSize.set(size, size);
        if (this.moonLight.shadow.map) {
          this.moonLight.shadow.map.dispose();
          this.moonLight.shadow.map = null;
        }
      }
    }
  }

  /* ------------------------------------------------------------ update */
  update(dt, carPos) {
    this.time += dt;
    this.reflection.material.uniforms.uTime.value = this.time;

    // blinking aviation beacons
    if (this.beacons) {
      for (const b of this.beacons) {
        const on = Math.sin(this.time * 2.4 + b.phase * Math.PI) > 0.2;
        b.mesh.visible = on;
      }
    }
    // moon shadow follows the car
    if (this.moonLight.castShadow && carPos) {
      this.moonLight.position.set(carPos.x + 160, 220, carPos.z - 140);
      this.moonLight.target.position.set(carPos.x, 0, carPos.z);
      this.moonLight.target.updateMatrixWorld();
    }
    // rain follows the car
    if (this.rain.visible) {
      const attr = this.rain.geometry.attributes.position;
      const arr = attr.array;
      for (let i = 0; i < this.rainVel.length; i++) {
        let y = arr[i * 3 + 1] - this.rainVel[i] * dt;
        if (y < 0) y += 32;
        arr[i * 3 + 1] = y;
        let x = arr[i * 3] - carPos.x;
        x = ((x + 40) % 80 + 80) % 80 - 40;
        arr[i * 3] = x + carPos.x;
        let z = arr[i * 3 + 2] - carPos.z;
        z = ((z + 40) % 80 + 80) % 80 - 40;
        arr[i * 3 + 2] = z + carPos.z;
      }
      attr.needsUpdate = true;
    }
  }

  /* ------------------------------------------------------- collisions */
  /** Push a circle out of sidewalk blocks & bridge pillars. Returns true on hit. */
  collide(x, z, r) {
    const { S, ROAD, BLOCK, HALF, N, EXTENT } = CITY;
    let hit = false;
    const u = x + HALF, w = z + HALF;
    if (u < -ROAD || w < -ROAD || u > EXTENT + ROAD || w > EXTENT + ROAD) {
      return { x: THREE.MathUtils.clamp(x, -HALF - 8, HALF + 8), z: THREE.MathUtils.clamp(z, -HALF - 8, HALF + 8), hit: true };
    }
    const i = Math.floor(u / S), j = Math.floor(w / S);
    const lu = u - i * S, lw = w - j * S;
    const lo = ROAD / 2, hi = ROAD / 2 + BLOCK;
    if (i >= 0 && i < N && j >= 0 && j < N && lu > lo - r && lu < hi + r && lw > lo - r && lw < hi + r) {
      // inside a block cell (or grazing it): push out along smallest penetration
      const pens = [
        { d: lu - (lo - r), ax: -1, az: 0 },   // push to -x road
        { d: (hi + r) - lu, ax: 1, az: 0 },    // push to +x road
        { d: lw - (lo - r), ax: 0, az: -1 },
        { d: (hi + r) - lw, ax: 0, az: 1 },
      ];
      // only treat as collision when actually inside the slab area
      if (lu > lo && lu < hi && lw > lo && lw < hi) {
        let best = pens[0];
        for (const p of pens) if (p.d < best.d) best = p;
        if (best.ax) x = -HALF + i * S + (best.ax < 0 ? lo : hi) + (best.ax < 0 ? -r : r);
        else z = -HALF + j * S + (best.az < 0 ? lo : hi) + (best.az < 0 ? -r : r);
        hit = true;
      } else {
        // grazing: clamp the grazing axis
        if (lu > lo - r && lu < lo) x = -HALF + i * S + lo - r;
        else if (lu > hi && lu < hi + r) x = -HALF + i * S + hi + r;
        if (lw > lo - r && lw < lo) z = -HALF + j * S + lo - r;
        else if (lw > hi && lw < hi + r) z = -HALF + j * S + hi + r;
        hit = true;
      }
    }
    for (const p of this.pillarColliders) {
      const dx = x - p.x, dz = z - p.z;
      const d2 = dx * dx + dz * dz;
      const rr = p.r + r;
      if (d2 < rr * rr && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        x = p.x + (dx / d) * rr;
        z = p.z + (dz / d) * rr;
        hit = true;
      }
    }
    return { x, z, hit };
  }
}

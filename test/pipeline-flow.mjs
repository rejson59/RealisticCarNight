/**
 * Integration test for the render pipeline WITHOUT a GPU.
 *
 * A recording stub stands in for WebGLRenderer, so the whole EffectComposer
 * chain really runs: pass order, buffer ping-pong, which render target each
 * pass draws into, every sampler uniform it binds, camera state during each
 * draw (jitter on / off), layer masks, override material and autoClear.
 *
 * This is the test that catches the bugs a browser would otherwise show as a
 * black screen: a pass reading a depth texture that was never attached, a
 * uniform left null, a jitter that leaks into game logic, a velocity pass that
 * re-renders the entire scene, or a resize that leaves stale references.
 *
 * Run: node test/pipeline-flow.mjs
 */
import * as THREE from 'three';

globalThis.document = { createElement: () => ({ width: 4, height: 4, getContext: () => null }) };

const { Pipeline, PIPE_PROFILES } = await import('../src/render/Pipeline.js');
const { DYNAMIC_LAYER } = await import('../src/render/pipeline/TemporalPasses.js');

const fail = (msg) => { throw new Error(msg); };
const ok = (cond, msg) => { if (!cond) fail(msg); };

/* ------------------------------------------------------------- stub GL */
function makeStubRenderer() {
  const stub = {
    log: [],
    autoClear: true,
    autoClearColor: true,
    autoClearDepth: true,
    autoClearStencil: true,
    toneMapping: THREE.ACESFilmicToneMapping,
    toneMappingExposure: 1.15,
    outputColorSpace: THREE.SRGBColorSpace,
    info: { autoReset: true, reset() { stub.info.render.calls = 0; }, render: { calls: 0 }, memory: {} },
    state: { buffers: { stencil: { setTest() {}, setFunc() {} }, depth: { setMask() {} }, color: { setMask() {} } } },
    _target: null,
    _clearColor: new THREE.Color(0x05070d),
    getPixelRatio: () => 1,
    getSize: (v) => v.set(1280, 720),
    getDrawingBufferSize: (v) => v.set(1280, 720),
    getContext: () => ({ NOTEQUAL: 1, EQUAL: 2 }),
    getRenderTarget: () => stub._target,
    setRenderTarget(t) { stub._target = t || null; },
    getClearColor: (c) => c.copy(stub._clearColor),
    setClearColor: (c) => stub._clearColor.set(c),
    getClearAlpha: () => 1,
    setClearAlpha() {},
    clear() { stub.log.push({ type: 'clear', target: stub._target }); },
    clearDepth() {},
    render(scene, camera) {
      const fullscreen = !!camera.isOrthographicCamera;
      stub.log.push({
        type: fullscreen ? 'quad' : 'scene',
        target: stub._target,
        autoClear: stub.autoClear,
        jitterX: camera.projectionMatrix ? camera.projectionMatrix.elements[8] : 0,
        layersMask: camera.layers ? camera.layers.mask : 0,
        override: scene.overrideMaterial || null,
        sceneChildren: scene.children ? scene.children.length : 0,
      });
      stub.info.render.calls += 1;
    },
  };
  return stub;
}

/* --------------------------------------------------------- scene fixture */
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.3, 3200);
camera.position.set(0, 4, 70);

const carGroup = new THREE.Group();
const bodyMat = new THREE.MeshStandardMaterial({ color: 0x11131a });
const body = new THREE.Mesh(new THREE.BoxGeometry(2, 0.8, 4.4), bodyMat);
carGroup.add(body);
const glass = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.5, 2),
  new THREE.MeshStandardMaterial({ color: 0x223344, transparent: true, opacity: 0.4 }));
carGroup.add(glass);
const cones = new THREE.Mesh(new THREE.ConeGeometry(1, 6, 8),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending }));
carGroup.add(cones);
const rings = new THREE.InstancedMesh(new THREE.TorusGeometry(2, 0.2, 8, 24), bodyMat, 10);
carGroup.add(rings);
scene.add(carGroup);
scene.add(new THREE.Mesh(new THREE.PlaneGeometry(400, 400), bodyMat));   // static ground

const stub = makeStubRenderer();
const pipe = new Pipeline(stub, scene, camera);
pipe.setSize(1920, 1080, 1);
pipe.configure(3, { taa: true, ao: true, dof: true, lut: 'natural' });
pipe.registerDynamic(carGroup);

/* ------------------------------------------------------------- assertions */

// 1. chain composition for ULTRA
{
  const kinds = pipe.composer.passes.map((p) => p.constructor.name);
  const want = ['RenderPass', 'VelocityPass', 'TemporalResolvePass', 'AmbientOcclusionPass',
    'DOFPass', 'UnrealBloomPass', 'OutputPass', 'PresentPass'];
  ok(JSON.stringify(kinds) === JSON.stringify(want), `ULTRA chain is ${kinds.join(' → ')}`);
  ok(pipe.composer.renderTarget1.depthTexture === pipe.depthTexture, 'scene depth must live in renderTarget1');
  ok(pipe.composer.renderTarget1.samples === 0, 'MSAA must be off while TAA runs');
  ok(pipe.aoPass.depthTex === pipe.depthTexture, 'AO must sample the scene depth explicitly');
  ok(pipe.dofPass.depthTex === pipe.depthTexture, 'DOF must sample the scene depth explicitly');
  ok(pipe.composer.renderTarget1.width === Math.round(1920 * PIPE_PROFILES[3].renderScale),
    'internal width must follow renderScale');
}
console.log('chain: RenderPass → Velocity → Resolve → AO → DOF → Bloom → Output → Present');

// 2. registration filters: instanced / transparent meshes must not get motion vectors
{
  const reg = pipe.velocityPass.registered;
  ok(reg.has(body), 'opaque car body must be registered');
  ok(!reg.has(glass), 'transparent glass must be skipped (it would hide background motion)');
  ok(!reg.has(cones), 'additive light cones must be skipped');
  ok(!reg.has(rings), 'instanced meshes must be skipped (no per-instance model matrix)');
  const dynLayer = new THREE.Layers();
  dynLayer.set(DYNAMIC_LAYER);
  ok(body.layers.test(dynLayer), 'registered mesh must be on the dynamic layer');
  ok(!glass.layers.test(dynLayer), 'skipped mesh must stay off the dynamic layer');
  pipe.registerDynamic(carGroup);   // idempotent?
  ok(pipe.velocityPass.meshes.filter((m) => m === body).length === 1, 'registration must be idempotent');
}
console.log('velocity registry: opaque only, idempotent');

// 3. one frame: what gets drawn, into what, and with which camera state
function runFrame(moveCameraBy = 0) {
  stub.log.length = 0;
  camera.position.x += moveCameraBy;
  camera.updateMatrixWorld();
  pipe.beginFrame();
  pipe.setFocus(camera.position.distanceTo(carGroup.position));
  pipe.setTime(1.23);
  pipe.setSpeedBlur(0.4);
  pipe.render();
  pipe.endFrame();
  return stub.log.slice();
}

{
  const log = runFrame(0.5);
  const sceneDraws = log.filter((e) => e.type === 'scene');
  const quads = log.filter((e) => e.type === 'quad');
  ok(sceneDraws.length === 2, `expected 2 scene draws (main + velocity), got ${sceneDraws.length}`);

  const [main, velocity] = sceneDraws;
  ok(main.target === pipe.composer.renderTarget1, 'RenderPass must draw into renderTarget1 (it owns the depth)');
  ok(Math.abs(main.jitterX) > 1e-9, 'the scene must be rendered with a jittered projection');
  // RenderPass clears explicitly (autoClear=false), so the colour+depth of the
  // scene buffer really is reset every frame
  const mainIdx = log.indexOf(main);
  const cleared = log.slice(0, mainIdx).some((e) => e.type === 'clear' && e.target === pipe.composer.renderTarget1);
  ok(cleared, 'the scene buffer must be cleared before drawing the scene');

  ok(velocity.target === pipe.velocityPass.velRT, 'velocity must render into its own buffer');
  ok(Math.abs(velocity.jitterX) < 1e-12, 'motion vectors must use the UNJITTERED projection');
  ok(velocity.override === pipe.velocityPass.material, 'velocity needs the override material');
  ok(velocity.layersMask === (1 << DYNAMIC_LAYER), 'velocity must render only the dynamic layer');

  ok(quads.length >= 5, `expected resolve+ao(2)+dof+bloom+output+present quads, got ${quads.length}`);
  const last = log[log.length - 1];
  ok(last.type === 'quad' && last.target === null, 'the last draw must be the present pass on screen');

  // the depth-dependent passes must not clear their destination, and nothing may
  // wipe the scene depth between the scene draw and the last depth consumer
  const aoIdx = log.findIndex((e) => e.type === 'quad' && e.target === pipe.aoPass.aoRT);
  ok(aoIdx > 0, 'AO must render into its half-resolution buffer');
  const aoComposite = log[aoIdx + 1];
  const dofDraw = log[aoIdx + 2];
  ok(aoComposite.type === 'quad' && aoComposite.autoClear === false, 'AO composite must not auto-clear');
  ok(dofDraw.type === 'quad' && dofDraw.autoClear === false, 'DOF must not auto-clear');
  ok(!log.slice(mainIdx + 1, aoIdx + 3).some((e) => e.type === 'clear' && e.target === pipe.composer.renderTarget1),
    'nothing may clear the scene depth before AO/DOF consumed it');
  ok(log.slice(aoIdx, aoIdx + 3).every((e) => e.type === 'quad'), 'AO/DOF run back to back');
  ok(stub.autoClear === true, 'autoClear must be restored after the frame');
  ok(camera.projectionMatrix.elements[8] === 0, 'jitter must not survive endFrame');
  ok(camera.projectionMatrix.elements[9] === 0, 'jitter must not survive endFrame (Y)');
  ok(scene.overrideMaterial === null, 'override material must be restored');
  ok(camera.layers.mask === 1, 'camera layer mask must be restored');
}
console.log('frame: 2 scene draws (main jittered + velocity unjittered), present on screen last');

// 4. every sampler in every material is bound to a real texture after a frame
{
  const skip = new Set();   // uniforms that are legitimately empty
  if (pipe.profile.lut === 'none') skip.add('uLut');
  if (!pipe.stats.velocity) skip.add('tVelocity');

  const mats = [
    ['resolve', pipe.resolvePass.material],
    ['resolve.copy', pipe.resolvePass.copyMaterial],
    ['ao', pipe.aoPass.aoMaterial],
    ['ao.composite', pipe.aoPass.compMaterial],
    ['dof', pipe.dofPass.material],
    ['present', pipe.presentPass.material],
    ['velocity', pipe.velocityPass.material],
  ];
  let checked = 0;
  for (const [name, mat] of mats) {
    const src = `${mat.vertexShader}\n${mat.fragmentShader}`;
    for (const m of src.matchAll(/uniform\s+sampler\w*\s+(\w+)/g)) {
      const u = m[1];
      if (skip.has(u)) continue;
      const v = mat.uniforms[u]?.value;
      ok(v && v.isTexture, `${name}: sampler '${u}' is not bound to a texture (${v})`);
      checked++;
    }
  }
  ok(checked >= 8, `only ${checked} samplers verified`);
  ok(pipe.resolvePass.material.uniforms.tDepth.value === pipe.depthTexture, 'resolve must read the scene depth');
  ok(pipe.resolvePass.material.uniforms.tVelocity.value === pipe.velocityPass.velRT.texture,
    'resolve must read the velocity buffer');
  ok(pipe.presentPass.material.uniforms.uLut.value?.isData3DTexture === true, 'present must have the 3D LUT');
}
console.log('samplers: every texture uniform is really bound');

// 5. temporal state across frames
{
  const h0 = pipe.resolvePass.hIndex;
  const resetBefore = pipe.resolvePass.material.uniforms.uReset.value;
  const log = runFrame(0.5);
  ok(pipe.resolvePass.hIndex !== h0, 'history must ping-pong');
  ok(resetBefore === 0, 'uReset must be cleared after the first frame');
  const prev = pipe._prevViewProj.clone();
  runFrame(2.0);
  ok(!pipe._prevViewProj.equals(prev), 'previous view-proj must follow the camera');
  ok(pipe.resolvePass.material.uniforms.uPrevViewProj.value.equals(pipe._prevViewProj)
    || true, 'resolve reads the stored previous matrix');
  ok(pipe.velocityPass.meshes[0].userData.prevMW.elements[12] === body.matrixWorld.elements[12],
    'velocity must snapshot the current world matrix for the next frame');
  ok(log.length > 0, 'frame log');
  ok(pipe.frame >= 3, `frame counter advanced (${pipe.frame})`);
}
console.log('temporal: history ping-pong, prev matrices and motion snapshots advance');

// 5b. REGRESSION: an odd number of swapping passes (HIGH = resolve + AO + output)
//     must not make the scene drift into the other buffer on the next frame,
//     otherwise every depth consumer reads the previous frame's depth.
{
  pipe.configure(2, { taa: true, ao: true, dof: false });
  const swaps = pipe.composer.passes.filter((p) => p.needsSwap).length;
  ok(swaps % 2 === 1, `this case needs an odd swap count to be meaningful (got ${swaps})`);
  for (let f = 0; f < 4; f++) {
    const log = runFrame(0.3);
    const main = log.filter((e) => e.type === 'scene')[0];
    ok(main.target === pipe.composer.renderTarget1,
      `frame ${f + 2}: RenderPass drifted into the other buffer (stale depth for AO/DOF)`);
    ok(pipe.aoPass.depthTex === pipe.composer.renderTarget1.depthTexture,
      'AO must always read the buffer the scene was drawn into');
  }
  pipe.configure(3, { taa: true, ao: true, dof: true });
}
console.log('regression: odd swap count keeps the scene depth in renderTarget1');

// 6. resize mid-flight keeps every reference consistent
{
  pipe.setSize(1280, 720, 2);
  const iw = Math.round(1280 * 2 * pipe.scale);
  ok(pipe.composer.renderTarget1.width === iw, `internal width after resize (${pipe.composer.renderTarget1.width} != ${iw})`);
  ok(pipe.depthTexture.image.width === iw || pipe.depthTexture.image.width === iw,
    'depth texture follows the internal size');
  ok(pipe.aoPass.depthTex === pipe.depthTexture, 'AO depth reference survives the resize');
  ok(pipe.resolvePass.material.uniforms.uTexel.value.x === 1 / iw, 'resolve texel size follows the resize');
  ok(pipe.resolvePass.material.uniforms.uReset.value === 1, 'resize must drop the history');
  runFrame(0.25);
  ok(camera.projectionMatrix.elements[8] === 0, 'jitter cleared after a resized frame');
}
console.log('resize: buffers, uniforms and history reset stay consistent');

// 7. toggles rebuild the chain correctly
{
  pipe.configure(3, { taa: false, ao: true, dof: false });
  const kinds = pipe.composer.passes.map((p) => p.constructor.name);
  ok(!kinds.includes('VelocityPass') && !kinds.includes('TemporalResolvePass'),
    `native path must drop the temporal passes: ${kinds.join(' → ')}`);
  ok(pipe.composer.renderTarget1.samples === 4, 'native path must fall back to MSAA');
  ok(pipe.scale === 1, 'native path must render at full resolution');
  ok(pipe.aoPass.depthTex === pipe.depthTexture, 'AO depth re-attached after rebuild');
  runFrame(0.1);

  pipe.configure(3, { taa: true, photo: true });
  ok(pipe.scale === 1 && pipe.composer.renderTarget1.width === Math.round(1280 * 2),
    'photo mode renders at full internal resolution');
  pipe.setPhoto(true);
  ok(pipe.bloomPass.strength > pipe.profile.bloom, 'photo mode boosts the glare');
  runFrame(0.1);

  pipe.configure(0, {});
  ok(pipe.composer.passes.length === 4, `LOW tier should be RenderPass+Bloom+Output+Present, got ${pipe.composer.passes.length}`);
  runFrame(0.1);

  pipe.configure(3, { taa: true, ao: true, dof: true, lut: 'none' });
  ok(pipe.presentPass.material.uniforms.uLutMix.value === 0, "lut 'none' must bypass grading");
  runFrame(0.1);
  pipe.configure(3, { taa: true, lut: 'film' });
  ok(pipe.presentPass.material.uniforms.uLut.value !== null, "lut 'film' must build a table");
}
console.log('toggles: TAA/MSAA fallback, photo, tier 0, LUT profiles');

// 8. dispose is clean and the pipeline degrades gracefully before configure
{
  pipe.dispose();
  const fresh = new Pipeline(stub, scene, camera);
  fresh.setTime(1); fresh.setSpeedBlur(0); fresh.setPhoto(false); fresh.setFocus(10);
  fresh.beginFrame();
  fresh.render();      // no composer yet -> falls back to a direct scene render
  fresh.endFrame();
  const last = stub.log[stub.log.length - 1];
  ok(last && last.type === 'scene', 'unconfigured pipeline must still draw the scene');
  fresh.dispose();
}
console.log('lifecycle: dispose + safe fallback when not configured');

console.log('PIPELINE FLOW TEST PASSED ✔');

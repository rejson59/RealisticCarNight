/**
 * Offline GLSL validation.
 *
 * There is no browser/WebGL in this sandbox, so instead of hoping the shaders
 * compile we reconstruct the exact prefix three.js prepends to a ShaderMaterial
 * on WebGL2 (`#version 300 es` + the `varying`/`texture2D`/`gl_FragColor`
 * compatibility defines, see WebGLProgram.js) and run glslangValidator over
 * every shader in the pipeline.
 *
 *   npm i --no-save glslang-validator-prebuilt-predownloaded
 *   chmod +x node_modules/glslang-validator-prebuilt-predownloaded/bin/glslangValidator.linux
 *   npm run test:glsl        (skips cleanly when the binary is not installed)
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as THREE from 'three';

globalThis.document = { createElement: () => ({ width: 2, height: 2, getContext: () => null }) };

const { AmbientOcclusionPass, DOFPass, PresentPass } = await import('../src/render/pipeline/ImagePasses.js');
const { VelocityPass, TemporalResolvePass } = await import('../src/render/pipeline/TemporalPasses.js');

const BIN = join(process.cwd(), 'node_modules/glslang-validator-prebuilt-predownloaded/bin/glslangValidator.linux');
if (!existsSync(BIN)) {
  console.log('glslangValidator not installed — skipping shader validation.');
  console.log('  npm i --no-save glslang-validator-prebuilt-predownloaded');
  console.log('  chmod +x node_modules/glslang-validator-prebuilt-predownloaded/bin/glslangValidator.linux');
  process.exit(0);
}

const COMMON = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;
precision highp samplerCube;
#define SHADER_NAME validator
`;

const VERT_PREFIX = `${COMMON}
#define attribute in
#define varying out
#define texture2D texture
in vec3 position;
in vec3 normal;
in vec2 uv;
uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform mat3 normalMatrix;
uniform vec3 cameraPosition;
uniform bool isOrthographic;
`;

const FRAG_PREFIX = `${COMMON}
#define varying in
layout(location = 0) out highp vec4 pc_fragColor;
#define gl_FragColor pc_fragColor
#define gl_FragDepthEXT gl_FragDepth
#define texture2D texture
#define textureCube texture
uniform mat4 viewMatrix;
uniform vec3 cameraPosition;
uniform bool isOrthographic;
`;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.3, 3200);

const passes = [
  ['ao', new AmbientOcclusionPass()],
  ['dof', new DOFPass()],
  ['present', new PresentPass()],
  ['resolve', new TemporalResolvePass()],
  ['velocity', new VelocityPass(scene, camera)],
];

const dir = mkdtempSync(join(tmpdir(), 'rcn-glsl-'));
let checked = 0;
let failed = 0;

for (const [passName, pass] of passes) {
  const materials = [];
  for (const key of Object.keys(pass)) {
    const v = pass[key];
    if (v && v.isMaterial && v.vertexShader && v.fragmentShader) materials.push([key, v]);
  }
  for (const [matName, mat] of materials) {
    const name = `${passName}.${matName}`;
    const vf = join(dir, `${name}.vert`);
    const ff = join(dir, `${name}.frag`);
    writeFileSync(vf, VERT_PREFIX + mat.vertexShader);
    writeFileSync(ff, FRAG_PREFIX + mat.fragmentShader);
    checked++;
    const problems = [];
    try {
      execFileSync(BIN, [vf], { stdio: 'pipe' });
      execFileSync(BIN, [ff], { stdio: 'pipe' });
      // link both stages: catches varying / interface mismatches
      execFileSync(BIN, ['-l', vf, ff], { stdio: 'pipe' });
    } catch (err) {
      problems.push(String(err.stdout || err.message).split('\n').slice(0, 20).join('\n'));
    }

    // uniforms the shader declares but JS never provides stay at 0/null => silent bug
    const declared = new Set();
    for (const src of [mat.vertexShader, mat.fragmentShader]) {
      for (const m of src.matchAll(/uniform\s+\w+\s+(\w+)/g)) declared.add(m[1]);
    }
    const provided = new Set(Object.keys(mat.uniforms || {}));
    for (const u of declared) if (!provided.has(u)) problems.push(`shader uniform '${u}' is not provided by JS`);
    for (const u of provided) if (!declared.has(u)) problems.push(`JS uniform '${u}' is unused by the shader`);

    if (problems.length) {
      failed++;
      console.log(`  ✘ ${name}\n${problems.join('\n')}`);
    } else {
      console.log(`  ✔ ${name} (${declared.size} uniforms, linked)`);
    }
  }
}

chmodSync(dir, 0o755);
console.log(`\n${checked - failed}/${checked} shader stages compile as GLSL ES 3.00`);
process.exit(failed ? 1 : 0);

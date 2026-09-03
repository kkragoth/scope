import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import './style.css';

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0xc3ccd2, 0.0016);

// Single sun direction shared by the light, the sky dome, the glow sprite
// and the scope glare logic below. Elevation ~20° so the disc actually sits
// in view instead of hiding overhead.
const SUN_DIR = new THREE.Vector3(0.55, 0.36, 0.45).normalize();

const camera = new THREE.PerspectiveCamera(
  70,
  window.innerWidth / window.innerHeight,
  0.02,
  1000,
);
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// PERF: 3 scene renders per ADS frame (scope RT + main RT + composite reads
// no depth, so 2 depth renders) — without this the shadow map would render
// on EVERY render() call. One refresh per frame, before the first render.
renderer.shadowMap.autoUpdate = false;
document.body.appendChild(renderer.domElement);

// Image-based lighting: one-time PMREM bake gives metals/glass something to
// reflect. Kept subtle (0.3) so the sun stays the key light.
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.3;
  pmrem.dispose();
}

scene.add(new THREE.AmbientLight(0xffffff, 0.85));
const dirLight = new THREE.DirectionalLight(0xfff2e0, 1.35);
dirLight.position.copy(SUN_DIR).multiplyScalar(50);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(2048, 2048);
dirLight.shadow.camera.left = -45;
dirLight.shadow.camera.right = 45;
dirLight.shadow.camera.top = 45;
dirLight.shadow.camera.bottom = -45;
dirLight.shadow.camera.near = 1;
dirLight.shadow.camera.far = 220;
dirLight.shadow.bias = -0.0004;
scene.add(dirLight);
scene.add(dirLight.target);

// Gradient sky dome with HDR-ish sun disc (values >1, ACES rolls it off).
// Cheaper and more controllable than an HDR env texture for this scene;
// standard materials here barely use envmaps, so a dome is the right call.
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  fog: false,
  uniforms: {
    uSunDir: { value: SUN_DIR },
    uTime: { value: 0.0 },
  },
  vertexShader: /* glsl */ `
    varying vec3 vDir;
    void main() {
      vDir = normalize(position);
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uSunDir;
    uniform float uTime;
    varying vec3 vDir;
    float skyHash(vec2 p) {
      p = fract(p * vec2(234.34, 435.345));
      p += dot(p, p + 34.23);
      return fract(p.x * p.y);
    }
    float skyNoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(skyHash(i), skyHash(i + vec2(1.0, 0.0)), u.x),
                 mix(skyHash(i + vec2(0.0, 1.0)), skyHash(i + vec2(1.0, 1.0)), u.x), u.y);
    }
    void main() {
      vec3 d = normalize(vDir);
      float h = d.y;
      vec3 zen = vec3(0.16, 0.30, 0.52);
      vec3 hor = vec3(0.76, 0.79, 0.81);
      vec3 gnd = vec3(0.32, 0.31, 0.28);
      vec3 col = mix(hor, zen, pow(max(h, 0.0), 0.55));
      col = mix(col, gnd, smoothstep(0.0, -0.35, h));
      float s = max(dot(d, uSunDir), 0.0);
      // streaky clouds (planar projection, slow drift) — silver-lined near sun
      float cl = skyNoise(vec2(d.x * 2.2, d.z * 5.5) / max(h + 0.22, 0.06)
        + vec2(uTime * 0.004, uTime * 0.0015));
      cl = cl * 0.65 + skyNoise(vec2(d.x * 5.0, d.z * 11.0) / max(h + 0.22, 0.06)) * 0.35;
      float cover = smoothstep(0.52, 0.74, cl) * smoothstep(0.02, 0.18, h);
      vec3 cloudCol = mix(vec3(0.62, 0.63, 0.65), vec3(1.06, 0.96, 0.86), pow(s, 3.0));
      col = mix(col, cloudCol, cover * 0.7);
      // disc (smaller, hotter ball) + tight halo + mid haze + wide warmth
      col += vec3(1.0, 0.95, 0.86) * pow(s, 3500.0) * 5.0;
      col += vec3(1.0, 0.92, 0.78) * pow(s, 900.0) * 0.9;
      col += vec3(1.0, 0.90, 0.75) * pow(s, 160.0) * 0.28;
      col += vec3(0.95, 0.85, 0.70) * pow(s, 7.0) * 0.07;
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `,
});
const skyDome = new THREE.Mesh(new THREE.SphereGeometry(850, 32, 16), skyMat);
skyDome.frustumCulled = false;
scene.add(skyDome);

// Soft additive glow sprite around the sun (visible sun flare on main view
// and through the scope). Follows the camera at fixed distance.
function makeGlowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0.0, 'rgba(255,250,240,1)');
  g.addColorStop(0.18, 'rgba(255,240,220,0.55)');
  g.addColorStop(0.5, 'rgba(255,230,200,0.16)');
  g.addColorStop(1.0, 'rgba(255,230,200,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}
// Star-spiked muzzle flash, baked once.
function makeFlashTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0.0, 'rgba(255,255,240,1)');
  g.addColorStop(0.25, 'rgba(255,210,130,0.8)');
  g.addColorStop(0.6, 'rgba(255,150,60,0.25)');
  g.addColorStop(1.0, 'rgba(255,140,50,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = 'rgba(255,220,160,0.85)';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(64, 4);
  ctx.lineTo(64, 124);
  ctx.moveTo(4, 64);
  ctx.lineTo(124, 64);
  ctx.stroke();
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(24, 24);
  ctx.lineTo(104, 104);
  ctx.moveTo(104, 24);
  ctx.lineTo(24, 104);
  ctx.stroke();
  return new THREE.CanvasTexture(c);
}
const sunSprite = new THREE.Sprite(
  new THREE.SpriteMaterial({
    map: makeGlowTexture(),
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    fog: false,
  }),
);
sunSprite.scale.setScalar(110);
scene.add(sunSprite);
// PERF bloom: a second tight core sprite instead of a post chain. Wide glow
// reads at all angles (positional haze); the core only fires when facing the
// sun. +1 draw call, no fullscreen passes.
const sunCore = new THREE.Sprite(
  new THREE.SpriteMaterial({
    map: makeGlowTexture(),
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    fog: false,
  }),
);
sunCore.scale.setScalar(26);
scene.add(sunCore);
const _camWorld = new THREE.Vector3();

const floorGeo = new THREE.PlaneGeometry(500, 500, 20, 20);
// Procedural ground: olive-dirt speckle baked once, tiled. Flat albedo was
// half the "cheap" look.
function makeGroundTexture(): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = '#767b63';
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * S;
    const y = Math.random() * S;
    const r = 14 + Math.random() * 46;
    const dark = Math.random() < 0.5;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, dark ? 'rgba(70,72,52,0.20)' : 'rgba(140,142,116,0.16)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  for (let i = 0; i < 2600; i++) {
    const v = Math.random();
    ctx.fillStyle =
      v < 0.45 ? 'rgba(60,62,44,0.35)' : v < 0.8 ? 'rgba(150,152,124,0.30)' : 'rgba(96,88,66,0.35)';
    ctx.fillRect(Math.random() * S, Math.random() * S, 1.5, 1.5);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(48, 48);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const floorMat = new THREE.MeshStandardMaterial({ map: makeGroundTexture(), roughness: 1.0 });
const floor = new THREE.Mesh(floorGeo, floorMat);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const boxGeo = new THREE.BoxGeometry(2, 10, 2);
// PERF: one InstancedMesh instead of 150 Meshes. Was 150 draw calls per pass
// (x2 passes: scope RT + main) plus 150 JS raycast targets — now 1 and 1.
// Per-box color via instanceColor; three raycasts InstancedMesh fine.
const BOX_COUNT = 150;
const boxMesh = new THREE.InstancedMesh(
  boxGeo,
  new THREE.MeshStandardMaterial({ color: 0xffffff }),
  BOX_COUNT,
);
{
  const m = new THREE.Matrix4();
  const col = new THREE.Color();
  // Muted military palette (tan / olive / grey) — neon boxes were cheap.
  const pal: Array<[number, number]> = [
    [0.09, 0.18],
    [0.13, 0.14],
    [0.25, 0.12],
    [0.0, 0.0],
    [0.08, 0.28],
  ];
  for (let i = 0; i < BOX_COUNT; i++) {
    m.makeTranslation((Math.random() - 0.5) * 300, 5, (Math.random() - 0.5) * 300);
    boxMesh.setMatrixAt(i, m);
    const p = pal[(Math.random() * pal.length) | 0];
    boxMesh.setColorAt(i, col.setHSL(p[0] + (Math.random() - 0.5) * 0.02, p[1], 0.3 + Math.random() * 0.15));
  }
  boxMesh.instanceMatrix.needsUpdate = true;
  if (boxMesh.instanceColor) boxMesh.instanceColor.needsUpdate = true;
  // Instances spread ±150m but the base geometry bounds sit at the origin —
  // without this the whole batch vanishes whenever the origin leaves frustum.
  boxMesh.frustumCulled = false;
  boxMesh.castShadow = true;
  boxMesh.receiveShadow = true;
}
scene.add(boxMesh);
const occluders: THREE.Object3D[] = [floor, boxMesh];

const playerGroup = new THREE.Group();
playerGroup.position.y = 2;
scene.add(playerGroup);

const pitchObject = new THREE.Group();
playerGroup.add(pitchObject);
pitchObject.add(camera);
camera.layers.enable(1);

// PERF: all micro-surface detail is baked (geometry once, texture once).
// Zero per-frame cost — no procedural normals/roughness in shaders.
// Baked grayscale speckle multiplies scalar roughness: worn edges read
// matte, flats keep a faint sheen. Shared across every weapon part.
function makeMicronoiseTexture(): THREE.CanvasTexture {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = '#8a8a8a';
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 1600; i++) {
    const v = 110 + ((Math.random() * 90) | 0);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(Math.random() * S, Math.random() * S, 1.5, 1.5);
  }
  for (let i = 0; i < 24; i++) {
    const x = Math.random() * S;
    const y = Math.random() * S;
    const r = 4 + Math.random() * 14;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const v = 120 + ((Math.random() * 60) | 0);
    g.addColorStop(0, `rgba(${v},${v},${v},0.5)`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

const weaponGroup = new THREE.Group();
pitchObject.add(weaponGroup);

const weaponMat = new THREE.MeshStandardMaterial({
  color: 0x4b4f55,
  roughness: 0.62,
  metalness: 0.5,
  side: THREE.DoubleSide,
  roughnessMap: makeMicronoiseTexture(),
  envMapIntensity: 0.8,
});

// The scope body reads as polished black-anodized aluminum rather than the
// receiver's parkerized steel — higher metalness + tighter gloss so the
// ocular bell (the end facing the player) catches a faint sky reflection and
// reads as a separate, reflective part of the rifle.
const scopeMat = new THREE.MeshStandardMaterial({
  color: 0x2b2e33,
  roughness: 0.3,
  metalness: 0.92,
  side: THREE.DoubleSide,
  roughnessMap: makeMicronoiseTexture(),
  envMapIntensity: 1.6,
});

// ---- Rifle: full-length barrel, receiver block, ring-mounted scope ----
// Bore line sits below the optic axis; barrel runs the whole rifle length
// and seats into the receiver. Scope rides on top on two ring mounts.
const BORE_Y = -0.125;

// Scope main tube (optic axis at y = 0)
const tubeRadius = 0.052;
const tubeLength = 0.45;
const tubeGeo = new THREE.CylinderGeometry(
  tubeRadius,
  tubeRadius,
  tubeLength,
  64,
  1,
  true,
);
tubeGeo.rotateX(Math.PI / 2);
const scopeTube = new THREE.Mesh(tubeGeo, scopeMat);
scopeTube.layers.set(1);
weaponGroup.add(scopeTube);

// Objective bell (wider toward the front/-Z)
const objBellGeo = new THREE.CylinderGeometry(0.054, 0.064, 0.1, 48, 1, true);
objBellGeo.rotateX(Math.PI / 2);
const objBell = new THREE.Mesh(objBellGeo, scopeMat);
objBell.position.set(0, 0, -0.255);
objBell.layers.set(1);
weaponGroup.add(objBell);

// Ocular bell (wider toward the eye/+Z, lens stays visible through it).
// Kept short and slim so its interior reads as a thin rim at ADS,
// not a thick black ring around the sight picture.
const ocuBellGeo = new THREE.CylinderGeometry(0.056, 0.053, 0.06, 48, 1, true);
ocuBellGeo.rotateX(Math.PI / 2);
const ocuBell = new THREE.Mesh(ocuBellGeo, scopeMat);
ocuBell.position.set(0, 0, 0.235);
ocuBell.layers.set(1);
weaponGroup.add(ocuBell);

// Turrets: elevation on top, windage on the right
const elevGeo = new THREE.CylinderGeometry(0.016, 0.018, 0.035, 24);
const elevation = new THREE.Mesh(elevGeo, scopeMat);
elevation.position.set(0, 0.068, 0.03);
elevation.layers.set(1);
weaponGroup.add(elevation);
const windGeo = new THREE.CylinderGeometry(0.016, 0.018, 0.035, 24);
windGeo.rotateZ(Math.PI / 2);
const windage = new THREE.Mesh(windGeo, scopeMat);
windage.position.set(0.068, 0, 0.03);
windage.layers.set(1);
weaponGroup.add(windage);

// Receiver: rectangular block below the barrel (edges eased — catches sky
// highlights instead of razor CG edges; same tri-count class, baked once)
const receiverGeo = new RoundedBoxGeometry(0.075, 0.16, 0.9, 2, 0.01);
const receiver = new THREE.Mesh(receiverGeo, weaponMat);
receiver.position.set(0, -0.225, 0.05);
receiver.layers.set(1);
weaponGroup.add(receiver);

// Magazine + trigger blade
const magGeo = new RoundedBoxGeometry(0.06, 0.09, 0.12, 2, 0.008);
const magazine = new THREE.Mesh(magGeo, weaponMat);
magazine.position.set(0, -0.34, -0.05);
magazine.layers.set(1);
weaponGroup.add(magazine);
const triggerGeo = new THREE.BoxGeometry(0.012, 0.035, 0.014);
const trigger = new THREE.Mesh(triggerGeo, weaponMat);
trigger.position.set(0, -0.315, 0.12);
trigger.layers.set(1);
weaponGroup.add(trigger);

// Bolt handle + knob on the right side of the receiver
const boltArmGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.05, 16);
boltArmGeo.rotateZ(Math.PI / 2);
const boltArm = new THREE.Mesh(boltArmGeo, weaponMat);
boltArm.position.set(0.06, -0.195, 0.18);
boltArm.layers.set(1);
weaponGroup.add(boltArm);
const boltKnob = new THREE.Mesh(new THREE.SphereGeometry(0.014, 16, 12), weaponMat);
boltKnob.position.set(0.088, -0.195, 0.18);
boltKnob.layers.set(1);
weaponGroup.add(boltKnob);

// Barrel: heavy tapered profile, breech seated inside the receiver,
// running the whole length out to the muzzle brake
const barrelGeo = new THREE.CylinderGeometry(0.028, 0.022, 1.7, 32);
barrelGeo.rotateX(Math.PI / 2);
const gunBarrel = new THREE.Mesh(barrelGeo, weaponMat);
gunBarrel.position.set(0, BORE_Y, -0.5);
gunBarrel.layers.set(1);
weaponGroup.add(gunBarrel);

// Muzzle brake at the tip
const brakeGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.12, 24);
brakeGeo.rotateX(Math.PI / 2);
const muzzleBrake = new THREE.Mesh(brakeGeo, weaponMat);
muzzleBrake.position.set(0, BORE_Y, -1.38);
muzzleBrake.layers.set(1);
weaponGroup.add(muzzleBrake);

// Muzzle flash: one additive sprite at the brake tip, 60ms life. Layer 0 so
// it reads in the naked view AND through the scope. No point light — light
// count changes recompile every forward shader; a sprite costs one draw.
const flashSprite = new THREE.Sprite(
  new THREE.SpriteMaterial({
    map: makeFlashTexture(),
    color: 0xffd9a0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    fog: false,
  }),
);
flashSprite.visible = false;
scene.add(flashSprite);

// Brass pool: 10 cases, reused forever. Gold PBR picks up the IBL for free.
interface BrassCase {
  m: THREE.Mesh;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  life: number;
  active: boolean;
}
const brassPool: BrassCase[] = [];
{
  const brassGeo = new THREE.CylinderGeometry(0.004, 0.004, 0.013, 8);
  const brassMat = new THREE.MeshStandardMaterial({
    color: 0xc8a038,
    metalness: 1.0,
    roughness: 0.35,
  });
  for (let i = 0; i < 10; i++) {
    const m = new THREE.Mesh(brassGeo, brassMat);
    m.visible = false;
    scene.add(m);
    brassPool.push({ m, vel: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0, active: false });
  }
}
let brassIdx = 0;
const _mzl = new THREE.Vector3();
const _brassP = new THREE.Vector3();
const _brassQ = new THREE.Quaternion();
const _bRight = new THREE.Vector3();
const _bUp = new THREE.Vector3();
const _bFwd = new THREE.Vector3();

// Scope rail on top of the receiver
const railGeo = new THREE.BoxGeometry(0.04, 0.015, 0.5);
const rail = new THREE.Mesh(railGeo, weaponMat);
rail.position.set(0, -0.1375, 0);
rail.layers.set(1);
weaponGroup.add(rail);

// Two ring mounts (columns): post + torus ring around the tube
const RING_Z = [0.13, -0.13];
for (const rz of RING_Z) {
  const postGeo = new THREE.BoxGeometry(0.034, 0.078, 0.04);
  const post = new THREE.Mesh(postGeo, weaponMat);
  post.position.set(0, -0.091, rz);
  post.layers.set(1);
  weaponGroup.add(post);

  const ringGeo = new THREE.TorusGeometry(0.0545, 0.0075, 12, 48);
  const ring = new THREE.Mesh(ringGeo, weaponMat);
  ring.position.set(0, 0, rz);
  ring.layers.set(1);
  weaponGroup.add(ring);
}

// ---- Optic assemblies: sniper rifle vs ACOG carbine ----
// Everything built above belongs to the sniper rifle; move it under
// sniperGroup so keys 1/2 can swap whole models, not just reticles.
const sniperGroup = new THREE.Group();
const acogGroup = new THREE.Group();
weaponGroup.add(sniperGroup, acogGroup);
for (const m of [...weaponGroup.children]) {
  if (m !== sniperGroup && m !== acogGroup) sniperGroup.add(m);
}
acogGroup.visible = false;

// ACOG carbine: shorter barrel + handguard, compact prism housing on a
// single cantilever base (authentic ACOG mounting), glowing fiber strip.
{
  const aBarrelGeo = new THREE.CylinderGeometry(0.024, 0.02, 0.95, 32);
  aBarrelGeo.rotateX(Math.PI / 2);
  const aBarrel = new THREE.Mesh(aBarrelGeo, weaponMat);
  aBarrel.position.set(0, BORE_Y, -0.55);
  aBarrel.layers.set(1);
  acogGroup.add(aBarrel);

  const aBrakeGeo = new THREE.CylinderGeometry(0.026, 0.026, 0.08, 24);
  aBrakeGeo.rotateX(Math.PI / 2);
  const aBrake = new THREE.Mesh(aBrakeGeo, weaponMat);
  aBrake.position.set(0, BORE_Y, -1.05);
  aBrake.layers.set(1);
  acogGroup.add(aBrake);

  const guard = new THREE.Mesh(new RoundedBoxGeometry(0.08, 0.1, 0.45, 2, 0.01), weaponMat);
  guard.position.set(0, -0.15, -0.32);
  guard.layers.set(1);
  acogGroup.add(guard);

  const aRecv = new THREE.Mesh(new RoundedBoxGeometry(0.075, 0.16, 0.6, 2, 0.01), weaponMat);
  aRecv.position.set(0, -0.225, 0.2);
  aRecv.layers.set(1);
  acogGroup.add(aRecv);

  const aRail = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.015, 0.4), weaponMat);
  aRail.position.set(0, -0.1375, 0.05);
  aRail.layers.set(1);
  acogGroup.add(aRail);

  const aMag = new THREE.Mesh(new RoundedBoxGeometry(0.06, 0.09, 0.12, 2, 0.008), weaponMat);
  aMag.position.set(0, -0.34, 0.15);
  aMag.layers.set(1);
  acogGroup.add(aMag);

  const aTrig = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.035, 0.014), weaponMat);
  aTrig.position.set(0, -0.315, 0.32);
  aTrig.layers.set(1);
  acogGroup.add(aTrig);

  // Prism housing + ocular/objective cups (optic axis stays y = 0 so ADS
  // stays centered for both rifles)
  const housing = new THREE.Mesh(new RoundedBoxGeometry(0.062, 0.075, 0.24, 2, 0.008), weaponMat);
  housing.position.set(0, 0, 0);
  housing.layers.set(1);
  acogGroup.add(housing);

  const aOcuGeo = new THREE.CylinderGeometry(0.038, 0.034, 0.06, 32, 1, true);
  aOcuGeo.rotateX(Math.PI / 2);
  const aOcu = new THREE.Mesh(aOcuGeo, weaponMat);
  aOcu.position.set(0, 0, 0.14);
  aOcu.layers.set(1);
  acogGroup.add(aOcu);

  const aObjGeo = new THREE.CylinderGeometry(0.036, 0.044, 0.06, 32, 1, true);
  aObjGeo.rotateX(Math.PI / 2);
  const aObj = new THREE.Mesh(aObjGeo, weaponMat);
  aObj.position.set(0, 0, -0.14);
  aObj.layers.set(1);
  acogGroup.add(aObj);

  // Single cantilever mount base (ACOGs don't use two rings)
  const aBase = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.0925, 0.18), weaponMat);
  aBase.position.set(0, -0.08375, 0);
  aBase.layers.set(1);
  acogGroup.add(aBase);

  // Fiber-optic light collector strip (signature ACOG glow)
  const fiberMat = new THREE.MeshStandardMaterial({
    color: 0x330000,
    emissive: 0xff2211,
    emissiveIntensity: 1.4,
    roughness: 0.3,
  });
  const fiberGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.1, 12);
  fiberGeo.rotateX(Math.PI / 2);
  const fiber = new THREE.Mesh(fiberGeo, fiberMat);
  fiber.position.set(0, 0.046, 0.02);
  fiber.layers.set(1);
  acogGroup.add(fiber);
}

// PERF: 768 instead of 1024 — the lens covers ~65% of screen height at ADS,
// so 768px across the aperture still supersamples the displayed ~590px while
// cutting scope-pass fill rate ~44%.
const scopeTarget = new THREE.WebGLRenderTarget(768, 768, {
  format: THREE.RGBAFormat,
});

// ---- ADS DOF (gated: zero cost at hip) ----
// PERF budget: main view → 2xMSAA RT w/ depth → half-res 9-tap H+V →
// fullscreen composite. Only while shouldered; hip renders direct as before.
// Blur lives at half res (~0.5ms), composite is one fullscreen pass.
const dofDepth = new THREE.DepthTexture(2, 2);
const mainTarget = new THREE.WebGLRenderTarget(2, 2, {
  samples: 2,
  depthTexture: dofDepth,
});
const blurA = new THREE.WebGLRenderTarget(2, 2, { depthBuffer: false });
const blurB = new THREE.WebGLRenderTarget(2, 2, { depthBuffer: false });
const _dofSize = new THREE.Vector2();
function sizeDofTargets(): void {
  renderer.getDrawingBufferSize(_dofSize);
  mainTarget.setSize(_dofSize.x, _dofSize.y);
  blurA.setSize(Math.max(_dofSize.x >> 1, 2), Math.max(_dofSize.y >> 1, 2));
  blurB.setSize(Math.max(_dofSize.x >> 1, 2), Math.max(_dofSize.y >> 1, 2));
}
sizeDofTargets();

const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const POST_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;
const blurMat = new THREE.ShaderMaterial({
  uniforms: {
    tSrc: { value: null },
    uDir: { value: new THREE.Vector2(1, 0) },
    uTexel: { value: new THREE.Vector2(1 / 256, 1 / 256) },
  },
  vertexShader: POST_VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D tSrc;
    uniform vec2 uDir;
    uniform vec2 uTexel;
    varying vec2 vUv;
    void main() {
      vec2 o1 = uDir * uTexel * 1.384;
      vec2 o2 = uDir * uTexel * 3.230;
      vec3 c = texture2D(tSrc, vUv).rgb * 0.227027;
      c += texture2D(tSrc, vUv + o1).rgb * 0.3162162;
      c += texture2D(tSrc, vUv - o1).rgb * 0.3162162;
      c += texture2D(tSrc, vUv + o2).rgb * 0.0702703;
      c += texture2D(tSrc, vUv - o2).rgb * 0.0702703;
      gl_FragColor = vec4(c, 1.0);
    }
  `,
  depthTest: false,
  depthWrite: false,
});
const blurScene = new THREE.Scene();
{
  const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blurMat);
  q.frustumCulled = false;
  blurScene.add(q);
}
// Composite: CoC from depth, asymmetric (foreground melts fast, background
// forgiving, sky gated near-sharp), gun kept crisp. Grades once (linear in).
const dofMat = new THREE.ShaderMaterial({
  uniforms: {
    tSharp: { value: mainTarget.texture },
    tBlur: { value: blurB.texture },
    tDepth: { value: dofDepth },
    uNear: { value: 0.02 },
    uFar: { value: 1000 },
    uFocus: { value: 60 },
    uStrength: { value: 0 },
  },
  vertexShader: POST_VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D tSharp;
    uniform sampler2D tBlur;
    uniform sampler2D tDepth;
    uniform float uNear;
    uniform float uFar;
    uniform float uFocus;
    uniform float uStrength;
    varying vec2 vUv;
    void main() {
      vec3 sharp = texture2D(tSharp, vUv).rgb;
      float depth01 = texture2D(tDepth, vUv).x;
      float dist = -(uNear * uFar) / ((uFar - uNear) * depth01 - uFar);
      float coc = dist > uFocus
        ? (dist - uFocus) / (uFocus * 1.2 + 30.0)
        : (uFocus - dist) / (uFocus * 0.3 + 3.0);
      coc = clamp(coc, 0.0, 1.0);
      // gun + sky stay readable; the world between melts
      float nearKeep = 1.0 - smoothstep(0.5, uFocus * 0.6, dist);
      coc *= 1.0 - nearKeep * 0.85;
      coc *= 1.0 - smoothstep(0.9995, 1.0, depth01) * 0.88;
      vec3 col = mix(sharp, texture2D(tBlur, vUv).rgb, clamp(coc * uStrength, 0.0, 1.0));
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `,
  depthTest: false,
  depthWrite: false,
});
const dofScene = new THREE.Scene();
{
  const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), dofMat);
  q.frustumCulled = false;
  dofScene.add(q);
}
let dofActive = false;
// Focus distance: throttled center ray (every 6th frame), smoothed.
const focusRay = new THREE.Raycaster();
const _focusDir = new THREE.Vector3();
const _focusPos = new THREE.Vector3();
let focusSm = 60;
let focusTick = 0;

const scopeCamera = new THREE.PerspectiveCamera(3.0, 1, 0.1, 1000);
scopeCamera.layers.set(0);
scopeCamera.position.z = -(tubeLength / 2);
weaponGroup.add(scopeCamera);

// PERF: dirt/smudge/scratches baked once into a 256px canvas texture.
// Was 3-octave fbm + 2 vnoise calls per lens pixel per frame (~26 hash evals);
// now a single texture fetch. Look is identical at these opacities (cap 0.03).
function makeDirtTexture(): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, S, S);
  // broad smudge blotches
  for (let i = 0; i < 46; i++) {
    const x = Math.random() * S;
    const y = Math.random() * S;
    const r = 12 + Math.random() * 42;
    const a = 0.04 + Math.random() * 0.09;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,255,255,${a.toFixed(3)})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // dust specks
  for (let i = 0; i < 380; i++) {
    const a = 0.05 + Math.random() * 0.16;
    ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
    const s = Math.random() < 0.9 ? 1 : 2;
    ctx.fillRect(Math.random() * S, Math.random() * S, s, s);
  }
  // hairline scratches
  ctx.strokeStyle = 'rgba(255,255,255,0.20)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    const x = Math.random() * S;
    const y = Math.random() * S;
    ctx.moveTo(x, y);
    ctx.lineTo(x + (Math.random() - 0.5) * 160, y + (Math.random() - 0.5) * 160);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}
const dirtTexture = makeDirtTexture();

const lensGeo = new THREE.CircleGeometry(tubeRadius - 0.0005, 64);
const lensMat = new THREE.ShaderMaterial({
  uniforms: {
    tDiffuse: { value: scopeTarget.texture },
    uDirtMap: { value: dirtTexture },
    uAberration: { value: 0.008 },
    uVignetteSize: { value: 0.485 },
    uShadowHardness: { value: 0.06 },
    uParallaxSens: { value: 1.06 },
    uEyeOffset: { value: new THREE.Vector2(0, 0) },
    uEyeRelief: { value: 1.0 },
    uZoomK: { value: 1.0 },
    uReticleRoll: { value: 0.0 },
    uViewAngle: { value: new THREE.Vector2(0, 0) },
    uAdsWeight: { value: 0.0 },
    uTime: { value: 0.0 },
    uSunSide: { value: new THREE.Vector2(0.4, 0.65) },
    uSunIntensity: { value: 0.35 },
    uReticleColor: { value: new THREE.Color(1.0, 0.16, 0.05) },
    uBattery: { value: 1.0 },
    uDirtOpacity: { value: 0.05 },
    uGlassTint: { value: new THREE.Color(1.0, 1.0, 1.0) },
    uOpticMode: { value: 0.0 },
    uSunFacing: { value: 0.0 },
    uReticleScale: { value: 1.0 },
    uDofRings: { value: 1.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D uDirtMap;
    uniform float uAberration;
    uniform float uVignetteSize;
    uniform float uShadowHardness;
    uniform float uParallaxSens;
    uniform vec2 uEyeOffset;
    uniform float uEyeRelief;
    uniform float uZoomK;
    uniform float uReticleRoll;
    uniform vec2 uViewAngle;
    uniform float uAdsWeight;
    uniform float uTime;
    uniform vec2 uSunSide;
    uniform float uSunIntensity;
    uniform vec3 uReticleColor;
    uniform float uBattery;
    uniform float uDirtOpacity;
    uniform vec3 uGlassTint;
    uniform float uOpticMode;
    uniform float uSunFacing;
    uniform float uReticleScale;
    uniform float uDofRings;
    varying vec2 vUv;

    float hash21(vec2 p) {
      p = fract(p * vec2(234.34, 435.345));
      p += dot(p, p + 34.23);
      return fract(p.x * p.y);
    }
    float sdSegment(vec2 p, vec2 a, vec2 b) {
      vec2 pa = p - a;
      vec2 ba = b - a;
      float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
      return length(pa - ba * h);
    }
    // Elliptical radius of q around center c given tilt basis (dir/cos):
    // parallel axis is foreshortened by tiltCos, so stretch it back before
    // the circular comparison. Returns circular-equivalent radius.
    float ellR(vec2 q, vec2 c, vec2 dir, float cosA) {
      vec2 d = q - c;
      float par = dot(d, dir);
      vec2 perp = d - dir * par;
      return length(vec2(par / max(cosA, 0.55), length(perp)));
    }
    // Radial barrel/fisheye warp around the optical axis. k < 0 barrels (the
    // classic scope "bulge"): center magnified, rim compressed and bowed. A
    // second higher-order term (r^4) compounds the curvature like two stacked
    // lens elements — the "double-layered" bend real scopes have. One shared
    // function so the image AND the etched reticle curve together.
    vec2 barrelWarp(vec2 p, float k) {
      float r2 = dot(p, p);
      return p * (1.0 + k * r2 + k * 0.5 * r2 * r2);
    }
    // Chromatic sample at one bent coord. Transverse CA: R/B bend linearly
    // with radius (real lateral color scales ~r, not r^2) — the fringe is
    // invisible at center and grows to a couple px at the rim. 'axial' adds a
    // longitudinal component that bows with defocus (blue focuses short, red
    // long), so off-focus edges smear magenta/green like real glass.
    vec3 sampleSight(vec2 buv, float brv, float aberr, float axial) {
      float k = aberr * brv + axial * brv * brv;
      vec2 sR = buv * (1.0 - k);
      vec2 sB = buv * (1.0 + k);
      float rr = texture2D(tDiffuse, sR + 0.5).r;
      float gg = texture2D(tDiffuse, buv + 0.5).g;
      float bb = texture2D(tDiffuse, sB + 0.5).b;
      return vec3(rr, gg, bb);
    }
    // Analytically anti-aliased primitives (fwidth): etch lines stay hairline
    // without shimmering at 1px widths.
    float aaLine(float c, float w) {
      float aa = fwidth(c) * 1.2;
      return 1.0 - smoothstep(w - aa, w + aa, abs(c));
    }
    float aaRange(float c, float hi) {
      float aa = fwidth(c) * 1.2;
      return 1.0 - smoothstep(hi - aa, hi + aa, abs(c));
    }
    float aaBand(float c, float lo, float hi) {
      float aa = fwidth(c) * 1.2;
      return smoothstep(lo - aa, lo + aa, abs(c))
        * (1.0 - smoothstep(hi - aa, hi + aa, abs(c)));
    }

    void main() {
      vec2 uv = vUv - 0.5;
      float r2 = dot(uv, uv);
      float distFromCenter = length(uv);

      float swayDist = length(uEyeOffset);

      // ---- SIGHT SLIDE + WHISPER PARALLAX ----
      // The world image is now ROTATED WITH THE GUN (the render camera is on
      // the barrel), so the internal lateral slide is only the *parallax*
      // whisper — a real eye off-axis shifts the etched reticle against the
      // distant world by a hair, not half a lens. Kept small on purpose: the
      // "sway" the player should feel is the WHOLE gun rotating, expressed as
      // tunnel tilt + edge blackout below, not the picture swimming.
      vec2 rawSight = -uEyeOffset * 0.6;
      float maxSight = uVignetteSize * 0.8;
      vec2 sightC = length(rawSight) > maxSight ? normalize(rawSight) * maxSight : rawSight;
      vec2 imageShift = -sightC;
      vec2 imageCenter = sightC;
      vec2 reticleCenter = sightC * uParallaxSens;
      vec2 tubeCenter = -uEyeOffset * 0.3;

      // ---- 3D FORESHORTENING: tilted tube projects as an ellipse ----
      // viewAngle = combined eye-offset + bore/eye angular mismatch (radians).
      // Circles viewed at angle squash along the tilt direction: minor axis
      // lies along the offset, major stays perpendicular. Diagonal eye error
      // therefore yields a diagonally-tilted ellipse (the "/" vs "\" feel).
      float tiltMag = length(uViewAngle);
      vec2 tiltDir = tiltMag > 1e-4 ? uViewAngle / tiltMag : vec2(1.0, 0.0);
      float tiltCos = cos(min(tiltMag, 0.65));

      // ---- EYE-RELIEF APERTURE (physical exit pupil) ----
      // relief 1.0 = eye seated at the exit pupil. Too far shrinks the picture
      // (the exit-pupil disc falls inside the eye pupil → narrower FOV, the
      // classic "scope shadow closing in"); too close blows it out past the
      // ocular field stop. uZoomK = exit-pupil magnification penalty: the exit
      // pupil diameter = objective / magnification, so cranked zoom makes the
      // SAME error cost dramatically more — harder eye relief you can *feel*.
      // Shouldering progression is deliberately back-loaded: hip is a tiny dim
      // peephole, mid-travel is still mostly black tunnel with a sweeping
      // crescent, and the full picture only lands at the end of ADS — like
      // finding the eye box on a real optic. Do NOT linearize this.
      float eyeBox = smoothstep(0.15, 0.98, uAdsWeight);
      // exit-pupil FOV penalty grows with relief error AND magnification:
      // reliefShrink handles "too far", tooClose handles "inside the pupil".
      float reliefErr = abs(uEyeRelief - 1.0);
      float reliefShrink = clamp(pow(max(uEyeRelief, 0.35), -1.15), 0.18, 1.05);
      float tooClose = smoothstep(0.35, 0.78, uEyeRelief);
      // NOTE: no base-aperture zoom penalty. A perfectly seated eye sees the
      // FULL field through the ocular at any magnification — the picture must
      // stay full-size and full-bright when you're still. The zoom penalty
      // lives in the *error response* (uEyeOffset/uEyeRelief are amplified by
      // zoomTighten in JS), so it only bites when you sway, never when centered.
      float currentAperture = uVignetteSize * reliefShrink * tooClose * mix(0.35, 1.0, eyeBox);
      float shadowK = uShadowHardness * mix(1.7, 0.75, tooClose * clamp(2.0 - uEyeRelief, 0.0, 1.0));
      // zoomed glass punishes harder: edge hardens with magnification
      shadowK *= 1.0 + (uZoomK - 1.0) * 0.25;
      // edge stays hard while shouldering, relaxes once seated in the eye box
      float transit = (1.0 - eyeBox) * smoothstep(0.0, 0.4, uAdsWeight);
      shadowK *= 1.0 + transit * 1.5;
      // reticle fades in LAST — off-axis eyes see no etch, only tunnel
      float etchVis = smoothstep(0.55, 0.98, uAdsWeight);
      // off-axis transmission collapse: hip peephole runs dark, not full-bright.
      // (uEyeOffset/uEyeRelief are ALREADY zoom-amplified in JS, so no uZoomK
      // here — the "same sway = blacker at high zoom" comes free from that.)
      float reliefDim = mix(0.25, 1.0, smoothstep(0.15, 0.95, uAdsWeight));
      reliefDim /= 1.0 + swayDist * 1.2 + reliefErr * 0.8;

      // ---- NEUTRAL GLASS + DEFOCUS: keep scope == world ----
      // Wrong relief or zoomed sway blurs the sight (eye relief you feel, not
      // just darkness). 5-tap cross, radius tracks total eye error. Computed
      // before the CA/distortion block so the axial color can ride on it.
      // (inputs already zoom-amplified in JS — no uZoomK re-multiply here.)
      float blurMix = clamp(abs(uEyeRelief - 1.0) * 0.9 + swayDist * 0.6, 0.0, 1.0);

      // Physical lateral CA: zero at center, grows linearly to the rim. A real
      // ocular's transverse color makes a visible magenta/green fringe at the
      // edge of the sight picture; keep it honest (~2-3px at 768) rather than
      // a fisheye rainbow. Sway modulates it slightly (the eye sits off the
      // optical axis, which bends color more).
      float caMask = smoothstep(0.10, 0.46, distFromCenter);
      float dynamicAberration = uAberration * (0.75 + swayDist * 0.5) * caMask;
      // Longitudinal color rides on defocus: out-of-focus edges split blue/red
      // around the green focal plane (axial CA). Grows with relief error + zoom.
      float axialAberration = uAberration * (0.35 + blurMix * 1.6) * caMask;

      // Rim-weighted barrel + fisheye distortion: the ocular is a curved glass
      // element, so the whole field bows around the optical axis — straight
      // world lines near the rim curve like looking into a sphere. Radial in
      // r², so the center is naturally untouched and the edge bows hardest.
      // Distorted around the shifted image plane so glass feels volumetric.
      // Image stays UPRIGHT at hip by design: a real scope's erector lenses
      // flip the objective's inverted image before the ocular, so the eye
      // always gets an upright picture.
      vec2 imgUv = uv + imageShift;
      // barrel strength: negative → barrel; stronger off-axis (hip), eased ADS
      float barrelK = mix(-0.16, -0.09, uAdsWeight);
      vec2 baseUv = barrelWarp(imgUv, barrelK);
      float br = length(baseUv);

      float blurR = blurMix * 0.006;
      vec3 sharpC = sampleSight(baseUv, br, dynamicAberration, axialAberration);
      vec3 bx = (sampleSight(baseUv + vec2(blurR, 0.0), br, dynamicAberration, axialAberration)
        + sampleSight(baseUv - vec2(blurR, 0.0), br, dynamicAberration, axialAberration)) * 0.5;
      vec3 by = (sampleSight(baseUv + vec2(0.0, blurR), br, dynamicAberration, axialAberration)
        + sampleSight(baseUv - vec2(0.0, blurR), br, dynamicAberration, axialAberration)) * 0.5;
      vec3 sceneColor = mix(sharpC, (bx + by) * 0.5, blurMix);
      // Coated-glass transmission loss + off-axis dimming: ADS center runs
      // ~78% of naked-eye brightness, hip peephole collapses toward 30%.
      // (Deliberately under, not over — the old 0.9 + additive lifts read as
      // a flashlight inside the tube.)
      sceneColor *= 0.78 * reliefDim * uGlassTint;

      // ---- LENS SMUDGE & DIRT: baked texture, glint-only ----
      // uDirtOpacity ~0.05 by default: effectively invisible unless sun catches it.
      // Single fetch from the pre-baked uDirtMap (was per-pixel fbm — see maker).
      float dirtMask = texture2D(uDirtMap, vUv).r;

      // Dirt only lights up at glancing sun/eye angles, capped very low
      vec2 safeUv = uv + vec2(1e-4);
      vec2 sweepDir = normalize(uSunSide + uEyeOffset * 4.0 + vec2(1e-4));
      float sweep = pow(max(dot(normalize(safeUv), sweepDir) * 0.5 + 0.5, 0.0), 6.0);
      float dirtLightAmt = (0.002 + uSunIntensity * 0.025 + sweep * (0.01 + swayDist * 0.3)) * uDirtOpacity * 20.0;
      dirtLightAmt = min(dirtLightAmt, 0.03);
      vec3 dirtColor = vec3(1.0, 0.99, 0.96);
      float inImage = 1.0 - smoothstep(currentAperture - shadowK, currentAperture, ellR(uv, imageCenter, tiltDir, tiltCos));
      sceneColor += dirtMask * dirtLightAmt * dirtColor * inImage;

      // Diagonal sun-streak flare across glass (scope glint), barely-there
      float flareBand = 1.0 - smoothstep(0.0, 0.09, abs(dot(uv, vec2(-sweepDir.y, sweepDir.x))));
      float flare = flareBand * sweep * uSunIntensity * 0.025 * inImage;
      sceneColor += flare * vec3(1.0, 0.99, 0.96);

      // ---- RETICLE: uOpticMode 0 = sniper mil-lines, 1 = ACOG / red dot ----
      // NOTE: scope image is intentionally NOT mirrored/inverted. Real rifle
      // scopes erect the image (upright), and our render-target camera looks
      // forward along the barrel, so upright sampling here is correct. At hip
      // you see the ocular at an angle — perspective foreshortening handles
      // that, no texture flip needed. Do not "fix" by flipping vUv.
      // FFP vs SFP: sniper reticle scales with magnification (first focal
      // plane — subtensions stay true at any zoom), ACOG stays fixed size
      // (second focal plane). uReticleScale = baseFov / currentFov, clamped.
      // RETICLE ROLL: the etch is fixed to the gun, the eye is fixed to the
      // head. When the tube rolls relative to the eye the cross tilts "/" vs
      // "\" while the rotationally-symmetric lens image stays level. Rotate
      // eye-space coords back into gun-space by -roll to draw that.
      vec2 rc = uv - reticleCenter;
      // Seat the etch IN the glass: bend it with the same ocular curvature as
      // the image (barrelWarp + barrelK), but a touch MORE so the etch reads
      // as lying on its own focal plane slightly closer to the eye — the
      // second "layer" of the double-barrel. A flat overlay is what read as
      // "plastered".
      vec2 rcBent = barrelWarp(rc, barrelK * 1.12);
      float cR = cos(uReticleRoll);
      float sR = sin(uReticleRoll);
      vec2 rcGun = vec2(cR * rcBent.x + sR * rcBent.y, -sR * rcBent.x + cR * rcBent.y);
      // Eye-distance size cue: closer eye reads the etch slightly larger.
      vec2 p = rcGun / (uReticleScale * (0.92 + 0.08 * uEyeRelief));
      bool isAcog = uOpticMode > 0.5;

      // SNIPER etch: AA hairlines (no shimmer); fine mil-dots defocus out
      // first off-axis — tiny features go before lines, like real glass.
      float defK = 1.0 + min(swayDist * 2.0, 1.0);
      float sLineX = aaLine(p.x, 0.0011 * defK) * aaRange(p.y, 0.4);
      float sLineY = aaLine(p.y, 0.0011 * defK) * aaRange(p.x, 0.4);
      float sPostX = aaLine(p.x, 0.0035 * defK) * aaBand(p.y, 0.12, 0.4);
      float sPostY = aaLine(p.y, 0.0035 * defK) * aaBand(p.x, 0.12, 0.4);
      float dotStay = 1.0 - blurMix * 0.8;
      float sDotsX = step(mod(abs(p.x) + 0.025, 0.05), 0.0025) * step(abs(p.y), 0.0025) * step(abs(p.x), 0.12) * dotStay;
      float sDotsY = step(mod(abs(p.y) + 0.025, 0.05), 0.0025) * step(abs(p.x), 0.0025) * step(abs(p.y), 0.12) * dotStay;
      float sniperEtch = clamp(sLineX + sLineY + sPostX + sPostY + sDotsX + sDotsY, 0.0, 1.0);

      // ACOG etch: short center ticks + thick outer posts only, no full cross
      float aTickX = aaLine(p.x, 0.0012 * defK) * aaRange(p.y, 0.07);
      float aTickY = aaLine(p.y, 0.0012 * defK) * aaRange(p.x, 0.07);
      float aPostX = aaLine(p.x, 0.004 * defK) * aaBand(p.y, 0.14, 0.4);
      float aPostY = aaLine(p.y, 0.004 * defK) * aaBand(p.x, 0.14, 0.4);
      float acogEtch = clamp(aTickX + aTickY + aPostX + aPostY, 0.0, 1.0);
      float etchedMask = isAcog ? acogEtch : sniperEtch;

      // Focus + glow response: a centered eye focuses the etch crisply; as the
      // eye leaves the box the eye can't accommodate, so edges soften and the
      // illumination dims. Static-sharp + static-bright is the other half of
      // the "plastered" feel.
      float focusW = 1.0 + swayDist * 5.0;
      float illumDim = 1.0 - clamp(swayDist * 1.2, 0.0, 0.45);

      // SNIPER illumination: small chevron, apex = point of impact
      vec2 apex = vec2(0.0, 0.004);
      vec2 footL = vec2(-0.02, -0.016);
      vec2 footR = vec2(0.02, -0.016);
      float dChev = min(sdSegment(p, apex, footL), sdSegment(p, apex, footR));
      // fwidth floors: sub-pixel edges widen instead of sparkling.
      float wChev = max(0.001 * focusW, fwidth(dChev) * 1.5);
      float sniperCore = (1.0 - smoothstep(0.0016, 0.0016 + wChev, dChev))
        + (1.0 - smoothstep(0.0012, 0.0012 + wChev, length(p - apex))) * 0.7;

      // ACOG / RED DOT illumination: big glowing dot + horseshoe ring
      float dDot = length(p);
      float wDot = max(0.002 * focusW, fwidth(dDot) * 1.5);
      float dotCore = 1.0 - smoothstep(0.0035, 0.0035 + wDot, dDot);
      float dRing = abs(dDot - 0.032);
      float ringAng = atan(p.y, p.x); // horseshoe gap at bottom (angle ~ -PI/2)
      float ringGate = smoothstep(0.3, 0.55, abs(ringAng + 1.5708));
      float wRing = max(0.0014 * focusW, fwidth(dRing) * 1.5);
      float horseCore = (1.0 - smoothstep(0.0018, 0.0018 + wRing, dRing)) * ringGate;
      float acogCore = clamp(dotCore + horseCore, 0.0, 1.0);

      float illumMask = (isAcog ? acogCore : clamp(sniperCore, 0.0, 1.0)) * illumDim;

      // bloom: tight halo in dark environments (battery bleed)
      // ACOG dot blooms wider than the sniper chevron on purpose.
      float haloDist = isAcog ? min(dDot * 0.55, dRing + 0.012) : dChev;
      float halo = exp(-haloDist * 90.0) * 0.4 + exp(-length(p) * 22.0) * 0.08;
      float darkFactor = 1.0 - smoothstep(0.04, 0.42, dot(sceneColor, vec3(0.299, 0.587, 0.114)));
      float glowStrength = (0.55 + darkFactor * 2.2) * uBattery;

      float reticleVis = (1.0 - smoothstep(currentAperture - shadowK, currentAperture, ellR(uv, imageCenter, tiltDir, tiltCos))) * etchVis;
      sceneColor = mix(sceneColor, vec3(0.0), etchedMask * 0.82 * reticleVis);
      // illuminated chevron sits on top of etch
      sceneColor += uReticleColor * illumMask * glowStrength * reticleVis;
      sceneColor += uReticleColor * halo * glowStrength * 0.5 * reticleVis;
      // battery bleed: tight faint wash that never blooms with glowStrength
      // (decoupling it is what keeps the sight picture from lifting)
      float wash = (exp(-haloDist * 140.0) * 0.22 + 0.0008) * (0.5 + darkFactor * 0.8) * uBattery;
      sceneColor += uReticleColor * wash * reticleVis;

      // ---- GLASS GRIT: dust motes + one fiber, fixed to the ocular surface
      // (vUv space — they ride with the tube, never with the world image)
      {
        float m1 = 1.0 - smoothstep(0.0, 0.0022, length(vUv - vec2(0.44, 0.57)));
        float m2 = 1.0 - smoothstep(0.0, 0.0016, length(vUv - vec2(0.58, 0.44)));
        float m3 = 1.0 - smoothstep(0.0, 0.0012, length(vUv - vec2(0.52, 0.62)));
        float fib = 1.0 - smoothstep(0.0, 0.0009, sdSegment(vUv, vec2(0.30, 0.70), vec2(0.42, 0.62)));
        float grit = clamp(m1 + m2 + m3, 0.0, 1.0) * 0.45 + fib * 0.35;
        sceneColor = mix(sceneColor, vec3(0.0), grit * inImage);
      }

      // ---- VEILING GLARE: sun washes the IMAGE, not the tube ----
      // Real optics bloom the picture when aimed near the sun; the baffled
      // tube itself stays black. So glare lifts sceneColor here, while the
      // tube wall below stays near-black with only an edge crescent.
      {
        vec2 gSun = length(uSunSide) > 1e-4 ? normalize(uSunSide) : vec2(0.4, 0.65);
        float glare = uSunFacing * uSunFacing * uSunFacing;
        sceneColor += vec3(1.0, 0.96, 0.90) * glare * 0.018 * reticleVis;
        // two ghost orbs: the internal double-reflection of the objective —
        // one cool, one warm, mirrored across the optical axis (classic
        // multi-element scope flare that only shows into the sun).
        vec2 gPos1 = -gSun * 0.16 + imageCenter;
        vec2 gPos2 = gSun * 0.30 + imageCenter;
        float ghost1 = 1.0 - smoothstep(0.0, 0.050, length(uv - gPos1));
        float ghost2 = 1.0 - smoothstep(0.0, 0.028, length(uv - gPos2));
        sceneColor += vec3(0.85, 0.92, 1.0) * ghost1 * glare * uSunFacing * 0.016 * reticleVis;
        sceneColor += vec3(1.0, 0.95, 0.85) * ghost2 * glare * uSunFacing * 0.009 * reticleVis;
        // coma/axial bloom: a sun-side haze that fades across the field
        float coma = pow(max(dot(normalize(uv - imageCenter + vec2(1e-4)), -gSun) * 0.5 + 0.5, 0.0), 8.0);
        sceneColor += vec3(0.92, 0.92, 0.97) * coma * glare * uSunFacing * 0.020 * reticleVis;
      }

      // OUTER-RING DOF (toggle T): shallow depth of field lives in the glass —
      // baffles wash out, rim bands widen, crescent edge relaxes — scaled by
      // zoom at ADS. Sight center stays crisp (own defocus path above).
      float outerSoft = uDofRings
        * clamp((uZoomK - 1.0) * 0.5, 0.0, 1.0)
        * smoothstep(0.3, 0.9, uAdsWeight);

      // ---- 3D TUNNEL: matte-black baffled tube + edge crescent + rim glint ----
      // Hip reads as ~95% ocular shadow (tiny dim tilted peephole) by design —
      // currentAperture/etchVis/reliefDim above already encode that. Do NOT
      // "fix" the hip floor back up: a usable full-bright picture off-axis is
      // exactly what looked awful.
      float distImg = ellR(uv, imageCenter, tiltDir, tiltCos);
      float distTube = ellR(uv, tubeCenter, tiltDir, tiltCos);
      float distOcular = length(uv);

      float objectiveMask = smoothstep(currentAperture - shadowK, currentAperture, distImg);

      // Directional eye-box shadow: blackout creeps in from the side the eye
      // drifts toward (not a uniform radial close). Scales with eye error so
      // a centered eye sees a clean full picture. The blackout edge is the
      // arc of the eye's entrance pupil sliding against the field stop — a
      // lune/crescent (elliptical under tube tilt), NOT a straight cutoff.
      {
        float eyeMag = length(uEyeOffset);
        vec2 eyeDir = eyeMag > 1e-4 ? uEyeOffset / eyeMag : vec2(0.0);
        // eye pupil is a disc that travels with the eye; the picture shows
        // only where it overlaps the objective field stop. Off-axis the two
        // discs part into a crescent.
        float slide = min(eyeMag * 2.4, 1.0);
        vec2 pupilC = imageCenter - eyeDir * currentAperture * slide;
        // The eye pupil is SMALLER than the field stop, so its arc across the
        // field is always strongly curved — the blackout stays a crescent even
        // when the sway saturates, never degrading into a straight chord.
        float pupilR = currentAperture * 0.82;
        float pupilMask = smoothstep(pupilR - shadowK, pupilR, ellR(uv, pupilC, tiltDir, tiltCos));
        objectiveMask = max(objectiveMask, pupilMask * smoothstep(0.008, 0.10, eyeMag));
      }

      // Tube interior is matte black (baffled — it never catches direct sun).
      // Only a faint warm kiss on the outer wall band, scaled by sunFacing so
      // it dies completely when looking away from the sun.
      vec2 tubeN = distTube > 1e-4 ? (uv - tubeCenter) / distTube : vec2(0.0, 1.0);
      vec2 sunN = length(uSunSide) > 1e-4 ? normalize(uSunSide) : vec2(0.4, 0.65);
      float wallBand = smoothstep(currentAperture, 0.5, distTube);
      float sunSideLight = pow(max(dot(tubeN, sunN) * 0.5 + 0.5, 0.0), 4.0);
      vec3 tubeWall = vec3(0.008, 0.008, 0.008)
        + vec3(0.10, 0.088, 0.075) * (wallBand * wallBand) * sunSideLight * uSunFacing * 0.25;
      // FAR INNER WALL: looking down a pipe off-axis, the opposite wall shows
      // itself — a soft band on the far side that travels with the eye. This
      // is the strongest "hollow tube" cue; it needs no sun (ambient bounce).
      {
        float eyeMag2 = length(uEyeOffset);
        vec2 eyeDir2 = eyeMag2 > 1e-4 ? uEyeOffset / eyeMag2 : vec2(0.0);
        float farSide = pow(max(dot(tubeN, -eyeDir2) * 0.5 + 0.5, 0.0), 3.0);
        float midWall = wallBand * (1.0 - wallBand) * 4.0;
        tubeWall += vec3(0.10, 0.095, 0.09) * farSide * midWall
          * (0.10 + min(eyeMag2 * 1.4, 0.6)) * (0.35 + 0.65 * uSunFacing);
      }
      // thin objective-bell crescent right at the image edge, sun side only
      // (widens under ring-DOF like the rest of the glass furniture)
      float crescentLine = 1.0 - smoothstep(0.0, 0.022 + outerSoft * 0.02, abs(distTube - currentAperture));
      float crescent = crescentLine * pow(max(dot(tubeN, sunN) * 0.5 + 0.5, 0.0), 6.0);
      tubeWall += vec3(1.0, 0.94, 0.84) * crescent * uSunFacing * 0.12 * objectiveMask;

      // faint travelling sheen with sway (oily glass edge, not lit paint)
      float innerRefl = pow(max(dot(tubeN, sweepDir) * 0.5 + 0.5, 0.0), 12.0) * swayDist * 0.35;
      tubeWall += vec3(0.09, 0.09, 0.09) * innerRefl * objectiveMask;

      // Machined baffle ridges: concentric rings darken the wall in bands and
      // catch a hairline highlight on the sun side at glancing angles.
      // transitBoost: looking down the tube at an angle mid-shoulder, the
      // rings catch light and read as depth — once seated they go near-black.
      // Chirped spacing (rings bunch toward the far end) fakes pipe
      // perspective — even spacing reads flat, bunching reads deep.
      float transitBoost = (1.0 + transit * 1.2) * (1.0 + (uZoomK - 1.0) * 0.3);
      float baffles = 0.5 + 0.5 * sin(distTube * (200.0 + distTube * 160.0));
      baffles = mix(baffles, 0.5, outerSoft * 0.8);
      tubeWall *= (0.78 + 0.22 * baffles);
      // depth falloff: the far end of the tunnel falls darker (tube length read)
      tubeWall *= mix(1.0, 0.55, smoothstep(currentAperture, 0.5, distTube));
      // atmospheric depth haze: the deep (objective) end picks up a faint cool
      // scatter off the black anodizing, so the bore reads as a receding volume
      // instead of a flat ring — the haze is strongest at the far lip and dies
      // toward the ocular.
      tubeWall += vec3(0.02, 0.026, 0.035)
        * (1.0 - wallBand) * (1.0 - wallBand) * (0.3 + 0.5 * uSunIntensity);
      tubeWall += vec3(0.5, 0.44, 0.38) * pow(baffles, 8.0) * sunSideLight * uSunFacing * 0.12 * objectiveMask * transitBoost;

      // ---- INNER OBJECTIVE RING (second glass layer, depth parallax) ----
      // A real scope is a stack of elements, not one flat screen: the objective
      // lens sits deep in the bell behind the field stop. Drawing it as a ring
      // that shifts at a *different* parallax rate than the ocular rim and the
      // image gives three planes sliding against each other — that relative
      // motion is what reads as a hollow 3D tube instead of a painted washer.
      {
        vec2 innerC = -uEyeOffset * 0.55;
        float innerR = currentAperture * 1.05 + outerSoft * 0.01;
        float ir = ellR(uv, innerC, tiltDir, tiltCos);
        float innerRing = 1.0 - smoothstep(0.0, 0.010 + outerSoft * 0.012, abs(ir - innerR));
        vec2 innerN = normalize(uv - innerC + vec2(1e-4));
        float innerSun = pow(max(dot(innerN, sunN) * 0.5 + 0.5, 0.0), 4.0);
        tubeWall += vec3(0.12, 0.115, 0.11) * innerRing
          * (0.14 + 0.4 * innerSun * uSunFacing) * (1.0 - objectiveMask) * (0.4 + 0.6 * etchVis);
        // objective glass catches a faint blue sky kiss, like coated glass
        tubeWall += vec3(0.08, 0.10, 0.12) * innerRing * (1.0 - objectiveMask)
          * (0.05 + 0.16 * uSunIntensity);
      }

      // ---- ERECTOR RING (third glass layer) ----
      // The erector tube is the narrow internal cylinder between the objective
      // and ocular. Its near lip is a THIRD ring at its own parallax rate —
      // shallower than the objective (shifts less) but deeper than the ocular
      // (shifts more), so off-axis the rings slide at three distinct speeds and
      // the interior reads as a real receding bore, not concentric paint.
      {
        vec2 erC = -uEyeOffset * 0.45;
        float erR = mix(currentAperture, 0.485, 0.34);
        float er = ellR(uv, erC, tiltDir, tiltCos);
        float erRing = 1.0 - smoothstep(0.0, 0.008 + outerSoft * 0.01, abs(er - erR));
        vec2 erN = normalize(uv - erC + vec2(1e-4));
        float erSun = pow(max(dot(erN, sunN) * 0.5 + 0.5, 0.0), 3.0);
        tubeWall += vec3(0.09, 0.088, 0.085) * erRing
          * (0.08 + 0.28 * erSun * uSunFacing) * (1.0 - objectiveMask) * (0.4 + 0.6 * etchVis);
      }

      // Tube inner-surface fresnel: the wall is glass, so it reflects a whisper
      // of the world at grazing angles near the ocular — bright rim, black
      // center. This is the "looking down a glass tube" sheen, distinct from
      // the matte baffles; it rolls with the sun and the eye.
      {
        float grazing = pow(1.0 - clamp(distTube / 0.5, 0.0, 1.0), 1.6);
        float wallFres = grazing * (0.03 + 0.18 * uSunIntensity);
        vec2 frN = normalize(uv - tubeCenter + vec2(1e-4));
        float frSun = pow(max(dot(frN, sunN) * 0.5 + 0.5, 0.0), 6.0);
        tubeWall += vec3(0.13, 0.16, 0.19) * wallFres * (0.3 + 0.7 * frSun) * (1.0 - objectiveMask);
      }

      // ---- LAYERED GLASS (subtle, near-neutral) ----
      // A scope is a stack of coated elements; each reflects a LITTLE. Keep
      // them near-neutral and barely-there so the picture stays "scope ==
      // world" — a faint glass pane, never a colored wash. All of them
      // strengthen off-axis (eye sway = grazing angle) and with magnification,
      // which is why they previously only read during the shoulder travel.
      {
        float fresSway = min(swayDist * 2.5, 1.0);
        float fresZoom = clamp((uZoomK - 1.0) * 0.25, 0.0, 1.0);
        float fresBoost = (0.35 + 0.65 * fresSway) * (1.0 + fresZoom);
        // objective fresnel: dark neutral reflection, faint cool lift at the
        // rim, stronger off-axis / zoomed — sits behind the image like glass
        float objFres = smoothstep(0.14, 0.5, distFromCenter);
        objFres *= objFres;
        vec3 objRefl = mix(vec3(0.03, 0.035, 0.045), vec3(0.20, 0.24, 0.30), objFres);
        sceneColor = mix(sceneColor, objRefl,
          objFres * (0.05 + 0.14 * uSunIntensity) * fresBoost * (1.0 - objectiveMask));
        // MgF2 coating sheen: faint magenta/green, sun-side, sweeps with the eye
        vec2 coatDir = normalize(uSunSide + uEyeOffset * 5.0 + vec2(1e-4));
        float sheenAmt = smoothstep(0.30, 0.5, distFromCenter) * (0.15 + 0.6 * uSunIntensity) * 0.05 * fresBoost;
        vec3 coat = mix(vec3(0.5, 0.22, 0.45), vec3(0.22, 0.5, 0.30), 0.5 + 0.5 * dot(tubeN, coatDir));
        sceneColor += coat * sheenAmt * (1.0 - objectiveMask);
        // sky fresnel veil: a whisper, mostly neutral, rim-only
        float veil = pow(smoothstep(0.32, 0.5, distFromCenter), 2.0) * 0.045 * (0.3 + 0.7 * uSunIntensity) * fresBoost;
        sceneColor = mix(sceneColor, vec3(0.42, 0.46, 0.50), veil * (1.0 - objectiveMask));
      }

      vec3 viewWithTunnel = mix(sceneColor, tubeWall, objectiveMask);

      // ocular rim: hard clip + machined inner bevel + thin sun-line on edge
      float ocularShadow = smoothstep(0.485, 0.5, distOcular);
      float ringBand = 1.0 - smoothstep(0.0, 0.006 + outerSoft * 0.008, abs(distOcular - 0.48));
      // bevel: hairline lit chamfer just inside the rim sells the metal edge
      float bevel = 1.0 - smoothstep(0.0, 0.010 + outerSoft * 0.010, abs(distOcular - 0.466));
      vec2 ocuN = distOcular > 1e-4 ? uv / distOcular : vec2(0.0, 1.0);
      float ringGlint = pow(max(dot(ocuN, sunN) * 0.5 + 0.5, 0.0), 3.0);
      vec3 ringLight = vec3(0.92, 0.92, 0.92) * ringBand * ringGlint * (0.06 + uSunIntensity * 0.45);
      // keep opposite side dark for roundness
      float ringShade = pow(max(dot(ocuN, -sunN) * 0.5 + 0.5, 0.0), 2.0);
      viewWithTunnel -= vec3(0.05) * ringBand * ringShade;
      viewWithTunnel += ringLight;
      // bevel chamfer catches a duller, broader light than the rim line
      viewWithTunnel += vec3(0.10, 0.10, 0.105) * bevel * (0.25 + 0.45 * ringGlint);

      vec3 finalColor = mix(viewWithTunnel, vec3(0.0), ocularShadow);

      // Sight-picture brightness: dim center (transmission loss, above), real
      // falloff toward the rim. Never lift the image.
      float brightT = smoothstep(0.0, uVignetteSize, length(uv - imageCenter));
      finalColor *= mix(1.0, 0.62, brightT);

      // faint grain for tactical grit (not in the black tunnel)
      float grain = hash21(vUv * 913.0 + fract(uTime) * 7.0) - 0.5;
      finalColor += grain * 0.012 * (1.0 - objectiveMask) * (1.0 - ocularShadow);

      gl_FragColor = vec4(finalColor, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `,
});

const lens = new THREE.Mesh(lensGeo, lensMat);
lens.position.z = tubeLength / 2 - 0.005;
lens.layers.set(1);
sniperGroup.add(lens);

// ACOG ocular display (shares lensMat; hidden group never renders)
const aLensGeo = new THREE.CircleGeometry(0.0355, 48);
const aLens = new THREE.Mesh(aLensGeo, lensMat);
aLens.position.z = 0.168;
aLens.layers.set(1);
acogGroup.add(aLens);

// ---- PHYSICAL GLASS LAYERS: ocular surface (eye side) + objective front
// element (barrel end). The lens shader above is the *sight picture*; these
// are the glass surfaces you look at/through — fresnel sky reflection, sun
// spec, coating hue. Layer 1 only, so the scope render camera never sees
// them (no feedback into its own render target).
function makeGlassMaterial(ocular: boolean, reflect: number): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    transparent: ocular,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uSunDirW: { value: SUN_DIR },
      uReflect: { value: reflect },
      uOcular: { value: ocular ? 1.0 : 0.0 },
    },
    vertexShader: /* glsl */ `
      uniform float uOcular;
      varying vec2 vP;
      varying vec3 vWN;
      varying vec3 vWP;
      void main() {
        vP = uv * 2.0 - 1.0;
        // fake spherical cap: dome along the outward face (eye side for the
        // ocular, muzzle side for the objective) so reflections roll to rim
        float dome = uOcular > 0.5 ? 1.0 : -1.0;
        vec3 domeN = normalize(vec3(vP.x * 0.55, vP.y * 0.55, dome));
        vWN = normalize(mat3(modelMatrix) * domeN);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWP = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDirW;
      uniform float uReflect;
      uniform float uOcular;
      varying vec2 vP;
      varying vec3 vWN;
      varying vec3 vWP;
      void main() {
        float r = clamp(length(vP), 0.0, 1.0);
        vec3 N = normalize(vWN);
        vec3 V = normalize(cameraPosition - vWP);
        float ndv = abs(dot(N, V));
        float fres = pow(1.0 - ndv, 3.5);
        vec3 H = normalize(V + uSunDirW);
        float spec = pow(max(dot(N, H), 0.0), 180.0);
        // MgF2-style coating swing: magenta center → green rim
        vec3 coat = mix(vec3(0.45, 0.18, 0.6), vec3(0.2, 0.65, 0.45), r * r);
        vec3 skyRef = mix(vec3(0.04, 0.05, 0.07), vec3(0.62, 0.68, 0.75), fres);
        float edgeGlow = smoothstep(0.85, 1.0, r) * 0.15;
        if (uOcular > 0.5) {
          // see-through: faint tint + fresnel veil + sun tick. Center stays
          // clear so the sight picture reads through it untouched.
          vec3 col = vec3(0.35, 0.45, 0.55) * fres * uReflect
            + vec3(1.0, 0.95, 0.85) * spec * 1.2
            + coat * fres * 0.12;
          float alpha = clamp(0.03 + fres * 0.55 * uReflect + spec + edgeGlow, 0.0, 0.9);
          gl_FragColor = vec4(col, alpha);
        } else {
          // front element: dark coated glass, mirrored sky + hot sun glint
          vec3 col = vec3(0.008, 0.01, 0.013)
            + skyRef * uReflect
            + vec3(1.0, 0.95, 0.85) * spec * 1.6
            + coat * fres * 0.3;
          gl_FragColor = vec4(col, 1.0);
        }
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  return mat;
}

function addGlass(
  parent: THREE.Group,
  radius: number,
  z: number,
  ocular: boolean,
  reflect: number,
): void {
  const m = new THREE.Mesh(new THREE.CircleGeometry(radius, 48), makeGlassMaterial(ocular, reflect));
  m.position.z = z;
  m.layers.set(1);
  if (ocular) m.renderOrder = 2;
  parent.add(m);
}

// Sniper: ocular surface just inside the bell mouth, objective deep in the bell
addGlass(sniperGroup, 0.054, 0.262, true, 1.5);
addGlass(sniperGroup, 0.06, -0.298, false, 1.3);
// ACOG: compact cups, same treatment
addGlass(acogGroup, 0.036, 0.17, true, 1.5);
addGlass(acogGroup, 0.042, -0.166, false, 1.3);

interface ScopeConfig {
  fov: number;
}

const config: ScopeConfig = { fov: 3.0 };
let isAiming = false;

const hipPosition = new THREE.Vector3(0.22, -0.22, -0.65);
const adsPosition = new THREE.Vector3(0.0, 0.0, -0.38);
weaponGroup.position.copy(hipPosition);

let currentAdsWeight = 0.0;
let mouseVelocityX = 0;
let mouseVelocityY = 0;
// LAYER 1 — head targets: the head has mass, it eases toward look intent
// (~30/s) instead of teleporting. Weapon trails the *eased* head, so error
// between layers is organic, never rigid-vs-loose.
let yawTarget = 0;
let pitchTarget = 0;
// LAYER 2 — movement rotation kicks: angular acceleration tilts the gun
// (roll + a whisper of pitch). Steady motion doesn't tilt; jerks do.
let kickRoll = 0;
let kickPitch = 0;

type MoveKey = 'w' | 'a' | 's' | 'd';
const keys: Record<MoveKey, boolean> = { w: false, a: false, s: false, d: false };
type LeanKey = 'q' | 'e';
const leanKeys: Record<LeanKey, boolean> = { q: false, e: false };

const blocker = document.getElementById('blocker') as HTMLDivElement;
blocker.addEventListener('click', () => {
  void document.body.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => {
  blocker.style.display =
    document.pointerLockElement === document.body ? 'none' : 'flex';
});

document.addEventListener('mousemove', (event: MouseEvent) => {
  if (document.pointerLockElement !== document.body) return;
  const movementX = event.movementX || 0;
  const movementY = event.movementY || 0;

  const baseSens = 0.002;
  const fovRatio = isAiming ? config.fov / 70.0 : 1.0;
  const currentSens = isAiming ? baseSens * fovRatio * 1.5 : baseSens;

  yawTarget -= movementX * currentSens;
  pitchTarget = THREE.MathUtils.clamp(
    pitchTarget - movementY * currentSens,
    -Math.PI / 2,
    Math.PI / 2,
  );
  moveImpX += movementX;
  moveImpY += movementY;

  // The weapon's physical lag is driven by the RAW mouse impulse, not the
  // zoom-scaled view sensitivity — a rifle has the same inertia at any
  // magnification. Scaling by fovRatio here left the ADS lag ~20x too small,
  // which is why no eye relief showed while tracking at high zoom.
  mouseVelocityX += movementX * 0.001;
  mouseVelocityY += movementY * 0.001;
});

document.addEventListener('mousedown', (e: MouseEvent) => {
  if (e.button === 2) isAiming = true;
  if (e.button === 0) {
    triggerHeld = true;
    tryFire();
  }
});
document.addEventListener('mouseup', (e: MouseEvent) => {
  if (e.button === 0) triggerHeld = false;
});
document.addEventListener('mouseup', (e: MouseEvent) => {
  if (e.button === 2) isAiming = false;
});
document.addEventListener('contextmenu', (e: Event) => e.preventDefault());

document.addEventListener('wheel', (e: WheelEvent) => {
  if (isAiming) {
    config.fov += Math.sign(e.deltaY) * 0.5;
    config.fov = THREE.MathUtils.clamp(config.fov, 1.0, 15.0);
    scopeCamera.fov = config.fov;
    scopeCamera.updateProjectionMatrix();
  }
});

function isMoveKey(key: string): key is MoveKey {
  return key === 'w' || key === 'a' || key === 's' || key === 'd';
}
function isLeanKey(key: string): key is LeanKey {
  return key === 'q' || key === 'e';
}

// Reticle illumination state (C toggles red/green, B toggles battery)
// Optic state (1 = sniper scope, 2 = ACOG / red dot)
let reticleIsGreen = false;
// FFP scaling (sniper reticle grows with zoom) — off by default, F toggles
let ffpEnabled = false;
const RETICLE_RED = new THREE.Color(1.0, 0.16, 0.05);
const RETICLE_GREEN = new THREE.Color(0.25, 1.0, 0.35);
const SNIPER_FOV = 3.0;
const ACOG_FOV = 9.0;

function setOpticMode(acog: boolean): void {
  lensMat.uniforms.uOpticMode.value = acog ? 1.0 : 0.0;
  // Swap whole rifle models, not just reticles
  sniperGroup.visible = !acog;
  acogGroup.visible = acog;
  acogActive = acog;
  config.fov = acog ? ACOG_FOV : SNIPER_FOV;
  scopeCamera.fov = config.fov;
  // Objective station differs per housing (sniper bell vs ACOG cup)
  scopeCamera.position.z = acog ? -0.14 : -(tubeLength / 2);
  scopeCamera.updateProjectionMatrix();
  updateAmmoUI();
}

document.addEventListener('keydown', (e: KeyboardEvent) => {
  const k = e.key.toLowerCase();
  if (isMoveKey(k)) keys[k] = true;
  if (isLeanKey(k)) leanKeys[k] = true;
  if (k === '1') setOpticMode(false);
  if (k === '2') setOpticMode(true);
  if (k === 'c') {
    reticleIsGreen = !reticleIsGreen;
    (lensMat.uniforms.uReticleColor.value as THREE.Color).copy(
      reticleIsGreen ? RETICLE_GREEN : RETICLE_RED,
    );
  }
  if (k === 'b') {
    const cur = lensMat.uniforms.uBattery.value as number;
    lensMat.uniforms.uBattery.value = cur > 0.5 ? 0.0 : 1.0;
  }
  if (k === 'f') {
    ffpEnabled = !ffpEnabled;
  }
  if (k === 'v') {
    fireAuto = !fireAuto;
    updateAmmoUI();
  }
  if (k === 't') {
    dofRings = !dofRings;
    lensMat.uniforms.uDofRings.value = dofRings ? 1.0 : 0.0;
    (document.getElementById('dofstate') as HTMLParagraphElement).textContent =
      `Glass DOF: ${dofRings ? 'ON' : 'OFF'} — T to toggle`;
  }
  if (k === 'r') startReload();
  if (k === 'shift') breathHeld = true;
});
document.addEventListener('keyup', (e: KeyboardEvent) => {
  const k = e.key.toLowerCase();
  if (isMoveKey(k)) keys[k] = false;
  if (isLeanKey(k)) leanKeys[k] = false;
  if (k === 'shift') breathHeld = false;
});

const ammoEl = document.getElementById('ammo') as HTMLParagraphElement;

function updateAmmoUI(): void {
  const mode =
    acogActive && curAmmo() > 0 ? (fireAuto ? 'AUTO' : 'SEMI') : null;
  ammoEl.textContent =
    reloadT > 0
      ? 'RELOADING…'
      : `AMMO ${curAmmo()} / ${curMag()}${mode ? ` ${mode} — V mode` : ''} — R reload`;
}

function startReload(): void {
  if (reloadT > 0 || curAmmo() === curMag()) return;
  reloadT = RELOAD_TIME;
  updateAmmoUI();
}

function tryFire(): void {
  if (document.pointerLockElement !== document.body) return;
  if (reloadT > 0 || fireCd > 0) return;
  if (curAmmo() <= 0) {
    startReload();
    return;
  }
  const auto = acogActive && fireAuto;
  setCurAmmo(curAmmo() - 1);
  fireCd = auto ? FIRE_GAP_AUTO : FIRE_GAP_SINGLE;
  flashT = 0.06;
  triggerPull = 1;
  // Recoil straight into the springs. Auto runs lighter per shot — the stack
  // climbs through the springs naturally on a held trigger.
  const rk = auto ? 0.45 : 1.0;
  wRotVel.x += 2.4 * rk;
  wRotVel.y += (Math.random() - 0.5) * 0.7 * rk;
  wRotVel.z += (Math.random() - 0.5) * 0.5 * rk;
  wVel.z += 1.15 * rk;
  wVel.x += (Math.random() - 0.5) * 0.15 * rk;
  // head takes a touch of it too + FOV punch (existing lerp settles it)
  pitchTarget = Math.min(pitchTarget + 0.014, Math.PI / 2);
  yawTarget += (Math.random() - 0.5) * 0.006;
  camera.fov = Math.min(camera.fov + 2.5, 75);
  // flash at the brake tip
  _mzl.set(0, BORE_Y, -1.45);
  weaponGroup.localToWorld(_mzl);
  flashSprite.position.copy(_mzl);
  flashSprite.scale.setScalar(0.28 + Math.random() * 0.16);
  (flashSprite.material as THREE.SpriteMaterial).rotation = Math.random() * Math.PI;
  (flashSprite.material as THREE.SpriteMaterial).opacity = 1;
  flashSprite.visible = true;
  // brass out the right side of the action
  weaponGroup.getWorldQuaternion(_brassQ);
  _bRight.set(1, 0, 0).applyQuaternion(_brassQ);
  _bUp.set(0, 1, 0).applyQuaternion(_brassQ);
  _bFwd.set(0, 0, -1).applyQuaternion(_brassQ);
  _brassP.set(0.07, -0.19, 0.12);
  weaponGroup.localToWorld(_brassP);
  const b = brassPool[brassIdx];
  brassIdx = (brassIdx + 1) % brassPool.length;
  b.active = true;
  b.life = 2.5;
  b.m.visible = true;
  b.m.position.copy(_brassP);
  b.vel
    .copy(_bRight)
    .multiplyScalar(1.4 + Math.random() * 0.5)
    .addScaledVector(_bUp, 2.0 + Math.random())
    .addScaledVector(_bFwd, -0.4);
  b.spin.set(Math.random() * 20, Math.random() * 20, Math.random() * 20);
  updateAmmoUI();
}

const clock = new THREE.Clock();

// Scratch objects to avoid per-frame allocation
const _scopeFwd = new THREE.Vector3();
const _sunDir = new THREE.Vector3();
const _scopeRight = new THREE.Vector3();
const _scopeUp = new THREE.Vector3();
const _sunSide = new THREE.Vector2();
const _scopeQuat = new THREE.Quaternion();
const _eyeWorld = new THREE.Vector3();
const _eyeLocal = new THREE.Vector3();
const _eyeQuat = new THREE.Quaternion();
const _relQuat = new THREE.Quaternion();
const _relEuler = new THREE.Euler();
const _viewAngle = new THREE.Vector2();
// OPERATOR LAG: the eye re-seats slower than geometry moves. Raw eye-vector
// targets are smoothed before reaching the shader, so after a flick the
// shadow blooms and the eye "takes a sec" to find the box again.
const _eyeSm = new THREE.Vector2(0, 0);
const _viewSm = new THREE.Vector2(0, 0);
let _reliefSm = 1.0;
let headLean = 0.0;
let manualLean = 0.0;
let breathHeld = false;
let holdBlend = 0.0;
// FIRING state: 5-round mag, bolt-action gap, bolt-throw reload. Recoil goes
// straight into the weapon springs (wVel/wRotVel) so the gun answers with
// mass; brass is a fixed pool (zero per-frame allocs); flash is one sprite
// (no extra light → no forward-shader recompile, no per-frame light cost).
const MAG_SNIPER = 5;
const MAG_ACOG = 30;
const FIRE_GAP_SINGLE = 0.9;
const FIRE_GAP_AUTO = 0.12;
const RELOAD_TIME = 1.4;
// Per-optic ammo pools; sniper is single-fire only, ACOG toggles SEMI/AUTO (V).
let sniperAmmo = MAG_SNIPER;
let acogAmmo = MAG_ACOG;
let acogActive = false;
let fireAuto = false;
let triggerHeld = false;
let reloadT = 0;
let fireCd = 0;
let triggerPull = 0;
let flashT = 0;
// DOF switches: rings (scope glass, default on) vs map pipeline (parked).
let dofRings = true;
const dofMapEnabled = false;

function curMag(): number {
  return acogActive ? MAG_ACOG : MAG_SNIPER;
}
function curAmmo(): number {
  return acogActive ? acogAmmo : sniperAmmo;
}
function setCurAmmo(v: number): void {
  if (acogActive) acogAmmo = v;
  else sniperAmmo = v;
}
// WHOLE-WEAPON PHYSICS: position/rotation + velocities. Anchors switch on
// intent; the gun flies there with mass (slightly underdamped → a breath of
// overshoot on the shoulder). ADS weight is DERIVED from gun position.
const wPos = hipPosition.clone();
const wVel = new THREE.Vector3();
const wRot = new THREE.Vector3(0, 0.15, 0.05);
const wRotVel = new THREE.Vector3();
const _anchor = new THREE.Vector3();
const HIP_ADS_DIST = hipPosition.distanceTo(adsPosition);
// per-frame mouse impulse (px) — drives acceleration kicks, then zeroed.
let moveImpX = 0;
let moveImpY = 0;
// Sun occlusion test (1 = visible, 0 = blocked; smoothed per-frame)
const sunRay = new THREE.Raycaster();
sunRay.far = 800;
let sunVis = 1.0;
// PERF: sun occlusion raycast runs every 4th frame (result is smoothed by
// sunVis anyway, so no popping). Was a full 151-target JS raycast per frame.
let sunTick = 0;
let sunBlockedCache = false;
// PERF: module-scope movement scratch — was 2 heap allocs per frame.
const _moveDir = new THREE.Vector3();
const _moveEuler = new THREE.Euler();
// Walk-bob blend: ramps 0↔1 instead of a binary gate, so starting/stopping
// never steps the weapon (a 4mm step through 4.5x parallax reads as a snap).
let moveBlend = 0;
// Exposed for gameplay: true point-of-impact error caused by parallax.
// Bullet logic should add this (in lens UV units) scaled to world.
export const parallaxError = new THREE.Vector2(0, 0);

function animate(): void {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 1 / 30);
  const time = clock.getElapsedTime();

  if (document.pointerLockElement === document.body) {
    const speed = 15 * delta;
    _moveDir.set(0, 0, 0);
    if (keys.w) _moveDir.z -= 1;
    if (keys.s) _moveDir.z += 1;
    if (keys.a) _moveDir.x -= 1;
    if (keys.d) _moveDir.x += 1;

    _moveDir.normalize().multiplyScalar(speed);
    _moveEuler.set(0, playerGroup.rotation.y, 0);
    _moveDir.applyEuler(_moveEuler);
    playerGroup.position.add(_moveDir);

    const targetMainFov = isAiming ? 55 : 70;
    camera.fov += (targetMainFov - camera.fov) * 12 * delta;
    camera.updateProjectionMatrix();

    // LAYER 1 — head eases toward look intent (mass, ~30/s, no teleport).
    playerGroup.rotation.y +=
      (yawTarget - playerGroup.rotation.y) * Math.min(1, 30 * delta);
    pitchObject.rotation.x +=
      (pitchTarget - pitchObject.rotation.x) * Math.min(1, 30 * delta);

    // WHOLE-WEAPON TARGETS: anchor follows intent; sway offsets ride along.
    const targetWeight = isAiming ? 1.0 : 0.0;
    _anchor.lerpVectors(hipPosition, adsPosition, targetWeight);

    const holdRate = breathHeld ? 5.0 : 3.0;
    holdBlend += ((breathHeld ? 1 : 0) - holdBlend) * Math.min(1, holdRate * delta);
    if (!breathHeld && holdBlend < 0.001) holdBlend = 0;
    const breathFactor = 1.0 - holdBlend * 0.93;

    const moveTarget = keys.w || keys.a || keys.s || keys.d ? 1.0 : 0.0;
    moveBlend += (moveTarget - moveBlend) * Math.min(1, 6 * delta);
    if (moveBlend < 0.001) moveBlend = 0;
    const walkPh = time * 9.0;
    // All smooth sinusoids — the old abs(cos) vertical bounce had a velocity
    // cusp every half period that read as a micro-snap at high zoom.
    const bobScale = THREE.MathUtils.lerp(1.0, 0.25, currentAdsWeight);
    const bobX =
      (Math.sin(walkPh) * 0.004 * moveBlend + Math.sin(time * 1.7) * 0.0015) * bobScale;
    const bobY =
      (Math.sin(walkPh * 2.0) * 0.0025 * moveBlend + Math.sin(time * 2.3) * 0.0012) * bobScale;
    const bobZ =
      (Math.sin(time * 1.1) * 0.003 + Math.sin(walkPh) * 0.002 * moveBlend) * bobScale;
    // Shoulder travel: each stride pushes the rifle into/away from the cheek
    // weld, modulating EYE RELIEF directly while moving — even at full ADS the
    // scope breathes in and out against your eye. Kept partly active at ADS
    // (unlike bob, which collapses to 25%) so the exit-pupil aperture visibly
    // swells and pinches with every footfall at high magnification.
    const shoulderZ =
      Math.sin(walkPh * 2.0 + 0.5) * 0.011 * moveBlend *
      THREE.MathUtils.lerp(1.0, 0.55, currentAdsWeight);
    // slow positional drift: gun wanders under the eye (more at hip)
    const driftScale =
      THREE.MathUtils.lerp(1.0, 0.3, currentAdsWeight) * breathFactor;
    const driftX = Math.sin(time * 0.9 + 1.3) * 0.006 * driftScale;
    const driftY = Math.sin(time * 1.2 + 0.4) * 0.004 * driftScale;

    // ---- PHYSICAL SWAY: the WHOLE gun swings as a body, not the image ----
    // Breathing is a slow chest rise/fall; walking swings the rifle like a
    // pendulum with each stride. Both feed the spring-damper BELOW as
    // rotational targets, so the gun answers with mass and the scope + world
    // + reticle all rotate together. Deliberately bigger than the old
    // hand-tuned wobble — a real rifle at the shoulder never sits still.
    const breathAmp = (isAiming ? 0.009 : 0.02) * breathFactor;
    const breathRX = Math.sin(time * 2.1 + 0.4) * breathAmp;
    const breathRY = Math.cos(time * 1.05 + 0.9) * (breathAmp * 0.55);
    const breathRR = Math.sin(time * 1.3 + 2.0) * (breathAmp * 0.4);
    // stride pendulum: roll + yaw lag with each footfall, strongest at hip,
    // still present (shoulder carries momentum) while ADS.
    const strideAmp = (isAiming ? 0.008 : 0.03) * moveBlend;
    const stepRX = Math.sin(walkPh) * strideAmp;
    const stepRY = Math.cos(walkPh * 0.5) * (strideAmp * 0.6);
    const stepRR = Math.sin(walkPh * 1.3) * (strideAmp * 0.45);

    // CHEEK WELD: the eye rides the gun. Tracking a turn shouldered keeps
    // alignment — error is a brief transient on jerks, never a standing
    // offset while turning. So: fast stiff spring (~22/s) + tight clamp.
    // Hard flicks kiss the rim; only genuinely violent jerks flash shadow.
    const springForce = isAiming ? 22.0 : 8.0;
    mouseVelocityX = THREE.MathUtils.lerp(mouseVelocityX, 0, springForce * delta);
    mouseVelocityY = THREE.MathUtils.lerp(mouseVelocityY, 0, springForce * delta);
    mouseVelocityX = THREE.MathUtils.clamp(mouseVelocityX, -0.09, 0.09);
    mouseVelocityY = THREE.MathUtils.clamp(mouseVelocityY, -0.09, 0.09);

    // LAYER 2 — acceleration kicks: this frame's mouse impulse tilts the gun
    // (roll + whisper of pitch). Steady motion holds no tilt; jerks do.
    // Impulse is consumed here, so kicks can't accumulate.
    {
      const kickT = Math.min(1, 10 * delta);
      kickRoll +=
        (THREE.MathUtils.clamp(-moveImpX * 0.0004, -0.05, 0.05) - kickRoll) * kickT;
      kickPitch +=
        (THREE.MathUtils.clamp(-moveImpY * 0.0002, -0.03, 0.03) - kickPitch) * kickT;
      moveImpX = 0;
      moveImpY = 0;
    }

    // HEAD LEAN: auto (strafe + lateral flick) + manual Q/E. Applied to
    // pitchObject so head AND gun move together — the world (inside and
    // outside the scope) tilts and shifts for corner-peeking while the optic
    // stays usable. The weapon adds its own EXTRA roll on top (below) — the
    // difference between the two is what tilts the reticle against the image.
    {
      const strafe = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);
      const leanTarget = THREE.MathUtils.clamp(
        -strafe * 0.028 - mouseVelocityX * 0.12,
        -0.06,
        0.06,
      );
      headLean += (leanTarget - headLean) * Math.min(1, 8 * delta);
      const manualTarget = (leanKeys.q ? 1 : 0) - (leanKeys.e ? 1 : 0);
      manualLean += (manualTarget - manualLean) * Math.min(1, 10 * delta);
      pitchObject.rotation.z = headLean + manualLean * 0.10;
      pitchObject.position.x = -manualLean * 0.08;
      pitchObject.position.y = -Math.abs(manualLean) * 0.02;
    }

    // LAYER 2/3 — integrate. Rotation chases (base + lag + breath + kicks),
    // position chases (anchor + bob + drift). Slightly underdamped, so the
    // shoulder lands with mass and a breath of overshoot instead of on rails.
    // ADS weight is DERIVED from where the gun is — glass follows physics.
    const baseRotY = THREE.MathUtils.lerp(0.15, 0.0, targetWeight);
    const baseRotZ = THREE.MathUtils.lerp(0.05, 0.0, targetWeight);
    {
      // Mouse lag is the eye-relief driver: the cheek weld tracks the head
      // tightly, but a rifle still carries inertia, so the gun lags the head
      // on quick movements — that relative rotation is what pushes the eye off
      // axis and opens the eye-box crescent. Breathing + stride keep the slow
      // physical sway; recoil still punches in.
      const tRX = -mouseVelocityY * 0.9 + breathRY + stepRX + kickPitch;
      const tRY = baseRotY - mouseVelocityX * 0.9 + breathRX + stepRY;
      const tRZ = baseRotZ - mouseVelocityX * 0.6 + breathRR + stepRR + kickRoll;
      const KR = 128;
      const CR = 17.0;
      const KP = 88;
      const CP = 16.8;
      wRotVel.x += ((tRX - wRot.x) * KR - wRotVel.x * CR) * delta;
      wRotVel.y += ((tRY - wRot.y) * KR - wRotVel.y * CR) * delta;
      wRotVel.z += ((tRZ - wRot.z) * KR - wRotVel.z * CR) * delta;
      wRot.x += wRotVel.x * delta;
      wRot.y += wRotVel.y * delta;
      wRot.z += wRotVel.z * delta;
      weaponGroup.rotation.set(wRot.x, wRot.y, wRot.z);
      wVel.x += ((_anchor.x + bobX + driftX - wPos.x) * KP - wVel.x * CP) * delta;
      wVel.y += ((_anchor.y + bobY + driftY - wPos.y) * KP - wVel.y * CP) * delta;
      wVel.z += ((_anchor.z + bobZ + shoulderZ - wPos.z) * KP - wVel.z * CP) * delta;
      wPos.x += wVel.x * delta;
      wPos.y += wVel.y * delta;
      wPos.z += wVel.z * delta;
      weaponGroup.position.copy(wPos);
      const dAds = wPos.distanceTo(adsPosition);
      const aw = THREE.MathUtils.clamp(1 - dAds / HIP_ADS_DIST, 0, 1);
      currentAdsWeight = aw * aw * (3 - 2 * aw);
    }
    lensMat.uniforms.uAdsWeight.value = currentAdsWeight;

    // SCOPE IMAGE STAYS LEVEL WHILE THE RETICLE ROLLS: the objective lenses
    // are rotationally symmetric, so rolling the tube around its own optical
    // axis must NOT rotate the world image — only the etched reticle (drawn
    // in the shader, rotated by uReticleRoll) tilts with the gun. Counter-
    // rolling the render camera here cancels the weapon-relative roll while
    // preserving head lean from pitchObject, so horizon "/" vs "\" comes
    // from the head and the cross "/" vs "\" comes from the gun. Correct on
    // all 3 planes: pitch/yaw flow through from the barrel, roll does not.
    scopeCamera.rotation.z = -weaponGroup.rotation.z;

    // ---- TRUE 3D EYE VECTOR: where is the eye in tube space? ----
    // eyeLocal = camera world pos expressed in weaponGroup (tube) frame.
    // x/y = lateral error (radii), z = distance behind tube origin. This
    // single vector captures hip offset, ADS alignment, sway rotations, bob
    // and breathing with correct 3-plane coupling — no hand-tuned 2D fake.
    {
      // matrices must be fresh: rotations/positions above changed this frame
      pitchObject.updateWorldMatrix(true, true);
      camera.getWorldPosition(_eyeWorld);
      _eyeLocal.copy(_eyeWorld);
      weaponGroup.worldToLocal(_eyeLocal);
      const isAcog = (lensMat.uniforms.uOpticMode.value as number) > 0.5;
      const tubeR = isAcog ? 0.0355 : tubeRadius;
      const ocularZ = isAcog ? 0.14 : 0.235;
      const optRelief = isAcog ? 0.24 : 0.145; // ADS eye-to-ocular distance
      const reliefDist = Math.max(_eyeLocal.z - ocularZ, 0.02);
      // ZOOM TIGHTENS THE EYE BOX — prominently: higher magnification = much
      // more critical eye position AND relief (true on real optics). The exit
      // pupil diameter = objective / magnification, so the eye box and the
      // usable eye relief both collapse as you crank magnification: base mag
      // reads ~1x gain, fully zoomed runs ~6x. Quadratic falloff so the
      // forgiving end drops off fast while the top end bites hard — this is
      // the "harder eye relief when zoomed" feel the shader eats up.
      const baseFov = isAcog ? ACOG_FOV : SNIPER_FOV;
      const zoomTighten = THREE.MathUtils.clamp(
        Math.pow(baseFov / config.fov, 2.0),
        0.25,
        6.0,
      );
      const relief = THREE.MathUtils.clamp(
        1 + (reliefDist / optRelief - 1) * zoomTighten,
        0.35,
        3.0,
      );

      // Distance-punished eye box: short drifts stay mostly free, long drifts
      // get punished. Base gain raised so mouse-driven weapon lag registers as
      // visible eye relief even at base zoom; zoomTighten amplifies it further.
      const rawX = _eyeLocal.x / tubeR;
      const rawY = _eyeLocal.y / tubeR;
      const rawMag = Math.hypot(rawX, rawY);
      const distGain =
        0.55 + 0.45 * THREE.MathUtils.smoothstep(rawMag, 0.3, 1.5);
      const softX = Math.tanh(rawX * 0.9) * distGain * zoomTighten;
      const softY = Math.tanh(rawY * 0.9) * distGain * zoomTighten;
      const eyeU = THREE.MathUtils.clamp(softX * 0.8, -0.3, 0.3);
      const eyeV = THREE.MathUtils.clamp(softY * 0.8, -0.3, 0.3);
      // Operator re-seat, asymmetric: the eye LOSES the box fast (attack)
      // and re-finds it slowly (release). Fast L-R flicks punch shadow in
      // on every reversal instead of averaging out to nothing.
      {
        const tgtMag = Math.hypot(eyeU, eyeV);
        const curMag = Math.hypot(_eyeSm.x, _eyeSm.y);
        const eyeRate = Math.min(1, (tgtMag > curMag ? 16 : 6) * delta);
        const relDev = Math.abs(relief - 1);
        const relCur = Math.abs(_reliefSm - 1);
        const relRate = Math.min(1, (relDev > relCur ? 12 : 5) * delta);
        _eyeSm.x += (eyeU - _eyeSm.x) * eyeRate;
        _eyeSm.y += (eyeV - _eyeSm.y) * eyeRate;
        _reliefSm += (relief - _reliefSm) * relRate;
      }
      (lensMat.uniforms.uEyeOffset.value as THREE.Vector2).copy(_eyeSm);
      lensMat.uniforms.uEyeRelief.value = _reliefSm;
      lensMat.uniforms.uZoomK.value = zoomTighten;

      // View angle = geometric eye direction + bore/eye angular mismatch.
      // eyeDir gives the positional component (ex/ez), relEuler the angular
      // component (tube tilted under a steady eye). Summed they orient the
      // foreshortening ellipse, including diagonal "/" vs "\" tilts.
      weaponGroup.getWorldQuaternion(_scopeQuat);
      camera.getWorldQuaternion(_eyeQuat);
      _relQuat.copy(_scopeQuat).invert().multiply(_eyeQuat);
      _relEuler.setFromQuaternion(_relQuat, 'XYZ');
      const eyeAngX = Math.atan2(_eyeLocal.x, Math.max(reliefDist, 1e-3));
      const eyeAngY = Math.atan2(_eyeLocal.y, Math.max(reliefDist, 1e-3));
      _viewAngle.set(
        THREE.MathUtils.clamp(eyeAngX * 0.9 + _relEuler.y, -0.65, 0.65),
        THREE.MathUtils.clamp(eyeAngY * 0.9 - _relEuler.x, -0.65, 0.65),
      );
      _viewSm.x += (_viewAngle.x - _viewSm.x) * Math.min(1, (Math.abs(_viewAngle.x) > Math.abs(_viewSm.x) ? 14 : 7) * delta);
      _viewSm.y += (_viewAngle.y - _viewSm.y) * Math.min(1, (Math.abs(_viewAngle.y) > Math.abs(_viewSm.y) ? 14 : 7) * delta);
      (lensMat.uniforms.uViewAngle.value as THREE.Vector2).copy(_viewSm);

      // Reticle roll = weapon-relative roll (gun fixed etch vs head fixed eye)
      lensMat.uniforms.uReticleRoll.value = weaponGroup.rotation.z;
    }
    lensMat.uniforms.uTime.value = time;
    skyMat.uniforms.uTime.value = time;
    // FFP sniper reticle follows magnification, ACOG stays fixed (SFP).
    // FFP is opt-in via F (off by default); ACOG ignores it entirely.
    const isAcogNow = (lensMat.uniforms.uOpticMode.value as number) > 0.5;
    lensMat.uniforms.uReticleScale.value =
      !isAcogNow && ffpEnabled
        ? THREE.MathUtils.clamp(SNIPER_FOV / config.fov, 0.35, 2.2)
        : 1.0;

    // ---- SUN / GLINT: project global directional light into scope view ----
    scopeCamera.getWorldDirection(_scopeFwd);
    _sunDir.copy(dirLight.position).normalize();
    scopeCamera.getWorldQuaternion(_scopeQuat);
    _scopeRight.set(1, 0, 0).applyQuaternion(_scopeQuat);
    _scopeUp.set(0, 1, 0).applyQuaternion(_scopeQuat);
    _sunSide.set(_sunDir.dot(_scopeRight), _sunDir.dot(_scopeUp));
    if (_sunSide.lengthSq() < 1e-4) _sunSide.set(0.4, 0.65);
    _sunSide.normalize();
    (lensMat.uniforms.uSunSide.value as THREE.Vector2).copy(_sunSide);
    const sunFacing = THREE.MathUtils.smoothstep(_scopeFwd.dot(_sunDir), -0.2, 0.9);
    const swayMag = Math.min(
      Math.hypot(mouseVelocityX, mouseVelocityY) * 4.0,
      1.0,
    );
    // ---- SUN OCCLUSION: no glare when world geometry blocks the sun ----
    // A real sun can't light the glass through a building. Raycast toward the
    // sun; fade all sun-driven effects (glare, crescent, ring, sprite) out
    // smoothly so nothing pops when the disc slips behind cover.
    camera.getWorldPosition(_camWorld);
    sunTick++;
    if (sunTick % 4 === 0) {
      sunRay.set(_camWorld, SUN_DIR);
      sunBlockedCache = sunRay.intersectObjects(occluders, false).length > 0;
    }
    sunVis += ((sunBlockedCache ? 0 : 1) - sunVis) * Math.min(1, 6 * delta);
    const facedVis = sunFacing * sunVis;
    lensMat.uniforms.uSunIntensity.value =
      0.1 + facedVis * 0.5 + swayMag * 0.2 * currentAdsWeight;
    lensMat.uniforms.uSunFacing.value = facedVis;
    (sunSprite.material as THREE.SpriteMaterial).opacity = 0.8 * sunVis;
    sunCore.position.copy(sunSprite.position);
    (sunCore.material as THREE.SpriteMaterial).opacity = facedVis * sunVis;

    // ---- TRUE PARALLAX ERROR for gameplay ----
    // Matches shader: sight clamped to 0.8*vignette, reticle = sight*sens.
    // Exported error = reticle minus image = sight*(sens-1): a whisper.
    {
      const eye = lensMat.uniforms.uEyeOffset.value as THREE.Vector2;
      const sens = lensMat.uniforms.uParallaxSens.value as number;
      const maxS = 0.485 * 0.8;
      let sx = -eye.x * 2.0;
      let sy = -eye.y * 2.0;
      const m = Math.hypot(sx, sy);
      if (m > maxS) {
        sx *= maxS / m;
        sy *= maxS / m;
      }
      parallaxError.set(sx * (sens - 1.0), sy * (sens - 1.0));
    }

    fireCd = Math.max(0, fireCd - delta);
    // held trigger in AUTO sprays at FIRE_GAP_AUTO through the same path
    if (triggerHeld && acogActive && fireAuto) tryFire();
    if (reloadT > 0) {
      reloadT -= delta;
      const p = 1 - Math.max(reloadT, 0) / RELOAD_TIME;
      // bolt throw: slides back mid-cycle, home at the end
      const throwZ = Math.sin(p * Math.PI) * 0.05;
      boltArm.position.z = 0.18 + throwZ;
      boltKnob.position.z = 0.18 + throwZ;
      boltArm.position.y = -0.195 + Math.sin(p * Math.PI) * 0.018;
      boltKnob.position.y = -0.195 + Math.sin(p * Math.PI) * 0.018;
      if (reloadT <= 0) {
        setCurAmmo(curMag());
        boltArm.position.set(0.06, -0.195, 0.18);
        boltKnob.position.set(0.088, -0.195, 0.18);
        updateAmmoUI();
      }
    }
    // trigger pull + return
    triggerPull = Math.max(0, triggerPull - delta * 8);
    trigger.position.z = 0.12 + triggerPull * 0.008;
    // flash decay
    if (flashT > 0) {
      flashT -= delta;
      (flashSprite.material as THREE.SpriteMaterial).opacity = Math.max(flashT, 0) / 0.06;
      if (flashT <= 0) flashSprite.visible = false;
    }
    // brass sim (pooled, zero allocs): gravity, floor bounce, spin, expiry
    for (const b of brassPool) {
      if (!b.active) continue;
      b.life -= delta;
      if (b.life <= 0) {
        b.active = false;
        b.m.visible = false;
        continue;
      }
      b.vel.y -= 9.8 * delta;
      b.m.position.addScaledVector(b.vel, delta);
      if (b.m.position.y < 0.007) {
        b.m.position.y = 0.007;
        b.vel.y *= -0.35;
        b.vel.x *= 0.6;
        b.vel.z *= 0.6;
        b.spin.multiplyScalar(0.6);
      }
      b.m.rotation.x += b.spin.x * delta;
      b.m.rotation.y += b.spin.y * delta;
      b.m.rotation.z += b.spin.z * delta;
    }

    // Sun glow sits at fixed distance along SUN_DIR from the main camera
    // (negligible parallax for the scope camera at this range).
    // (_camWorld already refreshed by the occlusion test above.)
    sunSprite.position.copy(_camWorld).addScaledVector(SUN_DIR, 700);

    // Shadow frustum follows the player so 2048px stays dense nearby.
    dirLight.position.copy(playerGroup.position).addScaledVector(SUN_DIR, 80);
    dirLight.target.position.copy(playerGroup.position);
    dirLight.target.updateMatrixWorld();

    // DOF focus: throttled center ray, smoothed. Raycaster sees layer 0
    // (occluders) — the layer-1 gun can never grab focus.
    focusTick++;
    if (focusTick % 6 === 0) {
      camera.getWorldPosition(_focusPos);
      camera.getWorldDirection(_focusDir);
      focusRay.set(_focusPos, _focusDir);
      const hits = focusRay.intersectObjects(occluders, false);
      const fd = hits.length > 0 ? hits[0].distance : 150;
      focusSm += (fd - focusSm) * 0.4;
    }
    dofMat.uniforms.uFocus.value = focusSm;

    renderer.setRenderTarget(scopeTarget);
    renderer.shadowMap.needsUpdate = true;
    renderer.render(scene, scopeCamera);

    // Map-view DOF pipeline: PARKED (dofMapEnabled false) — outer-ring glass
    // DOF carries the effect for now. Hysteresis on the switch so the
    // MSAA/no-MSAA crossover can't flicker; strength fades with the shoulder.
    if (dofMapEnabled && !dofActive && currentAdsWeight > 0.6) dofActive = true;
    else if (dofActive && currentAdsWeight < 0.35) dofActive = false;
    if (dofActive) {
      dofMat.uniforms.uStrength.value = currentAdsWeight;
      renderer.setRenderTarget(mainTarget);
      renderer.render(scene, camera);
      blurMat.uniforms.tSrc.value = mainTarget.texture;
      (blurMat.uniforms.uDir.value as THREE.Vector2).set(1, 0);
      (blurMat.uniforms.uTexel.value as THREE.Vector2).set(1.5 / blurA.width, 1.5 / blurA.height);
      renderer.setRenderTarget(blurA);
      renderer.render(blurScene, postCam);
      blurMat.uniforms.tSrc.value = blurA.texture;
      (blurMat.uniforms.uDir.value as THREE.Vector2).set(0, 1);
      (blurMat.uniforms.uTexel.value as THREE.Vector2).set(1.5 / blurB.width, 1.5 / blurB.height);
      renderer.setRenderTarget(blurB);
      renderer.render(blurScene, postCam);
      renderer.setRenderTarget(null);
      renderer.render(dofScene, postCam);
    } else {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    }
  }
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  sizeDofTargets();
});

import * as THREE from 'three';
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
document.body.appendChild(renderer.domElement);

scene.add(new THREE.AmbientLight(0xffffff, 0.85));
const dirLight = new THREE.DirectionalLight(0xfff2e0, 1.35);
dirLight.position.copy(SUN_DIR).multiplyScalar(50);
scene.add(dirLight);

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
      // disc + tight halo + wide haze — kept minimal on purpose
      col += vec3(1.0, 0.93, 0.82) * pow(s, 1500.0) * 2.5;
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
const _camWorld = new THREE.Vector3();

const floorGeo = new THREE.PlaneGeometry(500, 500, 20, 20);
const floorMat = new THREE.MeshStandardMaterial({ color: 0x5a6252 });
const floor = new THREE.Mesh(floorGeo, floorMat);
floor.rotation.x = -Math.PI / 2;
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
  for (let i = 0; i < BOX_COUNT; i++) {
    m.makeTranslation((Math.random() - 0.5) * 300, 5, (Math.random() - 0.5) * 300);
    boxMesh.setMatrixAt(i, m);
    boxMesh.setColorAt(i, col.setHSL(Math.random(), 0.32, 0.42));
  }
  boxMesh.instanceMatrix.needsUpdate = true;
  if (boxMesh.instanceColor) boxMesh.instanceColor.needsUpdate = true;
  // Instances spread ±150m but the base geometry bounds sit at the origin —
  // without this the whole batch vanishes whenever the origin leaves frustum.
  boxMesh.frustumCulled = false;
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

const weaponGroup = new THREE.Group();
pitchObject.add(weaponGroup);

const weaponMat = new THREE.MeshStandardMaterial({
  color: 0x4b4f55,
  roughness: 0.55,
  metalness: 0.35,
  side: THREE.DoubleSide,
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
const scopeTube = new THREE.Mesh(tubeGeo, weaponMat);
scopeTube.layers.set(1);
weaponGroup.add(scopeTube);

// Objective bell (wider toward the front/-Z)
const objBellGeo = new THREE.CylinderGeometry(0.054, 0.064, 0.1, 48, 1, true);
objBellGeo.rotateX(Math.PI / 2);
const objBell = new THREE.Mesh(objBellGeo, weaponMat);
objBell.position.set(0, 0, -0.255);
objBell.layers.set(1);
weaponGroup.add(objBell);

// Ocular bell (wider toward the eye/+Z, lens stays visible through it).
// Kept short and slim so its interior reads as a thin rim at ADS,
// not a thick black ring around the sight picture.
const ocuBellGeo = new THREE.CylinderGeometry(0.056, 0.053, 0.06, 48, 1, true);
ocuBellGeo.rotateX(Math.PI / 2);
const ocuBell = new THREE.Mesh(ocuBellGeo, weaponMat);
ocuBell.position.set(0, 0, 0.235);
ocuBell.layers.set(1);
weaponGroup.add(ocuBell);

// Turrets: elevation on top, windage on the right
const elevGeo = new THREE.CylinderGeometry(0.016, 0.018, 0.035, 24);
const elevation = new THREE.Mesh(elevGeo, weaponMat);
elevation.position.set(0, 0.068, 0.03);
elevation.layers.set(1);
weaponGroup.add(elevation);
const windGeo = new THREE.CylinderGeometry(0.016, 0.018, 0.035, 24);
windGeo.rotateZ(Math.PI / 2);
const windage = new THREE.Mesh(windGeo, weaponMat);
windage.position.set(0.068, 0, 0.03);
windage.layers.set(1);
weaponGroup.add(windage);

// Receiver: rectangular block below the barrel
const receiverGeo = new THREE.BoxGeometry(0.075, 0.16, 0.9);
const receiver = new THREE.Mesh(receiverGeo, weaponMat);
receiver.position.set(0, -0.225, 0.05);
receiver.layers.set(1);
weaponGroup.add(receiver);

// Magazine + trigger blade
const magGeo = new THREE.BoxGeometry(0.06, 0.09, 0.12);
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

  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.45), weaponMat);
  guard.position.set(0, -0.15, -0.32);
  guard.layers.set(1);
  acogGroup.add(guard);

  const aRecv = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.16, 0.6), weaponMat);
  aRecv.position.set(0, -0.225, 0.2);
  aRecv.layers.set(1);
  acogGroup.add(aRecv);

  const aRail = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.015, 0.4), weaponMat);
  aRail.position.set(0, -0.1375, 0.05);
  aRail.layers.set(1);
  acogGroup.add(aRail);

  const aMag = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.09, 0.12), weaponMat);
  aMag.position.set(0, -0.34, 0.15);
  aMag.layers.set(1);
  acogGroup.add(aMag);

  const aTrig = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.035, 0.014), weaponMat);
  aTrig.position.set(0, -0.315, 0.32);
  aTrig.layers.set(1);
  acogGroup.add(aTrig);

  // Prism housing + ocular/objective cups (optic axis stays y = 0 so ADS
  // stays centered for both rifles)
  const housing = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.075, 0.24), weaponMat);
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

    void main() {
      vec2 uv = vUv - 0.5;
      float r2 = dot(uv, uv);
      float distFromCenter = length(uv);

      float swayDist = length(uEyeOffset);

      // ---- SIGHT SLIDE + WHISPER PARALLAX ----
      // The sight (world image + etch LOCKED together) travels as one inside
      // the ocular as the weapon rotates under the eye — the whole picture
      // slides and clips into the tunnel instead of swimming internally.
      // True parallax (reticle vs world) is a ~6% whisper on top of that.
      // uParallaxSens fine-tunes the whisper only (1.06 default).
      vec2 rawSight = -uEyeOffset * 2.0;
      float maxSight = uVignetteSize * 0.8;
      vec2 sightC = length(rawSight) > maxSight ? normalize(rawSight) * maxSight : rawSight;
      vec2 imageShift = -sightC;
      vec2 imageCenter = sightC;
      vec2 reticleCenter = sightC * uParallaxSens;
      vec2 tubeCenter = -uEyeOffset * 0.55;

      // ---- 3D FORESHORTENING: tilted tube projects as an ellipse ----
      // viewAngle = combined eye-offset + bore/eye angular mismatch (radians).
      // Circles viewed at angle squash along the tilt direction: minor axis
      // lies along the offset, major stays perpendicular. Diagonal eye error
      // therefore yields a diagonally-tilted ellipse (the "/" vs "\" feel).
      float tiltMag = length(uViewAngle);
      vec2 tiltDir = tiltMag > 1e-4 ? uViewAngle / tiltMag : vec2(1.0, 0.0);
      float tiltCos = cos(min(tiltMag, 0.65));

      // ---- EYE-RELIEF APERTURE (computed early: reticle + dirt need it) ----
      // relief 1.0 = optimal. Too far shrinks the picture (scope shadow closing
      // in); too close blows it out past the ocular. Off-relief edges harden.
      // Shouldering progression is deliberately back-loaded: hip is a tiny dim
      // peephole, mid-travel is still mostly black tunnel with a sweeping
      // crescent, and the full picture only lands at the end of ADS — like
      // finding the eye box on a real optic. Do NOT linearize this.
      float eyeBox = smoothstep(0.0, 0.9, uAdsWeight);
      float reliefShrink = clamp(pow(max(uEyeRelief, 0.35), -1.1), 0.22, 1.05);
      float tooClose = smoothstep(0.35, 0.75, uEyeRelief);
      float currentAperture = uVignetteSize * reliefShrink * tooClose * mix(0.35, 1.0, eyeBox);
      float shadowK = uShadowHardness * mix(1.6, 0.8, tooClose * clamp(2.0 - uEyeRelief, 0.0, 1.0));
      // zoomed glass punishes harder: edge hardens with magnification
      shadowK *= 1.0 + (uZoomK - 1.0) * 0.25;
      // edge stays hard while shouldering, relaxes once seated in the eye box
      float transit = (1.0 - eyeBox) * smoothstep(0.0, 0.4, uAdsWeight);
      shadowK *= 1.0 + transit * 1.5;
      // reticle fades in LAST — off-axis eyes see no etch, only tunnel
      float etchVis = smoothstep(0.45, 0.9, uAdsWeight);
      // off-axis transmission collapse: hip peephole runs dark, not full-bright.
      // Zoomed glass goes dark faster off-axis: same sway costs more picture.
      float reliefDim = mix(0.25, 1.0, smoothstep(0.15, 0.95, uAdsWeight));
      reliefDim /= 1.0 + swayDist * (uZoomK - 1.0) * 1.2;

      // Subtle lateral CA: zero in center, gentle rim-only split (~2px at the
      // rim at 1024). No sway blowup — sway already moves the whole image via
      // parallax, multiplying the fringe on top looked cheap and shimmery.
      float caMask = smoothstep(0.12, 0.45, distFromCenter);
      caMask *= caMask;
      float dynamicAberration = uAberration * (0.7 + swayDist * 0.6) * caMask;

      // Rim-weighted barrel distortion: zero in the center, tiny bulge at the
      // outer circle only (~3px at the rim at ADS). Real ocular glass bends
      // the edge of the sight picture; keep it barely-there, never fisheye.
      // Distorted around the shifted image plane so glass feels volumetric.
      // Image stays UPRIGHT at hip by design: a real scope's erector lenses
      // flip the objective's inverted image before the ocular, so the eye
      // always gets an upright picture.
      vec2 imgUv = uv + imageShift;
      float rimT = smoothstep(0.15, 0.5, length(imgUv));
      float barrelK = mix(0.012, 0.008, uAdsWeight);
      vec2 baseUv = imgUv * (1.0 - barrelK * rimT * rimT);
      float br2 = dot(baseUv, baseUv);
      vec2 sampR = baseUv * (1.0 - dynamicAberration * br2);
      vec2 sampG = baseUv;
      vec2 sampB = baseUv * (1.0 + dynamicAberration * br2);

      // ---- NEUTRAL GLASS: no blue push, keep scope == world ----
      float r = texture2D(tDiffuse, sampR + 0.5).r;
      float g = texture2D(tDiffuse, sampG + 0.5).g;
      float b = texture2D(tDiffuse, sampB + 0.5).b;
      vec3 sceneColor = vec3(r, g, b);
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
      // the image (barrelK from above), so outer posts curve with the rim
      // while the center stays put. A flat overlay is what read as "plastered".
      float rimR = smoothstep(0.15, 0.5, length(rc));
      vec2 rcBent = rc * (1.0 - barrelK * rimR * rimR);
      float cR = cos(uReticleRoll);
      float sR = sin(uReticleRoll);
      vec2 rcGun = vec2(cR * rcBent.x + sR * rcBent.y, -sR * rcBent.x + cR * rcBent.y);
      // Eye-distance size cue: closer eye reads the etch slightly larger.
      vec2 p = rcGun / (uReticleScale * (0.92 + 0.08 * uEyeRelief));
      bool isAcog = uOpticMode > 0.5;

      // SNIPER etch: full thin mil cross + thick outer posts + mil dots
      float sLineX = step(abs(p.x), 0.0011) * step(abs(p.y), 0.4);
      float sLineY = step(abs(p.y), 0.0011) * step(abs(p.x), 0.4);
      float sPostX = step(abs(p.x), 0.0035) * step(0.12, abs(p.y)) * step(abs(p.y), 0.4);
      float sPostY = step(abs(p.y), 0.0035) * step(0.12, abs(p.x)) * step(abs(p.x), 0.4);
      float sDotsX = step(mod(abs(p.x) + 0.025, 0.05), 0.0025) * step(abs(p.y), 0.0025) * step(abs(p.x), 0.12);
      float sDotsY = step(mod(abs(p.y) + 0.025, 0.05), 0.0025) * step(abs(p.x), 0.0025) * step(abs(p.y), 0.12);
      float sniperEtch = clamp(sLineX + sLineY + sPostX + sPostY + sDotsX + sDotsY, 0.0, 1.0);

      // ACOG etch: short center ticks + thick outer posts only, no full cross
      float aTickX = step(abs(p.x), 0.0012) * step(abs(p.y), 0.07);
      float aTickY = step(abs(p.y), 0.0012) * step(abs(p.x), 0.07);
      float aPostX = step(abs(p.x), 0.004) * step(0.14, abs(p.y)) * step(abs(p.y), 0.4);
      float aPostY = step(abs(p.y), 0.004) * step(0.14, abs(p.x)) * step(abs(p.x), 0.4);
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
      float sniperCore = (1.0 - smoothstep(0.0016, 0.0016 + 0.001 * focusW, dChev))
        + (1.0 - smoothstep(0.0012, 0.0012 + 0.001 * focusW, length(p - apex))) * 0.7;

      // ACOG / RED DOT illumination: big glowing dot + horseshoe ring
      float dDot = length(p);
      float dotCore = 1.0 - smoothstep(0.0035, 0.0035 + 0.002 * focusW, dDot);
      float dRing = abs(dDot - 0.032);
      float ringAng = atan(p.y, p.x); // horseshoe gap at bottom (angle ~ -PI/2)
      float ringGate = smoothstep(0.3, 0.55, abs(ringAng + 1.5708));
      float horseCore = (1.0 - smoothstep(0.0018, 0.0018 + 0.0014 * focusW, dRing)) * ringGate;
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
        // faint cool ghost orb, mirrored opposite the sun side
        vec2 gPos = -gSun * 0.16 + imageCenter;
        float ghost = 1.0 - smoothstep(0.0, 0.045, length(uv - gPos));
        sceneColor += vec3(0.85, 0.92, 1.0) * ghost * glare * uSunFacing * 0.03 * reticleVis;
      }

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
      // a centered eye sees a clean full picture. Evaluated in the same
      // elliptical metric as the aperture so the crescent follows the tilt.
      {
        float eyeMag = length(uEyeOffset);
        vec2 eyeDir = eyeMag > 1e-4 ? uEyeOffset / eyeMag : vec2(0.0);
        float sideProj = dot(uv - tubeCenter, eyeDir);
        float crescentEdge = currentAperture * (1.0 - eyeMag * 2.8);
        float eyeShadow = smoothstep(crescentEdge - shadowK, crescentEdge, sideProj)
          * smoothstep(0.015, 0.10, eyeMag);
        objectiveMask = max(objectiveMask, eyeShadow);
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
      // thin objective-bell crescent right at the image edge, sun side only
      float crescentLine = 1.0 - smoothstep(0.0, 0.022, abs(distTube - currentAperture));
      float crescent = crescentLine * pow(max(dot(tubeN, sunN) * 0.5 + 0.5, 0.0), 6.0);
      tubeWall += vec3(1.0, 0.94, 0.84) * crescent * uSunFacing * 0.12 * objectiveMask;

      // faint travelling sheen with sway (oily glass edge, not lit paint)
      float innerRefl = pow(max(dot(tubeN, sweepDir) * 0.5 + 0.5, 0.0), 12.0) * swayDist * 0.35;
      tubeWall += vec3(0.09, 0.09, 0.09) * innerRefl * objectiveMask;

      // Machined baffle ridges: concentric rings darken the wall in bands and
      // catch a hairline highlight on the sun side at glancing angles.
      // transitBoost: looking down the tube at an angle mid-shoulder, the
      // rings catch light and read as depth — once seated they go near-black.
      float transitBoost = (1.0 + transit * 1.2) * (1.0 + (uZoomK - 1.0) * 0.3);
      float baffles = 0.5 + 0.5 * sin(distTube * 240.0);
      tubeWall *= (0.82 + 0.18 * baffles);
      // depth falloff: the far end of the tunnel falls darker (tube length read)
      tubeWall *= mix(1.0, 0.55, smoothstep(currentAperture, 0.5, distTube));
      tubeWall += vec3(0.5, 0.44, 0.38) * pow(baffles, 8.0) * sunSideLight * uSunFacing * 0.12 * objectiveMask * transitBoost;

      // Lens-coating sheen (MgF2-style): faint magenta/green shift that only
      // exists near the rim and swings hue with the sun side. Dies head-on.
      {
        float sheenAmt = smoothstep(0.28, 0.5, distFromCenter) * (0.2 + 0.8 * uSunIntensity) * 0.08;
        vec3 coat = mix(vec3(1.0, 0.35, 0.9), vec3(0.35, 1.0, 0.55), 0.5 + 0.5 * dot(tubeN, sunN));
        sceneColor += coat * sheenAmt * (1.0 - objectiveMask);
      }

      vec3 viewWithTunnel = mix(sceneColor, tubeWall, objectiveMask);

      // ocular rim: hard clip + one minimal thin sun-line on the very edge
      float ocularShadow = smoothstep(0.485, 0.5, distOcular);
      float ringBand = 1.0 - smoothstep(0.0, 0.006, abs(distOcular - 0.48));
      vec2 ocuN = distOcular > 1e-4 ? uv / distOcular : vec2(0.0, 1.0);
      float ringGlint = pow(max(dot(ocuN, sunN) * 0.5 + 0.5, 0.0), 3.0);
      vec3 ringLight = vec3(0.92, 0.92, 0.92) * ringBand * ringGlint * (0.06 + uSunIntensity * 0.45);
      // keep opposite side dark for roundness
      float ringShade = pow(max(dot(ocuN, -sunN) * 0.5 + 0.5, 0.0), 2.0);
      viewWithTunnel -= vec3(0.05) * ringBand * ringShade;
      viewWithTunnel += ringLight;

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

  mouseVelocityX += movementX * 0.001 * fovRatio;
  mouseVelocityY += movementY * 0.001 * fovRatio;
});

document.addEventListener('mousedown', (e: MouseEvent) => {
  if (e.button === 2) isAiming = true;
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
  config.fov = acog ? ACOG_FOV : SNIPER_FOV;
  scopeCamera.fov = config.fov;
  // Objective station differs per housing (sniper bell vs ACOG cup)
  scopeCamera.position.z = acog ? -0.14 : -(tubeLength / 2);
  scopeCamera.updateProjectionMatrix();
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
  if (k === 'shift') breathHeld = true;
});
document.addEventListener('keyup', (e: KeyboardEvent) => {
  const k = e.key.toLowerCase();
  if (isMoveKey(k)) keys[k] = false;
  if (isLeanKey(k)) leanKeys[k] = false;
  if (k === 'shift') breathHeld = false;
});

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
    // slow positional drift: gun wanders under the eye (more at hip)
    const driftScale =
      THREE.MathUtils.lerp(1.0, 0.3, currentAdsWeight) * breathFactor;
    const driftX = Math.sin(time * 0.9 + 1.3) * 0.006 * driftScale;
    const driftY = Math.sin(time * 1.2 + 0.4) * 0.004 * driftScale;

    const swayMul = (isAiming ? 0.005 : 0.015) * breathFactor;
    const breathRX = Math.sin(time * 2.0) * swayMul;
    const breathRY = Math.cos(time * 1.0) * (swayMul * 0.5);

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
      const tRX = -mouseVelocityY + breathRY + kickPitch;
      const tRY = baseRotY - mouseVelocityX + breathRX;
      const tRZ = baseRotZ - mouseVelocityX * 0.75 + kickRoll;
      const KR = 160;
      const CR = 20.0;
      const KP = 110;
      const CP = 18.9;
      wRotVel.x += ((tRX - wRot.x) * KR - wRotVel.x * CR) * delta;
      wRotVel.y += ((tRY - wRot.y) * KR - wRotVel.y * CR) * delta;
      wRotVel.z += ((tRZ - wRot.z) * KR - wRotVel.z * CR) * delta;
      wRot.x += wRotVel.x * delta;
      wRot.y += wRotVel.y * delta;
      wRot.z += wRotVel.z * delta;
      weaponGroup.rotation.set(wRot.x, wRot.y, wRot.z);
      wVel.x += ((_anchor.x + bobX + driftX - wPos.x) * KP - wVel.x * CP) * delta;
      wVel.y += ((_anchor.y + bobY + driftY - wPos.y) * KP - wVel.y * CP) * delta;
      wVel.z += ((_anchor.z + bobZ - wPos.z) * KP - wVel.z * CP) * delta;
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
      // more critical eye position AND relief (true on real optics). Base mag
      // reads 1.0; fully zoomed runs ~4x gain, zoomed out ~0.25x — down there
      // it's just glass, barely an eye-relief problem. Quadratic falloff so
      // the forgiving end drops off fast while the top end bites hard.
      const baseFov = isAcog ? ACOG_FOV : SNIPER_FOV;
      const zoomTighten = THREE.MathUtils.clamp(
        Math.pow(baseFov / config.fov, 2.0),
        0.25,
        4.0,
      );
      const relief = THREE.MathUtils.clamp(
        1 + (reliefDist / optRelief - 1) * zoomTighten,
        0.35,
        3.0,
      );

      // Distance-punished eye box: short drifts stay nearly free (gain ~0.25),
      // long drifts get punished (gain → 1.0+). Small corrections keep a
      // clean picture; only genuinely long sways close the shadow hard.
      const rawX = _eyeLocal.x / tubeR;
      const rawY = _eyeLocal.y / tubeR;
      const rawMag = Math.hypot(rawX, rawY);
      const distGain =
        0.3 + 0.7 * THREE.MathUtils.smoothstep(rawMag, 0.4, 1.8);
      const softX = Math.tanh(rawX * 0.9) * distGain * zoomTighten;
      const softY = Math.tanh(rawY * 0.9) * distGain * zoomTighten;
      const eyeU = THREE.MathUtils.clamp(softX * 0.6, -0.3, 0.3);
      const eyeV = THREE.MathUtils.clamp(softY * 0.6, -0.3, 0.3);
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

    // Sun glow sits at fixed distance along SUN_DIR from the main camera
    // (negligible parallax for the scope camera at this range).
    // (_camWorld already refreshed by the occlusion test above.)
    sunSprite.position.copy(_camWorld).addScaledVector(SUN_DIR, 700);

    renderer.setRenderTarget(scopeTarget);
    renderer.render(scene, scopeCamera);

    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
  }
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

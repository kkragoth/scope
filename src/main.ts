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
    varying vec3 vDir;
    void main() {
      vec3 d = normalize(vDir);
      float h = d.y;
      vec3 zen = vec3(0.16, 0.30, 0.52);
      vec3 hor = vec3(0.76, 0.79, 0.81);
      vec3 gnd = vec3(0.32, 0.31, 0.28);
      vec3 col = mix(hor, zen, pow(max(h, 0.0), 0.55));
      col = mix(col, gnd, smoothstep(0.0, -0.35, h));
      float s = max(dot(d, uSunDir), 0.0);
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
const occluders: THREE.Object3D[] = [floor];
for (let i = 0; i < 150; i++) {
  const boxMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(Math.random(), 0.32, 0.42),
  });
  const box = new THREE.Mesh(boxGeo, boxMat);
  box.position.set(
    (Math.random() - 0.5) * 300,
    5,
    (Math.random() - 0.5) * 300,
  );
  scene.add(box);
  occluders.push(box);
}

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

const scopeTarget = new THREE.WebGLRenderTarget(1024, 1024, {
  format: THREE.RGBAFormat,
});

const scopeCamera = new THREE.PerspectiveCamera(3.0, 1, 0.1, 1000);
scopeCamera.layers.set(0);
scopeCamera.position.z = -(tubeLength / 2);
weaponGroup.add(scopeCamera);

const lensGeo = new THREE.CircleGeometry(tubeRadius - 0.0005, 64);
const lensMat = new THREE.ShaderMaterial({
  uniforms: {
    tDiffuse: { value: scopeTarget.texture },
    uAberration: { value: 0.018 },
    uVignetteSize: { value: 0.485 },
    uShadowHardness: { value: 0.06 },
    uParallaxSens: { value: 4.5 },
    uEyeOffset: { value: new THREE.Vector2(0, 0) },
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
    uniform float uAberration;
    uniform float uVignetteSize;
    uniform float uShadowHardness;
    uniform float uParallaxSens;
    uniform vec2 uEyeOffset;
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
    varying vec2 vUv;

    float hash21(vec2 p) {
      p = fract(p * vec2(234.34, 435.345));
      p += dot(p, p + 34.23);
      return fract(p.x * p.y);
    }
    float vnoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      float a = hash21(i);
      float b = hash21(i + vec2(1.0, 0.0));
      float c = hash21(i + vec2(0.0, 1.0));
      float d = hash21(i + vec2(1.0, 1.0));
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }
    float fbm(vec2 p) {
      float v = 0.0;
      float a = 0.5;
      for (int i = 0; i < 3; i++) {
        v += a * vnoise(p);
        p *= 2.03;
        a *= 0.5;
      }
      return v;
    }
    float sdSegment(vec2 p, vec2 a, vec2 b) {
      vec2 pa = p - a;
      vec2 ba = b - a;
      float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
      return length(pa - ba * h);
    }

    void main() {
      vec2 uv = vUv - 0.5;
      float r2 = dot(uv, uv);
      float distFromCenter = length(uv);

      float swayDist = length(uEyeOffset);

      // ---- TRUE PARALLAX: 3 depth planes ----
      // image plane drifts modestly with eye, reticle plane drifts hard opposite.
      // differential = parallax error (reticle vs point-of-impact).
      vec2 imageShift = uEyeOffset * 1.1;
      vec2 reticleCenter = -uEyeOffset * uParallaxSens;
      float maxShift = uVignetteSize * 0.55;
      if (length(reticleCenter) > maxShift) {
        reticleCenter = normalize(reticleCenter) * maxShift;
      }
      vec2 tubeCenter = -uEyeOffset * 0.55;
      vec2 imageCenter = -uEyeOffset * 1.0;

      // Edge-only chromatic aberration: zero in center, ramps to rim.
      // caMask stays 0 until ~1/4 radius, then rises quadratically, and the
      // resulting R/B split is a multiple of ir2 — so the rim (ir2 ~ 0.24)
      // gets a clearly visible ~4px fringe while the center stays clean.
      float caMask = smoothstep(0.08, 0.44, distFromCenter);
      caMask *= caMask;
      float dynamicAberration = (uAberration + swayDist * 1.2) * caMask;

      float currentDistortion = mix(0.7, 0.05, uAdsWeight);

      // Distort around the shifted image plane so glass feels volumetric.
      // Image stays UPRIGHT at hip by design (see debate below): a real scope's
      // erector lenses flip the objective's inverted image before the ocular,
      // so the eye always gets an upright picture. Inverting at hip would be
      // the physically wrong call — the true hip unrealism is that you see a
      // transmitted picture at all (real glass would show mirror reflections
      // + total scope shadow off-axis), kept as a gameplay concession.
      vec2 imgUv = uv + imageShift;
      float ir2 = dot(imgUv, imgUv);
      vec2 sampR = imgUv * (1.0 + (currentDistortion - dynamicAberration) * ir2);
      vec2 sampG = imgUv * (1.0 + currentDistortion * ir2);
      vec2 sampB = imgUv * (1.0 + (currentDistortion + dynamicAberration) * ir2);

      // ---- NEUTRAL GLASS: no blue push, keep scope == world ----
      float r = texture2D(tDiffuse, sampR + 0.5).r;
      float g = texture2D(tDiffuse, sampG + 0.5).g;
      float b = texture2D(tDiffuse, sampB + 0.5).b;
      vec3 sceneColor = vec3(r, g, b);
      sceneColor *= uGlassTint;

      // ---- LENS SMUDGE & DIRT: ultra-subtle, glint-only ----
      // uDirtOpacity ~0.05 by default: effectively invisible unless sun catches it.
      float dust = fbm(vUv * 14.0 + 7.3);
      dust = smoothstep(0.74, 0.96, dust);
      float smudge = fbm(vUv * 3.2 + vec2(2.1, 5.7));
      smudge = smoothstep(0.68, 0.93, smudge);
      float scr1 = vnoise(vec2(vUv.x * 260.0, vUv.y * 26.0));
      float scr2 = vnoise(vec2(vUv.x * 24.0, vUv.y * 240.0));
      float scratches = smoothstep(0.985, 1.0, scr1) + smoothstep(0.986, 1.0, scr2);
      scratches = clamp(scratches, 0.0, 1.0);
      float dirtMask = clamp(dust * 0.4 + smudge * 0.35 + scratches * 0.6, 0.0, 1.0);

      // Dirt only lights up at glancing sun/eye angles, capped very low
      vec2 safeUv = uv + vec2(1e-4);
      vec2 sweepDir = normalize(uSunSide + uEyeOffset * 4.0 + vec2(1e-4));
      float sweep = pow(max(dot(normalize(safeUv), sweepDir) * 0.5 + 0.5, 0.0), 6.0);
      float dirtLightAmt = (0.004 + uSunIntensity * 0.05 + sweep * (0.02 + swayDist * 0.6)) * uDirtOpacity * 20.0;
      dirtLightAmt = min(dirtLightAmt, 0.06);
      vec3 dirtColor = vec3(1.0, 0.99, 0.96);
      float inImage = 1.0 - smoothstep(uVignetteSize - uShadowHardness, uVignetteSize, length(uv - imageCenter));
      sceneColor += dirtMask * dirtLightAmt * dirtColor * inImage;

      // Diagonal sun-streak flare across glass (scope glint), barely-there
      float flareBand = 1.0 - smoothstep(0.0, 0.09, abs(dot(uv, vec2(-sweepDir.y, sweepDir.x))));
      float flare = flareBand * sweep * uSunIntensity * 0.06 * inImage;
      sceneColor += flare * vec3(1.0, 0.99, 0.96);

      // ---- RETICLE: uOpticMode 0 = sniper mil-lines, 1 = ACOG / red dot ----
      // NOTE: scope image is intentionally NOT mirrored/inverted. Real rifle
      // scopes erect the image (upright), and our render-target camera looks
      // forward along the barrel, so upright sampling here is correct. At hip
      // you see the ocular at an angle — perspective foreshortening handles
      // that, no texture flip needed. Do not "fix" by flipping vUv.
      vec2 p = uv - reticleCenter;
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

      // SNIPER illumination: small chevron, apex = point of impact
      vec2 apex = vec2(0.0, 0.004);
      vec2 footL = vec2(-0.02, -0.016);
      vec2 footR = vec2(0.02, -0.016);
      float dChev = min(sdSegment(p, apex, footL), sdSegment(p, apex, footR));
      float sniperCore = (1.0 - smoothstep(0.0016, 0.0026, dChev))
        + (1.0 - smoothstep(0.0012, 0.0022, length(p - apex))) * 0.7;

      // ACOG / RED DOT illumination: big glowing dot + horseshoe ring
      float dDot = length(p);
      float dotCore = 1.0 - smoothstep(0.0035, 0.0055, dDot);
      float dRing = abs(dDot - 0.032);
      float ringAng = atan(p.y, p.x); // horseshoe gap at bottom (angle ~ -PI/2)
      float ringGate = smoothstep(0.3, 0.55, abs(ringAng + 1.5708));
      float horseCore = (1.0 - smoothstep(0.0018, 0.0032, dRing)) * ringGate;
      float acogCore = clamp(dotCore + horseCore, 0.0, 1.0);

      float illumMask = isAcog ? acogCore : clamp(sniperCore, 0.0, 1.0);

      // bloom: tight halo in dark environments (battery bleed)
      // ACOG dot blooms wider than the sniper chevron on purpose.
      float haloDist = isAcog ? min(dDot * 0.55, dRing + 0.012) : dChev;
      float halo = exp(-haloDist * 90.0) * 0.55 + exp(-length(p) * 22.0) * 0.12;
      float darkFactor = 1.0 - smoothstep(0.04, 0.42, dot(sceneColor, vec3(0.299, 0.587, 0.114)));
      float glowStrength = (0.55 + darkFactor * 2.2) * uBattery;

      float reticleVis = 1.0 - smoothstep(uVignetteSize - uShadowHardness, uVignetteSize, length(uv - imageCenter));
      sceneColor = mix(sceneColor, vec3(0.0), etchedMask * 0.82 * reticleVis);
      // illuminated chevron sits on top of etch
      sceneColor += uReticleColor * illumMask * glowStrength * reticleVis;
      sceneColor += uReticleColor * halo * glowStrength * 0.5 * reticleVis;
      // battery bleed: faint colored wash on surrounding glass (kept tiny so
      // it never lifts/washes the sight picture)
      sceneColor += uReticleColor * (halo * 0.12 + 0.004) * uBattery * reticleVis;

      // ---- VEILING GLARE: sun washes the IMAGE, not the tube ----
      // Real optics bloom the picture when aimed near the sun; the baffled
      // tube itself stays black. So glare lifts sceneColor here, while the
      // tube wall below stays near-black with only an edge crescent.
      {
        vec2 gSun = length(uSunSide) > 1e-4 ? normalize(uSunSide) : vec2(0.4, 0.65);
        float glare = uSunFacing * uSunFacing * uSunFacing;
        sceneColor += vec3(1.0, 0.96, 0.90) * glare * 0.035 * reticleVis;
        // faint cool ghost orb, mirrored opposite the sun side
        vec2 gPos = -gSun * 0.16 + imageCenter;
        float ghost = 1.0 - smoothstep(0.0, 0.045, length(uv - gPos));
        sceneColor += vec3(0.85, 0.92, 1.0) * ghost * glare * uSunFacing * 0.05 * reticleVis;
      }

      // ---- 3D TUNNEL: matte-black baffled tube + edge crescent + rim glint ----
      // NOTE (gameplay, NOT realism — DO NOT "fix" to a smaller value):
      // a real scope at hip / off eye-relief would be ~80%+ black. We keep the
      // hip aperture at ~50% diameter so the player still sees the sight
      // picture when not aiming down sights.
      float currentAperture = mix(uVignetteSize * 0.5, uVignetteSize, smoothstep(0.1, 0.8, uAdsWeight));
      float distImg = length(uv - imageCenter);
      float distTube = length(uv - tubeCenter);
      float distOcular = length(uv);

      float objectiveMask = smoothstep(currentAperture - uShadowHardness, currentAperture, distImg);

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

      // Sight-picture brightness: center ~neutral, only a whisper of falloff
      // on the outside of the circle toward the rim. Never lift the image.
      float brightT = smoothstep(0.0, uVignetteSize, length(uv - imageCenter));
      finalColor *= mix(1.01, 0.95, brightT);

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
weaponGroup.add(lens);

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

type MoveKey = 'w' | 'a' | 's' | 'd';
const keys: Record<MoveKey, boolean> = { w: false, a: false, s: false, d: false };

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

  playerGroup.rotation.y -= movementX * currentSens;
  pitchObject.rotation.x -= movementY * currentSens;
  pitchObject.rotation.x = Math.max(
    -Math.PI / 2,
    Math.min(Math.PI / 2, pitchObject.rotation.x),
  );

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

// Reticle illumination state (C toggles red/green, B toggles battery)
// Optic state (1 = sniper scope, 2 = ACOG / red dot)
let reticleIsGreen = false;
const RETICLE_RED = new THREE.Color(1.0, 0.16, 0.05);
const RETICLE_GREEN = new THREE.Color(0.25, 1.0, 0.35);
const SNIPER_FOV = 3.0;
const ACOG_FOV = 9.0;

function setOpticMode(acog: boolean): void {
  lensMat.uniforms.uOpticMode.value = acog ? 1.0 : 0.0;
  config.fov = acog ? ACOG_FOV : SNIPER_FOV;
  scopeCamera.fov = config.fov;
  scopeCamera.updateProjectionMatrix();
}

document.addEventListener('keydown', (e: KeyboardEvent) => {
  const k = e.key.toLowerCase();
  if (isMoveKey(k)) keys[k] = true;
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
});
document.addEventListener('keyup', (e: KeyboardEvent) => {
  const k = e.key.toLowerCase();
  if (isMoveKey(k)) keys[k] = false;
});

const clock = new THREE.Clock();

// Scratch objects to avoid per-frame allocation
const _scopeFwd = new THREE.Vector3();
const _sunDir = new THREE.Vector3();
const _scopeRight = new THREE.Vector3();
const _scopeUp = new THREE.Vector3();
const _sunSide = new THREE.Vector2();
const _scopeQuat = new THREE.Quaternion();
// Sun occlusion test (1 = visible, 0 = blocked; smoothed per-frame)
const sunRay = new THREE.Raycaster();
sunRay.far = 800;
let sunVis = 1.0;
// Exposed for gameplay: true point-of-impact error caused by parallax.
// Bullet logic should add this (in lens UV units) scaled to world.
export const parallaxError = new THREE.Vector2(0, 0);

function animate(): void {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  const time = clock.getElapsedTime();

  if (document.pointerLockElement === document.body) {
    const speed = 15 * delta;
    const moveDir = new THREE.Vector3();
    if (keys.w) moveDir.z -= 1;
    if (keys.s) moveDir.z += 1;
    if (keys.a) moveDir.x -= 1;
    if (keys.d) moveDir.x += 1;

    moveDir.normalize().multiplyScalar(speed);
    moveDir.applyEuler(new THREE.Euler(0, playerGroup.rotation.y, 0));
    playerGroup.position.add(moveDir);

    const targetMainFov = isAiming ? 55 : 70;
    camera.fov += (targetMainFov - camera.fov) * 12 * delta;
    camera.updateProjectionMatrix();

    const targetWeight = isAiming ? 1.0 : 0.0;
    currentAdsWeight += (targetWeight - currentAdsWeight) * 15.0 * delta;
    weaponGroup.position.lerpVectors(hipPosition, adsPosition, currentAdsWeight);

    lensMat.uniforms.uAdsWeight.value = currentAdsWeight;

    const springForce = isAiming ? 20.0 : 5.0;
    mouseVelocityX = THREE.MathUtils.lerp(mouseVelocityX, 0, springForce * delta);
    mouseVelocityY = THREE.MathUtils.lerp(mouseVelocityY, 0, springForce * delta);
    mouseVelocityX = THREE.MathUtils.clamp(mouseVelocityX, -0.25, 0.25);
    mouseVelocityY = THREE.MathUtils.clamp(mouseVelocityY, -0.25, 0.25);

    const swayMultiplier = isAiming ? 0.001 : 0.015;
    const breathX = Math.sin(time * 2.0) * swayMultiplier;
    const breathY = Math.cos(time * 1.0) * (swayMultiplier * 0.5);

    // DYNAMIC ALIGNMENT: Gun points slightly left/inward when at hip to converge on screen center
    const baseRotY = THREE.MathUtils.lerp(0.15, 0.0, currentAdsWeight);
    const baseRotZ = THREE.MathUtils.lerp(0.05, 0.0, currentAdsWeight);

    weaponGroup.rotation.y = baseRotY - mouseVelocityX + breathX;
    weaponGroup.rotation.x = -mouseVelocityY + breathY;
    weaponGroup.rotation.z = baseRotZ - mouseVelocityX * 0.5;

    // 3D PLANAR ROLL: Counter-roll the scope camera relative to the weapon sway.
    // This makes the world rotate inside the lens when you move the mouse horizontally.
    scopeCamera.rotation.z = -weaponGroup.rotation.z;

    (lensMat.uniforms.uEyeOffset.value as THREE.Vector2).set(
      -mouseVelocityX,
      mouseVelocityY,
    );
    lensMat.uniforms.uTime.value = time;

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
    sunRay.set(_camWorld, SUN_DIR);
    const sunBlocked = sunRay.intersectObjects(occluders, false).length > 0;
    sunVis += ((sunBlocked ? 0 : 1) - sunVis) * Math.min(1, 6 * delta);
    const facedVis = sunFacing * sunVis;
    lensMat.uniforms.uSunIntensity.value =
      0.1 + facedVis * 0.5 + swayMag * 0.2 * currentAdsWeight;
    lensMat.uniforms.uSunFacing.value = facedVis;
    (sunSprite.material as THREE.SpriteMaterial).opacity = 0.8 * sunVis;

    // ---- TRUE PARALLAX ERROR for gameplay ----
    // Matches shader: reticleCenter(-eye*sens, clamped) vs imageCenter(-eye*1.0).
    // Difference = apparent reticle drift off the true point of impact.
    {
      const ex = -mouseVelocityX * -1;
      const eye = lensMat.uniforms.uEyeOffset.value as THREE.Vector2;
      const sens = lensMat.uniforms.uParallaxSens.value as number;
      const rx = THREE.MathUtils.clamp(-eye.x * sens, -0.267, 0.267);
      const ry = THREE.MathUtils.clamp(-eye.y * sens, -0.267, 0.267);
      const ix = -eye.x * 1.0;
      const iy = -eye.y * 1.0;
      parallaxError.set(rx - ix, ry - iy);
      void ex;
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

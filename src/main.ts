import * as THREE from 'three';
import './style.css';

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.FogExp2(0x87ceeb, 0.005);

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
document.body.appendChild(renderer.domElement);

scene.add(new THREE.AmbientLight(0x404040, 1.5));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(10, 20, 10);
scene.add(dirLight);

const floorGeo = new THREE.PlaneGeometry(500, 500, 20, 20);
const floorMat = new THREE.MeshStandardMaterial({ color: 0x334433 });
const floor = new THREE.Mesh(floorGeo, floorMat);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

const boxGeo = new THREE.BoxGeometry(2, 10, 2);
for (let i = 0; i < 150; i++) {
  const boxMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(Math.random(), 0.8, 0.5),
  });
  const box = new THREE.Mesh(boxGeo, boxMat);
  box.position.set(
    (Math.random() - 0.5) * 300,
    5,
    (Math.random() - 0.5) * 300,
  );
  scene.add(box);
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
  color: 0x090909,
  roughness: 0.8,
  metalness: 0.5,
  side: THREE.DoubleSide,
});

// Scope Tube
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

// Gun Body
const bodyGeo = new THREE.BoxGeometry(0.07, 0.18, 0.85);
const gunBody = new THREE.Mesh(bodyGeo, weaponMat);
gunBody.position.set(0, -0.18, 0.15);
gunBody.layers.set(1);
weaponGroup.add(gunBody);

// Gun Barrel
const barrelGeo = new THREE.CylinderGeometry(0.025, 0.03, 1.8, 32);
barrelGeo.rotateX(Math.PI / 2);
const gunBarrel = new THREE.Mesh(barrelGeo, weaponMat);
gunBarrel.position.set(0, -0.12, -1.0);
gunBarrel.layers.set(1);
weaponGroup.add(gunBarrel);

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
    uAberration: { value: 0.015 },
    uVignetteSize: { value: 0.485 },
    uShadowHardness: { value: 0.05 },
    uParallaxSens: { value: 4.5 },
    uEyeOffset: { value: new THREE.Vector2(0, 0) },
    uAdsWeight: { value: 0.0 },
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
    varying vec2 vUv;

    void main() {
      vec2 uv = vUv - 0.5;
      float r2 = dot(uv, uv);

      float swayDist = length(uEyeOffset);
      float distFromCenter = length(uv);

      // CHROMATIC ABERRATION: Prominent only on the outer layer and scales with movement
      float dynamicAberration = (uAberration + swayDist * 4.0) * (distFromCenter * 3.0);

      // DYNAMIC DISTORTION: Heavy fisheye when hipfiring, flattens out when aligned (ADS)
      float currentDistortion = mix(0.7, 0.05, uAdsWeight);

      vec2 uvR = uv * (1.0 + currentDistortion * r2);
      vec2 uvG = uv * (1.0 + (currentDistortion + dynamicAberration) * r2);
      vec2 uvB = uv * (1.0 + (currentDistortion + dynamicAberration * 2.0) * r2);

      float r = texture2D(tDiffuse, uvR + 0.5).r;
      float g = texture2D(tDiffuse, uvG + 0.5).g;
      float b = texture2D(tDiffuse, uvB + 0.5).b;
      vec3 sceneColor = vec3(r, g, b);

      vec2 objCenter = -uEyeOffset * uParallaxSens;
      float maxShift = uVignetteSize * 0.5;
      if(length(objCenter) > maxShift) {
        objCenter = normalize(objCenter) * maxShift;
      }

      // 3D CROSSHAIR
      vec2 reticleUv = uv - objCenter;
      float lineX = step(abs(reticleUv.x), 0.0015) * step(abs(reticleUv.y), 0.4);
      float lineY = step(abs(reticleUv.y), 0.0015) * step(abs(reticleUv.x), 0.4);
      float postX = step(abs(reticleUv.x), 0.004) * step(0.12, abs(reticleUv.y)) * step(abs(reticleUv.y), 0.4);
      float postY = step(abs(reticleUv.y), 0.004) * step(0.12, abs(reticleUv.x)) * step(abs(reticleUv.x), 0.4);
      float dotsX = step(mod(abs(reticleUv.x) + 0.025, 0.05), 0.0025) * step(abs(reticleUv.y), 0.0025) * step(abs(reticleUv.x), 0.12);
      float dotsY = step(mod(abs(reticleUv.y) + 0.025, 0.05), 0.0025) * step(abs(reticleUv.x), 0.0025) * step(abs(reticleUv.y), 0.12);

      float reticleMask = clamp(lineX + lineY + postX + postY + dotsX + dotsY, 0.0, 1.0);

      // PURE MATTE BLACK EYE RELIEF (No Grey Tube)
      float currentAperture = mix(uVignetteSize * 0.15, uVignetteSize, smoothstep(0.1, 0.8, uAdsWeight));
      float distToObj = length(reticleUv);

      float objectiveMask = smoothstep(currentAperture - uShadowHardness, currentAperture, distToObj);

      // Reticle mixed under the shadow
      sceneColor = mix(sceneColor, vec3(0.0), reticleMask * (1.0 - objectiveMask));

      // Pure black tunnel wall clipping
      vec3 viewWithTunnel = mix(sceneColor, vec3(0.0), objectiveMask);

      // Hard outer ocular rim clipping
      float ocularShadow = smoothstep(0.485, 0.5, length(uv));
      vec3 finalColor = mix(viewWithTunnel, vec3(0.0), ocularShadow);

      gl_FragColor = vec4(finalColor, 1.0);
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

const hipPosition = new THREE.Vector3(0.22, -0.22, -0.55);
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

document.addEventListener('keydown', (e: KeyboardEvent) => {
  const k = e.key.toLowerCase();
  if (isMoveKey(k)) keys[k] = true;
});
document.addEventListener('keyup', (e: KeyboardEvent) => {
  const k = e.key.toLowerCase();
  if (isMoveKey(k)) keys[k] = false;
});

const clock = new THREE.Clock();

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

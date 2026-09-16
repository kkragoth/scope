import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

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

export { scene, SUN_DIR, camera, renderer, dirLight };

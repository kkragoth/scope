import * as THREE from 'three';
import { SUN_DIR, scene } from '@/core/boot';
import skyVert from '@/shaders/sky.vert?raw';
import skyFrag from '@/shaders/sky.frag?raw';

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
    vertexShader: skyVert,
    fragmentShader: skyFrag,
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
      v < 0.45
          ? 'rgba(60,62,44,0.35)'
          : v < 0.8
              ? 'rgba(150,152,124,0.30)'
              : 'rgba(96,88,66,0.35)';
        ctx.fillRect(Math.random() * S, Math.random() * S, 1.5, 1.5);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(48, 48);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}
const floorMat = new THREE.MeshStandardMaterial({
    map: makeGroundTexture(),
    roughness: 1.0,
});
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
        m.makeTranslation(
            (Math.random() - 0.5) * 300,
            5,
            (Math.random() - 0.5) * 300,
        );
        boxMesh.setMatrixAt(i, m);
        const p = pal[(Math.random() * pal.length) | 0];
        boxMesh.setColorAt(
            i,
            col.setHSL(
                p[0] + (Math.random() - 0.5) * 0.02,
                p[1],
                0.3 + Math.random() * 0.15,
            ),
        );
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

export {
    skyMat,
    skyDome,
    sunSprite,
    sunCore,
    floor,
    boxMesh,
    occluders,
    _camWorld,
};

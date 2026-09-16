import * as THREE from 'three';
import { SUN_DIR } from '@/core/boot';
import { weaponGroup } from '@/core/player';
import { tubeLength, tubeRadius } from '@/weapons/sniper';
import { acogGroup, sniperGroup } from '@/weapons/groups';
import { scopeTarget } from '@/optics/targets';
import lensVert from '@/shaders/lens.vert?raw';
import lensFrag from '@/shaders/lens.frag?raw';
import glassVert from '@/shaders/glass.vert?raw';
import glassFrag from '@/shaders/glass.frag?raw';

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
        uAberration: { value: 0.016 },
        uVignetteSize: { value: 0.485 },
        uShadowHardness: { value: 0.06 },
        uParallaxSens: { value: 1.0 },
        uEyeOffset: { value: new THREE.Vector2(0, 0) },
        uEyeRelief: { value: 1.0 },
        uZoomK: { value: 1.0 },
        uSwaySpeed: { value: 0.0 },
        uReticleRoll: { value: 0.0 },
        uReticleOffset: { value: new THREE.Vector2(0, 0) },
        uAdsWeight: { value: 0.0 },
        uTime: { value: 0.0 },
        uSunSide: { value: new THREE.Vector2(0.4, 0.65) },
        uSunIntensity: { value: 0.35 },
        uReticleColor: { value: new THREE.Color(1.0, 0.16, 0.05) },
        uBattery: { value: 0.0 },
        uDirtOpacity: { value: 0.05 },
        uGlassTint: { value: new THREE.Color(1.0, 1.0, 1.0) },
        uOpticMode: { value: 0.0 },
        uSunFacing: { value: 0.0 },
        uReticleScale: { value: 1.0 },
        uDofRings: { value: 1.0 },
        uCrescentSide: { value: 1.0 },
        uCrescentPower: { value: 0.5 },
        uOutlineShade: { value: 1.0 },
        uMirrorBoost: { value: 1.0 },
    },
    vertexShader: lensVert,
    fragmentShader: lensFrag,
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
function makeGlassMaterial(
    ocular: boolean,
    reflect: number,
): THREE.ShaderMaterial {
    const mat = new THREE.ShaderMaterial({
        transparent: ocular,
        depthWrite: false,
        side: THREE.DoubleSide,
        uniforms: {
            uSunDirW: { value: SUN_DIR },
            uReflect: { value: reflect },
            uOcular: { value: ocular ? 1.0 : 0.0 },
        },
        vertexShader: glassVert,
        fragmentShader: glassFrag,
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
    const m = new THREE.Mesh(
        new THREE.CircleGeometry(radius, 48),
        makeGlassMaterial(ocular, reflect),
    );
    m.position.z = z;
    m.layers.set(1);
    if (ocular) m.renderOrder = 2;
    parent.add(m);
}

// Sniper: ocular surface just inside the bell mouth, objective deep in the bell.
// Hot ocular fresnel so the hip carry glints at its glancing angle.
addGlass(sniperGroup, 0.054, 0.262, true, 2.1);
addGlass(sniperGroup, 0.06, -0.298, false, 1.3);
// ACOG: compact cups, same treatment
addGlass(acogGroup, 0.036, 0.17, true, 1.9);
addGlass(acogGroup, 0.042, -0.166, false, 1.3);

export { scopeCamera, lensMat };

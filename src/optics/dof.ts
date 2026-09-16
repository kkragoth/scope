import * as THREE from 'three';
import { renderer } from '@/core/boot';
import postVert from '@/shaders/post.vert?raw';
import blurFrag from '@/shaders/blur.frag?raw';
import dofFrag from '@/shaders/dof.frag?raw';

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
const blurMat = new THREE.ShaderMaterial({
    uniforms: {
        tSrc: { value: null },
        uDir: { value: new THREE.Vector2(1, 0) },
        uTexel: { value: new THREE.Vector2(1 / 256, 1 / 256) },
    },
    vertexShader: postVert,
    fragmentShader: blurFrag,
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
    vertexShader: postVert,
    fragmentShader: dofFrag,
    depthTest: false,
    depthWrite: false,
});
const dofScene = new THREE.Scene();
{
    const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), dofMat);
    q.frustumCulled = false;
    dofScene.add(q);
}
// Mutable DOF runtime: hysteresis gate + smoothed focus. A plain object (not
// `export let`) so the frame loop can advance it through the live binding.
export const dofState = { active: false, focusSm: 60, focusTick: 0 };
// Map-view DOF pipeline: PARKED (false) — outer-ring glass DOF carries the
// effect for now. Hysteresis on the switch so the MSAA/no-MSAA crossover
// can't flicker; strength fades with the shoulder.
export const dofMapEnabled = false;
// Focus distance: throttled center ray (every 6th frame), smoothed.
const focusRay = new THREE.Raycaster();
const _focusDir = new THREE.Vector3();
const _focusPos = new THREE.Vector3();

export {
    dofDepth,
    mainTarget,
    blurA,
    blurB,
    sizeDofTargets,
    postCam,
    blurMat,
    blurScene,
    dofMat,
    dofScene,
    focusRay,
    _focusDir,
    _focusPos,
};

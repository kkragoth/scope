import * as THREE from 'three';

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
// reads as a separate, reflective part of the rifle. Pushed glossy + high
// env response so the tube rolls like a curved barrel in the sun.
const scopeMat = new THREE.MeshStandardMaterial({
    color: 0x17181b,
    roughness: 0.27,
    metalness: 0.95,
    side: THREE.DoubleSide,
    roughnessMap: makeMicronoiseTexture(),
    envMapIntensity: 1.9,
});

export { weaponMat, scopeMat };

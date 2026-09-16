import * as THREE from 'three';
import { scene } from '@/core/boot';

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
  m: THREE.Mesh
  vel: THREE.Vector3
  spin: THREE.Vector3
  life: number
  active: boolean
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
        brassPool.push({
            m,
            vel: new THREE.Vector3(),
            spin: new THREE.Vector3(),
            life: 0,
            active: false,
        });
    }
}
let brassIdx = 0;
// Pooled brass cursor: the pool itself never reallocates, the cursor just
// walks it ring-buffer style so firing stays zero-alloc per frame.
export function nextBrass(): BrassCase {
    const b = brassPool[brassIdx];
    brassIdx = (brassIdx + 1) % brassPool.length;
    return b;
}
const _mzl = new THREE.Vector3();
const _brassP = new THREE.Vector3();
const _brassQ = new THREE.Quaternion();
const _bRight = new THREE.Vector3();
const _bUp = new THREE.Vector3();
const _bFwd = new THREE.Vector3();

export { flashSprite, brassPool, _mzl, _brassP, _brassQ, _bRight, _bUp, _bFwd };

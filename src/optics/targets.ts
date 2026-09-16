import * as THREE from 'three';

// PERF: 768 instead of 1024 — the lens covers ~65% of screen height at ADS,
// so 768px across the aperture still supersamples the displayed ~590px while
// cutting scope-pass fill rate ~44%.
const scopeTarget = new THREE.WebGLRenderTarget(768, 768, {
    format: THREE.RGBAFormat,
});

export { scopeTarget };

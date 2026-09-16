# Optics Realism Improvement Plan

All work is in `src/main.ts`, inside the `lensMat` fragment shader (a GLSL template
string) plus one uniform default. Line numbers below refer to the current file and
may drift slightly after edits — match on the exact code text instead.

Build/verify: `npm run build` (runs `tsc && vite build`). GLSL is not type-checked,
so also sanity-check shader syntax by eye and, ideally, `npm run dev`.

The shader uses GLSL ES 1.0 (WebGL1-style: `varying`, `texture2D`, `gl_FragColor`).
**No nested/local functions, no closures** — any helper function must be declared at
the top (global) scope and receive all inputs as parameters.

---

## 1. Eye relief must change magnification (not just vignette)

**Problem:** `uEyeRelief` only drives aperture/CA/blur. The image is always sampled
1:1 (`baseUv = barrelWarp(uv + imageShift)`), so "too far" just blackens the same-size
picture instead of shrinking it.

**Fix:** scale the sampling coordinate by relief.

Current (`vec2 imgUv = uv + imageShift;` in the barrel block):

```glsl
vec2 imgUv = uv + imageShift;
```

Change to:

```glsl
float imageScale = uEyeRelief;              // 1 seated; >1 far (image shrinks); <1 close (grows)
vec2 imgUv = (uv + imageShift) * imageScale;
```

The reticle must track the same scale (see #10 below — split etch vs illum). Replace
the current reticle denominator:

```glsl
vec2 p = rcGun / (uReticleScale * (0.92 + 0.08 * uEyeRelief));
```

with two coordinates:

```glsl
vec2 p  = rcGun / (uReticleScale * imageScale);  // etch (FFP subtends with zoom)
vec2 pi = rcGun / imageScale;                    // illuminated reticle (fixed focal plane)
```

Then use `p` for the etch (lines/posts/dots) and `pi` for all illumination (`sniperCore`,
`acogCore`, `dDot`, `dRing`, `apex`, `halo`, `wash`).

Note: `imageScale` must be declared before `imgUv` and also be visible in the reticle
block (they're in the same `main()`, so declaring it once early in `main()` is fine).

---

## 2. Aperture should be exit-pupil geometry, not a scalar bell

**Problem:** `pupilAperture = 1/(1 + reliefErr²·1.6)` is a fudge curve.

**Fix:** model the exit-pupil disc radius = `vignette / relief` (shrinks when far) and
clamp to the fixed eye pupil (= `uVignetteSize`, the seated size). Too-close keeps full
aperture but blurs (handled by defocus in #8).

Current:

```glsl
float reliefErr = abs(uEyeRelief - 1.0);
float pupilAperture = 1.0 / (1.0 + reliefErr * reliefErr * 1.6);
...
float currentAperture = uVignetteSize * pupilAperture * mix(0.35, 1.0, eyeBox);
```

Replace with (keep `reliefErr` — it is used later by `reliefDim` and `blurMix`):

```glsl
float reliefErr = abs(uEyeRelief - 1.0);
// exit-pupil radius shrinks ~1/relief when the eye backs off; the eye pupil
// (fixed, = uVignetteSize) is the limiting stop when seated or closer.
float exitR = uVignetteSize / max(uEyeRelief, 0.5);
float currentAperture = min(exitR, uVignetteSize) * mix(0.35, 1.0, eyeBox);
```

Remove the `pupilAperture` declaration entirely.

---

## 3. Barrel distortion needs its Jacobian (photometric) term

**Problem:** compressing the rim changes irradiance; without the warp derivative the
curved field reads flat.

**Fix:** add a helper that returns the inverse-map area determinant, and multiply the
sampled color by it (clamped).

Add after `barrelWarp`:

```glsl
// Area determinant of barrelWarp (the inverse map). Conserves flux: a compressed
// rim dims slightly, an expanded rim brightens. Clamped at use site.
float barrelJac(vec2 p, float k) {
  float r2 = dot(p, p);
  float g  = 1.0 + k * r2 + k * 0.6 * r2 * r2 + k * 0.3 * r2 * r2 * r2;
  float gp = k + k * 1.2 * r2 + k * 0.9 * r2 * r2;   // dg/d(r2)
  return g * (g + 2.0 * r2 * gp);
}
```

Apply just after the transmission/dim multiply on `sceneColor`:

```glsl
sceneColor *= 0.78 * reliefDim * uGlassTint;
sceneColor *= clamp(barrelJac(imgUv, barrelK), 0.55, 1.5);
```

(`imgUv` is the pre-warp coordinate; `barrelK` is defined in the barrel block.)

---

## 4. Image-side fresnel should be incidence-angle, not radius

**Problem:** `objFres = smoothstep(0.14,0.5,distFromCenter)²` is radial, not Schlick.

**Fix:** in the "LAYERED GLASS" block, replace the `objFres` lines:

```glsl
float objFres = smoothstep(0.14, 0.5, distFromCenter);
objFres *= objFres;
```

with a Schlick-style incidence-angle term (glass normal tilts with radius):

```glsl
float objR = distFromCenter / 0.5;                 // 0..1
float cosInc = 1.0 / sqrt(1.0 + objR * objR * 3.0);
float objFres = pow(1.0 - cosInc, 4.0);
```

Keep the existing `fresBoost` / `fresSway` multipliers downstream unchanged (they
already add the off-axis grazing boost).

---

## 5. Reticle needs its own chromatic aberration

**Problem:** the world image fringes at the rim but the illuminated reticle is drawn
flat, reading as a sticker over the bent lens.

**Fix:** evaluate the illuminated core three times with a radial per-channel offset.

Add two global helpers (after `sampleSight`, before `aaLine`):

```glsl
float illumSniper(vec2 q, vec2 ap, vec2 fl, vec2 fr, float fw) {
  float dc = min(sdSegment(q, ap, fl), sdSegment(q, ap, fr));
  float w  = max(0.001 * fw, fwidth(dc) * 1.5);
  return (1.0 - smoothstep(0.0016, 0.0016 + w, dc))
       + (1.0 - smoothstep(0.0012, 0.0012 + w, length(q - ap))) * 0.7;
}
float illumAcog(vec2 q, float fw) {
  float dd = length(q);
  float wd = max(0.002 * fw, fwidth(dd) * 1.5);
  float dotC = 1.0 - smoothstep(0.0035, 0.0035 + wd, dd);
  float dr = abs(dd - 0.032);
  float ra = atan(q.y, q.x);
  float rg = smoothstep(0.3, 0.55, abs(ra + 1.5708));
  float wr = max(0.0014 * fw, fwidth(dr) * 1.5);
  return clamp(dotC + (1.0 - smoothstep(0.0018, 0.0018 + wr, dr)) * rg, 0.0, 1.0);
}
```

In `main()`, replace the existing illumination-core computation (`sniperCore` /
`acogCore` / `illumMask`) so the core is sampled at three radial scales:

```glsl
float retCa = dynamicAberration * reticleVis;        // reuse image CA amplitude
float coreG = isAcog ? illumAcog(pi, focusW) : illumSniper(pi, apex, footL, footR, focusW);
float coreR = isAcog ? illumAcog(pi * (1.0 - retCa), focusW) : illumSniper(pi * (1.0 - retCa), apex, footL, footR, focusW);
float coreB = isAcog ? illumAcog(pi * (1.0 + retCa), focusW) : illumSniper(pi * (1.0 + retCa), apex, footL, footR, focusW);
vec3 illumCol = vec3(coreR, coreG, coreB) * illumDim;
```

Then use `illumCol` in place of `illumMask` in the color add:

```glsl
sceneColor += uReticleColor * illumCol * glowStrength * reticleVis;
```

(`halo`/`wash` stay on `pi`; `illumMask` is replaced by the `vec3 illumCol`.)
`reticleVis` is defined later in the file than `dynamicAberration` — hoist the CA
computation into the reticle section (after `reticleVis` is computed) so both are in
scope.

---

## 6. Lateral CA = wavelength magnification; longitudinal = per-channel defocus

**Problem:** `sampleSight` mixes a radial-scale lateral term with a radial `axial·r²`
term that is not physically a defocus.

**Fix:** keep lateral as radial scale, drop `axial` from the radial scale, and apply
longitudinal color as a per-channel defocus radius in the blur taps.

Current:

```glsl
vec3 sampleSight(vec2 buv, float brv, float aberr, float axial) {
  float k = aberr * brv + axial * brv * brv;
  vec2 sR = buv * (1.0 - k);
  vec2 sB = buv * (1.0 + k);
  ...
}
```

Change `sampleSight` to lateral-only:

```glsl
vec3 sampleSight(vec2 buv, float brv, float aberr) {
  float lat = aberr * brv;
  vec2 sR = buv * (1.0 - lat);
  vec2 sB = buv * (1.0 + lat);
  float rr = texture2D(tDiffuse, sR + 0.5).r;
  float gg = texture2D(tDiffuse, buv + 0.5).g;
  float bb = texture2D(tDiffuse, sB + 0.5).b;
  return vec3(rr, gg, bb);
}
```

Update all call sites (drop the 4th `axial` argument; there are currently 5 calls in
the blur block plus any others — search for `sampleSight(`). Then, in the blur block,
apply the longitudinal color as opposite per-channel defocus radii:

```glsl
float blurR = blurMix * 0.012;                       // see #8 for the radius bump
float ax = axialAberration * 0.004;                  // longitudinal split
vec3 sharpC = sampleSight(baseUv, br, dynamicAberration);
vec3 bx = (sampleSight(baseUv + vec2(blurR, 0.0), br, dynamicAberration)
         + sampleSight(baseUv - vec2(blurR, 0.0), br, dynamicAberration)) * 0.5;
vec3 by = (sampleSight(baseUv + vec2(0.0, blurR), br, dynamicAberration)
         + sampleSight(baseUv - vec2(0.0, blurR), br, dynamicAberration)) * 0.5;
vec3 sceneColor = mix(sharpC, (bx + by) * 0.5, blurMix);
// longitudinal CA: R focuses short (blur more), B long (blur opposite) around G
vec3 axR = (sampleSight(baseUv + vec2(ax, 0.0), br, dynamicAberration)
          + sampleSight(baseUv - vec2(ax, 0.0), br, dynamicAberration)) * 0.5;
vec3 axB = (sampleSight(baseUv + vec2(0.0, ax), br, dynamicAberration)
          + sampleSight(baseUv - vec2(0.0, ax), br, dynamicAberration)) * 0.5;
sceneColor.r = mix(sceneColor.r, axR.r, axialAberration * 4.0);
sceneColor.b = mix(sceneColor.b, axB.b, axialAberration * 4.0);
```

(Clamp `axialAberration * 4.0` implicitly via `mix` saturation — `mix` clamps t in
GLSL ES? No: `mix` does NOT clamp t; wrap with `min(...,1.0)` if needed. Use
`min(axialAberration * 4.0, 1.0)`.)

---

## 7. Remove the parallax "whisper" (distant scene parallax is ~0)

**Problem:** `reticleCenter = sightC * uParallaxSens` (1.06) shifts the reticle against
the world; for a distant scene the true parallax is zero.

**Fix:** set the default to 1.0 so the reticle rides exactly with the image (zero
relative parallax). No shader change needed.

Current uniform default:

```glsl
uParallaxSens: { value: 1.06 },
```

Change to:

```glsl
uParallaxSens: { value: 1.0 },
```

(Optional: the JS `parallaxError` at the "TRUE PARALLAX ERROR" block reads
`sens - 1.0`, so it naturally becomes 0.)

---

## 8. Defocus must be a real, visible blur disc tied to relief

**Problem:** `blurMix` produces a near-invisible 5-tap cross (`blurR = blurMix * 0.006`).

**Fix:** strengthen the relief term and the radius.

Current:

```glsl
float blurMix = clamp(abs(uEyeRelief - 1.0) * 0.9 + swayDist * 0.6, 0.0, 1.0);
```

Change to:

```glsl
float blurMix = clamp(abs(uEyeRelief - 1.0) * 1.6 + swayDist * 0.8, 0.0, 1.0);
```

And in the blur block, `float blurR = blurMix * 0.006;` → `float blurR = blurMix * 0.012;`
(combined with the #6 rewrite above).

---

## 9. Natural vignetting must follow the aperture

**Problem:** rim falloff uses a fixed `uVignetteSize` regardless of relief.

**Fix:** use `currentAperture` so the bright field tightens as the aperture shrinks.

Current:

```glsl
float brightT = smoothstep(0.0, uVignetteSize, length(uv - imageCenter));
finalColor *= mix(1.0, 0.62, brightT);
```

Change to:

```glsl
float brightT = smoothstep(0.0, currentAperture, length(uv - imageCenter));
finalColor *= mix(1.0, 0.62, brightT);
```

---

## 10. FFP must scale etch, not the illuminated center

**Problem:** `p = rcGun / uReticleScale` scales etch and illuminated dot together;
the illuminated center should stay fixed-size in FFP.

**Fix:** covered by the `p` / `pi` split in #1. Ensure the etch uses `p` and all
illumination/bloom/halo uses `pi`. (Only matters for the sniper optic when FFP is
enabled — ACOG already has `uReticleScale == 1.0`.)

---

## Order of implementation & verification

1. Apply #1 + #10 together (imageScale + p/pi split).
2. Apply #2 (aperture), #7 (uniform), #8 (blur), #9 (vignette) — small, independent.
3. Apply #3 (Jacobian helper), #4 (Schlick fresnel).
4. Apply #6 (sampleSight signature + blur rewrite), then #5 (reticle CA helpers +
   3-channel illum) — #5 depends on the `reticleVis`/`dynamicAberration` scope.
5. Run `npm run build`. Fix any TS errors. Optionally run `npm run dev` and visually
   check: ADS + sway (tunnel + CA + vignette), pull back / lean in (image scale +
   defocus + aperture), toggle FFP (F key) for reticle scale, and the illuminated
   reticle near the rim for CA fringe.

## Notes / gotchas

- `imageScale = uEyeRelief` also scales the barrel warp input; since `uEyeRelief` is
  clamped [0.35, 3.0] in JS, the effect stays bounded (~±30% typical).
- `mix` in GLSL ES does **not** clamp its third argument; wrap any potentially >1
  blend factor in `min(x, 1.0)`.
- Do not rename uniforms or change the JS `uEyeRelief`/`uEyeOffset`/`uZoomK` plumbing
  — these changes are shader-local (plus one uniform default in #7).
- Keep the existing large comment blocks intact where they explain _why_ (e.g. the
  hip/ADS back-loading, FFP/SFP, roll). Update only the code they describe.

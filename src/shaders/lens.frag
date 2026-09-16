    uniform sampler2D tDiffuse;
    uniform sampler2D uDirtMap;
    uniform float uAberration;
    uniform float uVignetteSize;
    uniform float uShadowHardness;
    uniform float uParallaxSens;
    uniform vec2 uEyeOffset;
    uniform float uEyeRelief;
    uniform float uZoomK;
    uniform float uSwaySpeed;
    uniform float uReticleRoll;
    uniform vec2 uReticleOffset;
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
    uniform float uReticleScale;
    uniform float uDofRings;
    uniform float uCrescentSide;
    uniform float uCrescentPower;
    uniform float uOutlineShade;
    uniform float uMirrorBoost;
    varying vec2 vUv;

    float hash21(vec2 p) {
      p = fract(p * vec2(234.34, 435.345));
      p += dot(p, p + 34.23);
      return fract(p.x * p.y);
    }
    float sdSegment(vec2 p, vec2 a, vec2 b) {
      vec2 pa = p - a;
      vec2 ba = b - a;
      float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
      return length(pa - ba * h);
    }
    // Radial barrel/fisheye warp around the optical axis. k < 0 barrels (the
    // classic scope "bulge"): center magnified, rim compressed and bowed. Two
    // higher-order terms (r^4, r^6) compound the curvature like stacked lens
    // elements — the rim bows hardest while the center stays flat. One shared
    // function so the image AND the etched reticle curve together.
    vec2 barrelWarp(vec2 p, float k) {
      float r2 = dot(p, p);
      return p * (1.0 + k * r2 + k * 0.6 * r2 * r2 + k * 0.3 * r2 * r2 * r2);
    }
    // Area determinant of barrelWarp (the inverse map). Conserves flux: a compressed
    // rim dims slightly, an expanded rim brightens. Clamped at use site.
    float barrelJac(vec2 p, float k) {
      float r2 = dot(p, p);
      float g  = 1.0 + k * r2 + k * 0.6 * r2 * r2 + k * 0.3 * r2 * r2 * r2;
      float gp = k + k * 1.2 * r2 + k * 0.9 * r2 * r2;   // dg/d(r2)
      return g * (g + 2.0 * r2 * gp);
    }
    // Chromatic sample at one bent coord. Transverse CA: R/B bend linearly
    // with radius (real lateral color scales ~r, not r^2) — the fringe is
    // invisible at center and grows to a couple px at the rim. Longitudinal
    // color is handled separately as per-channel defocus in the blur taps.
    vec3 sampleSight(vec2 buv, float brv, float aberr) {
      float lat = aberr * brv;
      vec2 sR = buv * (1.0 - lat);
      vec2 sB = buv * (1.0 + lat);
      float rr = texture2D(tDiffuse, sR + 0.5).r;
      float gg = texture2D(tDiffuse, buv + 0.5).g;
      float bb = texture2D(tDiffuse, sB + 0.5).b;
      return vec3(rr, gg, bb);
    }
    // Illuminated sniper chevron mask at one scale (q in fixed pi space).
    // Called per channel with a slightly scaled q so the lit core fringes
    // with the same chromatic aberration as the world image behind it.
    float illumSniper(vec2 q, vec2 ap, vec2 fl, vec2 fr, float fw) {
      float dc = min(sdSegment(q, ap, fl), sdSegment(q, ap, fr));
      float w  = max(0.001 * fw, fwidth(dc) * 1.5);
      return (1.0 - smoothstep(0.0016, 0.0016 + w, dc))
           + (1.0 - smoothstep(0.0012, 0.0012 + w, length(q - ap))) * 0.7;
    }
    // Illuminated ACOG dot + horseshoe ring at one scale (q in pi space).
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
    // Analytically anti-aliased primitives (fwidth): etch lines stay hairline
    // without shimmering at 1px widths.
    float aaLine(float c, float w) {
      float aa = fwidth(c) * 1.2;
      return 1.0 - smoothstep(w - aa, w + aa, abs(c));
    }
    float aaRange(float c, float hi) {
      float aa = fwidth(c) * 1.2;
      return 1.0 - smoothstep(hi - aa, hi + aa, abs(c));
    }
    float aaBand(float c, float lo, float hi) {
      float aa = fwidth(c) * 1.2;
      return smoothstep(lo - aa, lo + aa, abs(c))
        * (1.0 - smoothstep(hi - aa, hi + aa, abs(c)));
    }

    void main() {
      vec2 uv = vUv - 0.5;
      float r2 = dot(uv, uv);
      float distFromCenter = length(uv);

      float swayDist = length(uEyeOffset);

      // ---- SIGHT STAYS PINNED (no lateral slide) ----
      // The world image is rendered with the render camera ON the barrel, and
      // the ocular projects it onto a focal plane the eye looks *into* — a
      // distant scene has ~zero parallax, so the picture and the etched
      // crosshair must NOT translate when the eye drifts off-axis. Sliding
      // them (old rawSight/sightC) is what read as "a whole circle moving
      // inside the scope". Instead the crosshair stays glued to tube centre
      // and the ONLY off-axis cue is the eye-relief crescent (the exit-pupil
      // shadow below, drawn against the fixed picture) plus aperture shrink /
      // defocus / dimming — the way a real optic loses its eye box.
      vec2 imageShift = vec2(0.0);
      vec2 imageCenter = vec2(0.0);
      // FREEAIM translational offset: the etch slides U/D/L/R inside a
      // frozen picture (no roll, no image swing) and eases back to centre
      // when the mouse stops. Driven from JS, clamped to stay well inside
      // the glass.
      vec2 reticleCenter = uReticleOffset;

      // ---- CIRCULAR FIELD STOP (no elliptical foreshortening) ----
      // The ocular's field stop is a circle. Viewing it slightly off-axis does
      // NOT squash it into an ellipse — the eye-relief cue that matters is the
      // exit-pupil CRESCENT (below), a circular bite drawn against a circular
      // picture. Elliptical foreshortening (old ellR/tiltCos) is exactly what
      // read as "an ellipse image" instead of "a circle with a crescent", so it
      // is gone: the field stop, the pupil and the crescent are all circles.

      // ---- EYE-RELIEF APERTURE (physical exit pupil) ----
      // relief 1.0 = eye seated at the exit pupil. Too far shrinks the picture
      // (the exit-pupil disc falls inside the eye pupil → narrower FOV, the
      // classic "scope shadow closing in"); too close blows it out past the
      // ocular field stop. uZoomK = exit-pupil magnification penalty: the exit
      // pupil diameter = objective / magnification, so cranked zoom makes the
      // SAME error cost dramatically more — harder eye relief you can *feel*.
      // Shouldering progression is deliberately back-loaded: hip is a tiny dim
      // peephole, mid-travel is still mostly black tunnel with a sweeping
      // crescent, and the full picture only lands at the end of ADS — like
      // finding the eye box on a real optic. Do NOT linearize this.
      float eyeBox = smoothstep(0.15, 0.98, uAdsWeight);
      // Exit-pupil aperture, modelled as real geometry: the ocular forms an
      // exit-pupil disc behind the last element whose radius is ~ 1/relief.
      // Back off and the disc shrinks below the (fixed) eye pupil, clamping
      // the bright field; come too close and the eye pupil itself is the
      // limiting stop (full aperture, but defocus — below — takes over). No
      // more symmetric bell fudge: one physical min() of two discs.
      float reliefErr = abs(uEyeRelief - 1.0);
      // Exit-pupil disc radius. The physical 1/relief collapse is real but it
      // read as "tunnel vision" once zoom amplified the relief error — so the
      // shrink is kept gentle: seated-or-closer stays full, and even at the far
      // end (relief 3) the picture only pinches to ~62%, never a third. The
      // crescent carries the eye-relief cue; this is just a subtle squeeze.
      float exitR = uVignetteSize * mix(1.0, 0.62, smoothstep(1.0, 3.0, uEyeRelief));
      // NOTE: no base-aperture zoom penalty. A perfectly seated eye sees the
      // FULL field through the ocular at any magnification — the picture must
      // stay full-size and full-bright when you're still. The zoom penalty
      // lives in the *error response* (uEyeOffset/uEyeRelief are amplified by
      // zoomTighten in JS), so it only bites when you sway, never when centered.
      // The aperture is RELIEF-ONLY (distance): backing off shrinks the exit
      // pupil, but a LATERAL eye drift must NOT shrink the picture. A centred
      // disc that collapses as you pan is exactly the "tunnel vision" that
      // looked wrong — the lateral cue is the exit-pupil CRESCENT below, and a
      // fast swing thickens that crescent instead of shrinking the field.
      // Hip = no picture: misaligned eye sees dark bore only, not even a dot.
      float currentAperture = min(exitR, uVignetteSize) * mix(0.0, 1.0, eyeBox);
      float shadowK = uShadowHardness * mix(1.7, 0.75, clamp(2.0 - uEyeRelief, 0.0, 1.0));
      // zoomed glass punishes harder: edge hardens with magnification
      shadowK *= 1.0 + (uZoomK - 1.0) * 0.25;
      // edge stays hard while shouldering, relaxes once seated in the eye box
      float transit = (1.0 - eyeBox) * smoothstep(0.0, 0.4, uAdsWeight);
      shadowK *= 1.0 + transit * 1.5;
      // reticle fades in LAST — off-axis eyes see no etch, only tunnel
      float etchVis = smoothstep(0.55, 0.98, uAdsWeight);
      // off-axis transmission: hip peephole runs dark, not full-bright. Dimming
      // is tied to RELIEF DISTANCE (reliefErr) only — a lateral sway must NOT
      // darken the whole picture (that was the "vignette on pan" read as wrong).
      float reliefDim = mix(0.0, 1.0, smoothstep(0.15, 0.95, uAdsWeight));
      reliefDim /= 1.0 + reliefErr * 0.25;

      // ---- NEUTRAL GLASS + DEFOCUS: keep scope == world ----
      // Wrong relief or zoomed sway blurs the sight (eye relief you feel, not
      // just darkness). Cross blur radius tracks total eye error, with extra
      // per-channel longitudinal taps added below. Computed before the
      // CA/distortion block so the axial color can ride on it.
      // (inputs already zoom-amplified in JS — no uZoomK re-multiply here.)
      // Lateral sway keeps only a whisper of symmetric defocus; the crescent is
      // the loud cue, not a full-frame blur.
      // Hip is fully defocused: an unaligned eye can't resolve the picture.
      float blurMix = clamp(abs(uEyeRelief - 1.0) * 1.0 + swayDist * 0.35 + (1.0 - eyeBox) * 1.2, 0.0, 1.0);

      // Physical lateral CA: zero at center, grows to the rim. A real ocular's
      // transverse color makes a visible magenta/green fringe at the edge of
      // the sight picture — strong at the rim, absent at center. Sway modulates
      // it (the eye sits off the optical axis, bending color more).
      float caMask = smoothstep(0.06, 0.42, distFromCenter);
      float dynamicAberration = uAberration * (1.2 + swayDist * 0.8) * caMask;
      // Longitudinal color rides on defocus: out-of-focus edges split blue/red
      // around the green focal plane (axial CA). Grows with relief error + zoom.
      float axialAberration = uAberration * (0.6 + blurMix * 2.2) * caMask;

      // Rim-weighted barrel + fisheye distortion: the ocular is a curved glass
      // element, so the whole field bows around the optical axis — straight
      // world lines near the rim curve like looking into a sphere. Radial in
      // r² + r⁴, so the center stays flat and the edge bows hardest. Amplitude
      // grows with eye relief (sway) and hard zoom, so the distortion lives at
      // the screen edge exactly where eye relief and magnification bite.
      // Distorted around the shifted image plane so glass feels volumetric.
      // Relief-driven image scale is damped: a full 1:1 follow of uEyeRelief
      // magnified/shrunk the image alongside the aperture shrink, compounding
      // the "tunnel vision" at high zoom. Keep only 40% of the deviation so
      // the picture stays close to 1:1 while the crescent does the talking.
      float imageScale = mix(1.0, uEyeRelief, 0.4);
      vec2 imgUv = (uv + imageShift) * imageScale;
      float swayBoost = min(swayDist * 2.0, 1.0);
      float zoomBoost = clamp((uZoomK - 1.0) * 0.45, 0.0, 1.0);
      // barrel strength: negative → barrel; stronger off-axis (hip), eased ADS
      float barrelK = mix(-0.26, -0.16, uAdsWeight) * (1.0 + 0.8 * swayBoost + 1.2 * zoomBoost);
      vec2 baseUv = barrelWarp(imgUv, barrelK);
      float br = length(baseUv);

      float blurR = blurMix * 0.012;
      vec3 sharpC = sampleSight(baseUv, br, dynamicAberration);
      vec3 bx = (sampleSight(baseUv + vec2(blurR, 0.0), br, dynamicAberration)
        + sampleSight(baseUv - vec2(blurR, 0.0), br, dynamicAberration)) * 0.5;
      vec3 by = (sampleSight(baseUv + vec2(0.0, blurR), br, dynamicAberration)
        + sampleSight(baseUv - vec2(0.0, blurR), br, dynamicAberration)) * 0.5;
      vec3 sceneColor = mix(sharpC, (bx + by) * 0.5, blurMix);
      // Longitudinal color = per-channel defocus (not a radial scale): blue
      // focuses short, red long, straddling the green plane. Split opposite
      // cross-taps so out-of-focus edges smear magenta/green like real glass.
      float ax = axialAberration * 0.004;                  // longitudinal split
      vec3 axR = (sampleSight(baseUv + vec2(ax, 0.0), br, dynamicAberration)
        + sampleSight(baseUv - vec2(ax, 0.0), br, dynamicAberration)) * 0.5;
      vec3 axB = (sampleSight(baseUv + vec2(0.0, ax), br, dynamicAberration)
        + sampleSight(baseUv - vec2(0.0, ax), br, dynamicAberration)) * 0.5;
      sceneColor.r = mix(sceneColor.r, axR.r, min(axialAberration * 4.0, 1.0));
      sceneColor.b = mix(sceneColor.b, axB.b, min(axialAberration * 4.0, 1.0));
      // Coated-glass transmission loss + off-axis dimming: ADS center runs
      // ~78% of naked-eye brightness, hip peephole collapses toward 30%.
      // (Deliberately under, not over — the old 0.9 + additive lifts read as
      // a flashlight inside the tube.)
      sceneColor *= 0.78 * reliefDim * uGlassTint;
      sceneColor *= clamp(barrelJac(imgUv, barrelK), 0.55, 1.5);

      // ---- LENS SMUDGE & DIRT: baked texture, glint-only ----
      // uDirtOpacity ~0.05 by default: effectively invisible unless sun catches it.
      // Single fetch from the pre-baked uDirtMap (was per-pixel fbm — see maker).
      float dirtMask = texture2D(uDirtMap, vUv).r;

      // Dirt only lights up at glancing sun/eye angles, capped very low
      vec2 safeUv = uv + vec2(1e-4);
      vec2 sweepDir = normalize(uSunSide + uEyeOffset * 4.0 + vec2(1e-4));
      float sweep = pow(max(dot(normalize(safeUv), sweepDir) * 0.5 + 0.5, 0.0), 6.0);
      float dirtLightAmt = (0.002 + uSunIntensity * 0.025 + sweep * (0.01 + swayDist * 0.3)) * uDirtOpacity * 20.0;
      dirtLightAmt = min(dirtLightAmt, 0.03);
      vec3 dirtColor = vec3(1.0, 0.99, 0.96);
      float inImage = 1.0 - smoothstep(currentAperture - shadowK, currentAperture, length(uv - imageCenter));
      sceneColor += dirtMask * dirtLightAmt * dirtColor * inImage;

      // Diagonal sun-streak flare across glass (scope glint), barely-there
      float flareBand = 1.0 - smoothstep(0.0, 0.09, abs(dot(uv, vec2(-sweepDir.y, sweepDir.x))));
      float flare = flareBand * sweep * uSunIntensity * 0.025 * inImage;
      sceneColor += flare * vec3(1.0, 0.99, 0.96);

      // ---- RETICLE: uOpticMode 0 = sniper mil-lines, 1 = ACOG / red dot ----
      // NOTE: scope image is intentionally NOT mirrored/inverted. Real rifle
      // scopes erect the image (upright), and our render-target camera looks
      // forward along the barrel, so upright sampling here is correct. At hip
      // you see the ocular at an angle — perspective foreshortening handles
      // that, no texture flip needed. Do not "fix" by flipping vUv.
      // FFP vs SFP: ACOG reticle scales with magnification (first focal
      // plane — subtensions stay true at any zoom), sniper stays fixed size
      // (second focal plane). uReticleScale = baseFov / currentFov, clamped.
      // RETICLE ROLL: the etch is fixed to the gun, the eye is fixed to the
      // head. When the tube rolls relative to the eye the cross tilts "/" vs
      // "\" while the rotationally-symmetric lens image stays level. Rotate
      // eye-space coords back into gun-space by -roll to draw that.
      vec2 rc = uv - reticleCenter;
      // Seat the etch IN the glass: bend it with the same ocular curvature as
      // the image (barrelWarp + barrelK), but a touch MORE so the etch reads
      // as lying on its own focal plane slightly closer to the eye — the
      // second "layer" of the double-barrel. A flat overlay is what read as
      // "plastered".
      vec2 rcBent = barrelWarp(rc, barrelK * 1.12);
      float cR = cos(uReticleRoll);
      float sR = sin(uReticleRoll);
      vec2 rcGun = vec2(cR * rcBent.x + sR * rcBent.y, -sR * rcBent.x + cR * rcBent.y);
      // Eye-distance size cue: closer eye reads the etch slightly larger.
      vec2 p  = rcGun / (uReticleScale * imageScale);  // etch (FFP subtends with zoom)
      vec2 pi = rcGun / imageScale;                    // illuminated reticle (fixed focal plane)
      bool isAcog = uOpticMode > 0.5;
      // ACOG illumination ("laser") rides WITH the etch so the whole sight
      // zooms as one: dot + ring use p, sniper chevron keeps pi fixed.
      vec2 piEff = isAcog ? p : pi;

      // SNIPER etch: AA hairlines (no shimmer); fine mil-dots defocus out
      // first off-axis — tiny features go before lines, like real glass.
      float defK = 1.0 + min(swayDist * 2.0, 1.0);
      float sLineX = aaLine(p.x, 0.0011 * defK) * aaRange(p.y, 0.4);
      float sLineY = aaLine(p.y, 0.0011 * defK) * aaRange(p.x, 0.4);
      float sPostX = aaLine(p.x, 0.0035 * defK) * aaBand(p.y, 0.12, 0.4);
      float sPostY = aaLine(p.y, 0.0035 * defK) * aaBand(p.x, 0.12, 0.4);
      float dotStay = 1.0 - blurMix * 0.8;
      float sDotsX = step(mod(abs(p.x) + 0.025, 0.05), 0.0025) * step(abs(p.y), 0.0025) * step(abs(p.x), 0.12) * dotStay;
      float sDotsY = step(mod(abs(p.y) + 0.025, 0.05), 0.0025) * step(abs(p.x), 0.0025) * step(abs(p.y), 0.12) * dotStay;
      float sniperEtch = clamp(sLineX + sLineY + sPostX + sPostY + sDotsX + sDotsY, 0.0, 1.0);

      // ACOG etch: short center ticks + thick outer posts only, no full cross
      float aTickX = aaLine(p.x, 0.0012 * defK) * aaRange(p.y, 0.07);
      float aTickY = aaLine(p.y, 0.0012 * defK) * aaRange(p.x, 0.07);
      float aPostX = aaLine(p.x, 0.004 * defK) * aaBand(p.y, 0.14, 0.4);
      float aPostY = aaLine(p.y, 0.004 * defK) * aaBand(p.x, 0.14, 0.4);
      float acogEtch = clamp(aTickX + aTickY + aPostX + aPostY, 0.0, 1.0);
      float etchedMask = isAcog ? acogEtch : sniperEtch;

      // Focus + glow response: a centered eye focuses the etch crisply; as the
      // eye leaves the box the eye can't accommodate, so edges soften and the
      // illumination dims. Static-sharp + static-bright is the other half of
      // the "plastered" feel.
      float focusW = 1.0 + swayDist * 5.0;
      float illumDim = 1.0 - clamp(swayDist * 1.2, 0.0, 0.45);

      // SNIPER illumination geometry: small chevron, apex = point of impact.
      // Measured in the fixed focal-plane scale (pi) so the lit core and its
      // halo hold size against zoom. ACOG instead uses piEff (= p) so its
      // dot + ring scale WITH the etch (whole sight zooms as one).
      // Actual masks are built by illumSniper/illumAcog below (three channels
      // for reticle CA).
      vec2 apex = vec2(0.0, 0.004);
      vec2 footL = vec2(-0.02, -0.016);
      vec2 footR = vec2(0.02, -0.016);
      float dChev = min(sdSegment(pi, apex, footL), sdSegment(pi, apex, footR));

      // ACOG / RED DOT geometry: big glowing dot + horseshoe ring (piEff space)
      float dDot = length(piEff);
      float dRing = abs(dDot - 0.032);

      // bloom: tight halo in dark environments (battery bleed)
      // ACOG dot blooms wider than the sniper chevron on purpose.
      float haloDist = isAcog ? min(dDot * 0.55, dRing + 0.012) : dChev;
      float halo = exp(-haloDist * 90.0) * 0.4 + exp(-length(piEff) * 22.0) * 0.08;
      float darkFactor = 1.0 - smoothstep(0.04, 0.42, dot(sceneColor, vec3(0.299, 0.587, 0.114)));
      float glowStrength = (0.55 + darkFactor * 2.2) * uBattery;

      float reticleVis = (1.0 - smoothstep(currentAperture - shadowK, currentAperture, length(uv - imageCenter))) * etchVis;
      sceneColor = mix(sceneColor, vec3(0.0), etchedMask * 0.82 * reticleVis);
      // illuminated core on top of the etch, with its OWN chromatic aberration:
      // the lit mask is sampled per channel at three radial scales so the
      // chevron/dot fringes like the world image bending behind it.
      float retCa = dynamicAberration * reticleVis;        // reuse image CA amplitude
      float coreG = isAcog ? illumAcog(piEff, focusW) : illumSniper(pi, apex, footL, footR, focusW);
      float coreR = isAcog ? illumAcog(piEff * (1.0 - retCa), focusW) : illumSniper(pi * (1.0 - retCa), apex, footL, footR, focusW);
      float coreB = isAcog ? illumAcog(piEff * (1.0 + retCa), focusW) : illumSniper(pi * (1.0 + retCa), apex, footL, footR, focusW);
      vec3 illumCol = vec3(coreR, coreG, coreB) * illumDim;
      sceneColor += uReticleColor * illumCol * glowStrength * reticleVis;
      sceneColor += uReticleColor * halo * glowStrength * 0.5 * reticleVis;
      // battery bleed: tight faint wash that never blooms with glowStrength
      // (decoupling it is what keeps the sight picture from lifting)
      float wash = (exp(-haloDist * 140.0) * 0.22 + 0.0008) * (0.5 + darkFactor * 0.8) * uBattery;
      sceneColor += uReticleColor * wash * reticleVis;

      // ---- GLASS GRIT: dust motes + one fiber, fixed to the ocular surface
      // (vUv space — they ride with the tube, never with the world image)
      {
        float m1 = 1.0 - smoothstep(0.0, 0.0022, length(vUv - vec2(0.44, 0.57)));
        float m2 = 1.0 - smoothstep(0.0, 0.0016, length(vUv - vec2(0.58, 0.44)));
        float m3 = 1.0 - smoothstep(0.0, 0.0012, length(vUv - vec2(0.52, 0.62)));
        float fib = 1.0 - smoothstep(0.0, 0.0009, sdSegment(vUv, vec2(0.30, 0.70), vec2(0.42, 0.62)));
        float grit = clamp(m1 + m2 + m3, 0.0, 1.0) * 0.45 + fib * 0.35;
        sceneColor = mix(sceneColor, vec3(0.0), grit * inImage);
      }

      // ---- VEILING GLARE: sun washes the IMAGE, not the tube ----
      // Real optics bloom the picture when aimed near the sun; the baffled
      // tube itself stays black. So glare lifts sceneColor here, while the
      // tube wall below stays near-black with only an edge crescent.
      {
        vec2 gSun = length(uSunSide) > 1e-4 ? normalize(uSunSide) : vec2(0.4, 0.65);
        float glare = uSunFacing * uSunFacing * uSunFacing;
        sceneColor += vec3(1.0, 0.96, 0.90) * glare * 0.018 * reticleVis;
        // two ghost orbs: the internal double-reflection of the objective —
        // one cool, one warm, mirrored across the optical axis (classic
        // multi-element scope flare that only shows into the sun).
        vec2 gPos1 = -gSun * 0.16 + imageCenter;
        vec2 gPos2 = gSun * 0.30 + imageCenter;
        float ghost1 = 1.0 - smoothstep(0.0, 0.050, length(uv - gPos1));
        float ghost2 = 1.0 - smoothstep(0.0, 0.028, length(uv - gPos2));
        sceneColor += vec3(0.85, 0.92, 1.0) * ghost1 * glare * uSunFacing * 0.016 * reticleVis;
        sceneColor += vec3(1.0, 0.95, 0.85) * ghost2 * glare * uSunFacing * 0.009 * reticleVis;
        // coma/axial bloom: a sun-side haze that fades across the field
        float coma = pow(max(dot(normalize(uv - imageCenter + vec2(1e-4)), -gSun) * 0.5 + 0.5, 0.0), 8.0);
        sceneColor += vec3(0.92, 0.92, 0.97) * coma * glare * uSunFacing * 0.020 * reticleVis;
      }

      // OUTER-RING DOF (toggle T): shallow depth of field lives in the glass —
      // baffles wash out, rim bands widen, crescent edge relaxes — scaled by
      // zoom at ADS. Sight center stays crisp (own defocus path above).
      float outerSoft = uDofRings
        * clamp((uZoomK - 1.0) * 0.5, 0.0, 1.0)
        * smoothstep(0.3, 0.9, uAdsWeight);

      // ---- 3D TUNNEL (perspective bore) ----
      // Model the tube interior as a cone: the ocular rim (near, large) pinned
      // to the sight-picture edge, and the objective/field-stop (far, smaller,
      // deeper parallax) at the other end. A real scope seen through the ocular
      // is nearly orthographic, so the "3D" reads from three stacked cues:
      //   1. the far opening is visibly SMALLER than the near opening,
      //   2. the far rim's center slides MORE with the eye (deeper parallax),
      //   3. baffle rings are spaced in DEPTH (converging), not screen radius.
      // Hip reads as ~95% ocular shadow (tiny dim tilted peephole) by design —
      // currentAperture/etchVis/reliefDim above already encode that. Do NOT
      // "fix" the hip floor back up: a usable full-bright picture off-axis is
      // exactly what looked awful.
      vec2 nearC = imageCenter;
      // Field stop follows the true exit pupil: tiny at hip (no image),
      // full only at ADS. Thinness of the bright ring comes from the
      // hairline fade below, not from clamping the aperture open.
      float nearR = currentAperture;
      vec2 farC = imageCenter - uEyeOffset * 0.55;
      float farR = nearR * 0.965;

      float distImg = length(uv - nearC);
      float distOcular = length(uv);
      float dFar = length(uv - farC);

      float maskEdge = min(shadowK, 0.006);
      float objectiveMask = smoothstep(nearR - maskEdge, nearR, distImg);

      // NOTE: the eye-box shadow (below, applied just before the tunnel mix)
      // is NOT part of objectiveMask. The mask here is only the physical tube
      // beyond the field stop; the shadow lives *on top of the picture* as a
      // soft dimming crescent, so it never renders baffles/glass sheen inside
      // the shadow and never fades with a motion gate.

      // Depth along the bore: solve f(t) = length(uv, lerp(nearC,farC,t)) -
      // lerp(nearR,farR,t) = 0. f is ~linear in t for the small center slide,
      // so one linear solve is enough to index the wall from ocular (0) to
      // objective (1).
      float f0 = distImg - nearR;
      float f1 = dFar - farR;
      float depth = clamp(f0 / max(f0 - f1, 1e-4), 0.0, 1.0);

      vec2 wallC = mix(nearC, farC, depth);
      vec2 tubeN = length(uv - wallC) > 1e-4 ? normalize(uv - wallC) : vec2(0.0, 1.0);
      vec2 sunN = length(uSunSide) > 1e-4 ? normalize(uSunSide) : vec2(0.4, 0.65);
      vec2 eyeDirT = swayDist > 1e-4 ? uEyeOffset / swayDist : vec2(0.0);

      // Dark anodized base; sun-side kiss only, scaled by sunFacing so it
      // dies facing away. Kept near-black — no white barrel crown.
      float sunSideLight = pow(max(dot(tubeN, sunN) * 0.5 + 0.5, 0.0), 4.0);
      vec3 tubeWall = vec3(0.008, 0.008, 0.008)
        + vec3(0.10, 0.088, 0.075) * sunSideLight * uSunFacing * 0.25;

      // FAR WALL (the hollow-tube cue): off-axis, the wall opposite the eye's
      // offset turns edge-on and catches ambient light. Directional, not radial
      // — this is what makes the bore read as a real cylinder you're inside.
      float farWall = pow(max(dot(tubeN, -eyeDirT) * 0.5 + 0.5, 0.0), 3.0);
      tubeWall += vec3(0.11, 0.105, 0.095) * farWall
        * (0.08 + min(swayDist * 1.4, 0.6)) * (0.35 + 0.65 * uSunFacing);

      // INFINITE-MIRROR FRESNEL: Schlick-style grazing reflectance on the
      // cylindrical wall. F0 base so the wall is never flat black, and a
      // (1-cos)^5 wall-grazing term so the ocular lip mirrors hardest and
      // each bounce down the bore reflects dimmer — the receding-mirror read.
      // Stays steel blue-grey, never paper white; rim line itself untouched.
      float frSun = pow(max(dot(tubeN, sunN) * 0.5 + 0.5, 0.0), 4.0);
      float lip = 1.0 - depth; // 1 at ocular lip → 0 deep at objective
      float grazing = pow(1.0 - clamp(dot(tubeN, -eyeDirT) * 0.5 + 0.5, 0.0, 1.0), 2.0);
      float F0 = 0.08 + 0.30 * uSunIntensity;
      float fresnel = F0 + (1.0 - F0) * pow(clamp(farWall * 0.7 + lip * 0.6 + grazing * 0.4, 0.0, 1.0), 2.5);
      fresnel *= 0.55 + 0.75 * uSunFacing * (0.4 + 0.6 * frSun) + 0.35 * uSunIntensity;
      vec3 mirrorTint = mix(vec3(0.30, 0.36, 0.43), vec3(0.55, 0.50, 0.42), frSun * 0.55);
      tubeWall += mirrorTint * fresnel * 0.85 * uMirrorBoost;

      // Infinite bounces: thin repeating ring highlights converging down the
      // bore, each dimmer than the last (pow falloff on lip). Chirped so they
      // bunch toward the objective like real perspective reflections.
      // Gated by O (uMirrorBoost): DIM default, BRIGHT is the bumped look.
      float bouncePh = (depth + depth * depth * 0.9) * 22.0 * 6.2831853;
      float bounce1 = pow(0.5 + 0.5 * sin(bouncePh), 6.0);
      float bounce2 = pow(0.5 + 0.5 * sin(bouncePh * 2.13 + 1.7), 10.0);
      float bounceDecay = mix(0.25, 1.0, lip * lip);
      vec3 bounceTint = mix(vec3(0.38, 0.45, 0.53), vec3(0.60, 0.54, 0.44), frSun * 0.6);
      tubeWall += bounceTint * (bounce1 * 0.55 + bounce2 * 0.35) * fresnel * bounceDecay * uMirrorBoost;

      // Baffle ridges at fixed DEPTH: chirped so they bunch toward the objective
      // instead of a flat moiré. transitBoost lights them mid-shoulder and zoom.
      float transitBoost = (1.0 + transit * 1.2) * (1.0 + (uZoomK - 1.0) * 0.3);
      float baffles = 0.5 + 0.5 * sin((depth + depth * depth * 0.6) * 26.0 * 6.2831853);
      baffles = mix(baffles, 0.5, outerSoft * 0.8);
      // Mirror bore: crests catch light, troughs mirror dark — deeper contrast
      tubeWall *= (0.62 + 0.38 * baffles);
      // Depth falloff, gentler so deep bounces stay visible (infinite read)
      tubeWall *= mix(1.0, 0.72, depth);
      // Cool scatter at the deep end + warm sun on the crests (crest glint
      // rides the O mirror toggle too)
      tubeWall += vec3(0.03, 0.038, 0.05) * (1.0 - depth) * (0.3 + 0.6 * uSunIntensity);
      tubeWall += vec3(0.55, 0.48, 0.40) * pow(baffles, 3.0) * sunSideLight * uSunFacing * 0.30 * transitBoost * uMirrorBoost;

      // Hairline radial fade: only the innermost sliver of wall stays lit,
      // everything further out falls to near-black — tiny-tiny ring, no disc.
      float beyond = max(distImg - nearR, 0.0);
      float hairline = exp(-beyond * 220.0);
      tubeWall *= mix(0.10, 1.0, hairline);
      // Hip bore stays dark: no aligned eye → no lit mirror, just a glint.
      tubeWall *= mix(0.22, 1.0, eyeBox);

      // Objective-bell crescent: hairline lip only.
      float crescentLine = 1.0 - smoothstep(0.0, 0.006 + outerSoft * 0.006, abs(distImg - nearR));
      float crescent = crescentLine * pow(max(dot(tubeN, sunN) * 0.5 + 0.5, 0.0), 6.0);
      tubeWall += vec3(0.45, 0.42, 0.38) * crescent * uSunFacing * 0.12 * hairline;

      // Oily travelling sheen with sway (grazing glass edge, not lit paint).
      float innerRefl = pow(max(dot(tubeN, sweepDir) * 0.5 + 0.5, 0.0), 12.0) * swayDist * 0.30;
      tubeWall += vec3(0.08, 0.08, 0.08) * innerRefl * hairline;

      // Objective glass (far rim) hairline kiss only.
      float objLip = 1.0 - smoothstep(0.0, 0.003 + outerSoft * 0.004, abs(dFar - farR));
      tubeWall += vec3(0.10, 0.115, 0.125) * objLip
        * (0.10 + 0.30 * uSunIntensity) * (0.4 + 0.6 * etchVis) * hairline;

      // ---- LAYERED GLASS (subtle, near-neutral) ----
      // A scope is a stack of coated elements; each reflects a LITTLE. Keep
      // them near-neutral and barely-there so the picture stays "scope ==
      // world" — a faint glass pane, never a colored wash. All of them
      // strengthen off-axis (eye sway = grazing angle) and with magnification,
      // which is why they previously only read during the shoulder travel.
      {
        float fresSway = min(swayDist * 2.5, 1.0);
        float fresZoom = clamp((uZoomK - 1.0) * 0.25, 0.0, 1.0);
        // Slightly lifted base so glass reads centered, never milky/white.
        float fresBoost = (0.50 + 0.65 * fresSway) * (1.0 + fresZoom);
        // objective fresnel: dark neutral reflection, faint cool lift at rim
        float objR = distFromCenter / 0.5;                 // 0..1
        float cosInc = 1.0 / sqrt(1.0 + objR * objR * 3.0);
        float objFres = pow(1.0 - cosInc, 3.2);
        vec3 objRefl = mix(vec3(0.03, 0.035, 0.045), vec3(0.24, 0.28, 0.34), objFres);
        sceneColor = mix(sceneColor, objRefl,
          clamp(objFres * (0.10 + 0.22 * uSunIntensity) * fresBoost, 0.0, 0.5) * (1.0 - objectiveMask));
        // MgF2 coating sheen: faint magenta/green, sun-side, sweeps with the eye
        vec2 coatDir = normalize(uSunSide + uEyeOffset * 5.0 + vec2(1e-4));
        float sheenAmt = smoothstep(0.28, 0.5, distFromCenter) * (0.15 + 0.6 * uSunIntensity) * 0.08 * fresBoost;
        vec3 coat = mix(vec3(0.5, 0.22, 0.45), vec3(0.22, 0.5, 0.30), 0.5 + 0.5 * dot(tubeN, coatDir));
        sceneColor += coat * sheenAmt * (1.0 - objectiveMask);
        // sky fresnel veil: faint, neutral, rim-only
        float veil = pow(smoothstep(0.30, 0.5, distFromCenter), 2.0) * 0.07 * (0.3 + 0.7 * uSunIntensity) * fresBoost;
        sceneColor = mix(sceneColor, vec3(0.42, 0.46, 0.50), clamp(veil, 0.0, 0.4) * (1.0 - objectiveMask));
      }

      // ---- EYE-BOX SHADOW: one crisp crescent, pure eye geometry ----
      // The picture the eye sees = field stop ∩ eye pupil. The pupil is a disc
      // the same size as the field stop that slides ALONG the eye drift (sign
      // of uCrescentSide, toggled with H); sliding it yields exactly ONE
      // crescent that closes to nothing when the eye is centred (concentric
      // equal discs → no overlap, no shadow). No motion gate anywhere — the
      // darkness is a smooth function of how deep the pixel lies past the pupil
      // arc, so a sway draws a gradiented crescent and stopping lets it shrink
      // away instead of ghosting out at one opacity.
      // Deliberately NOT masked to "inside the field stop": the dim is deepest
      // exactly at the picture edge (the bite is largest there), so it must run
      // all the way out to meet the black tube — an inField clip left a bright
      // "space between two masks". Pixels past the stop are tube anyway (mixed
      // below), so dimming them here is harmless.
      float eyeBoxShadow = 0.0;
      {
        float eyeMag = length(uEyeOffset);
        vec2 eyeDir = eyeMag > 1e-4 ? uEyeOffset / eyeMag : vec2(0.0);
        // Fast swings thicken the crescent (directional), never a smaller
        // centred disc — uSwaySpeed now feeds the crescent's bite, replacing the
        // old symmetric aperture collapse that read as tunnel vision.
        // uCrescentPower (0..1) maps LOW/MEDIUM/HIGH/EXTREME onto the bite
        // gain with a squared ramp so the top end dominates: LOW ≈ 2.2x, MEDIUM
        // ≈ 4.4x, HIGH ≈ 8x, EXTREME ≈ 13x. The slide is the pupil-center
        // offset as a FRACTION of the field-stop radius; slide ≈ 1.7 leaves the
        // two circles nearly tangent so ~90% of the sight picture is blacked
        // out — a big crescent, not a thin rim.
        float swingBoost = 1.0 + uSwaySpeed * 1.2;
        float crescentGain = mix(1.5, 13.0, uCrescentPower * uCrescentPower);
        float slide = min(eyeMag * crescentGain * swingBoost, 1.7);
        vec2 pupilC = nearC + eyeDir * nearR * slide * uCrescentSide;
        float bite = length(uv - pupilC) - nearR;
        // Edge-attached gradient: darkest where the bite is deepest (at the
        // picture edge, against the tube), fading back to full brightness at
        // the pupil arc. The ramp width IS the max bite depth, so the shadow
        // always reaches full black exactly at the FOV boundary — no bright
        // seam/ring left between the shadow and the tube.
        float biteMax = max(nearR * slide, 0.05 * nearR);
        float bb = clamp(max(bite, 0.0) / biteMax, 0.0, 1.0);
        // Quintic smoothstep: steeper mid-band than cubic, so the crescent has
        // a darker, more uniform core and a crisp inner arc instead of a soft
        // gradient wash that read as a faint oval.
        float shade = bb * bb * bb * (bb * (bb * 6.0 - 15.0) + 10.0);
        // only matters once the rifle is shouldered — hip keeps its dim peephole.
        float seatGain = smoothstep(0.25, 0.8, eyeBox);
        eyeBoxShadow = shade * seatGain;
        sceneColor *= 1.0 - eyeBoxShadow;
      }

      // Crescent always blackens the bore (realistic — the pupil clips
      // everything). O toggles mirror brightness instead (uMirrorBoost).
      vec3 tubeDimmed = tubeWall * (1.0 - eyeBoxShadow * uOutlineShade);
      vec3 viewWithTunnel = mix(sceneColor, tubeDimmed, objectiveMask);

      // ocular rim: hairline only — tiny-tiny
      float ocularShadow = smoothstep(0.488, 0.5, distOcular);
      float ringBand = 1.0 - smoothstep(0.0, 0.0025 + outerSoft * 0.003, abs(distOcular - 0.483));
      // bevel: hairline chamfer just inside the rim
      float bevel = 1.0 - smoothstep(0.0, 0.004 + outerSoft * 0.004, abs(distOcular - 0.476));
      vec2 ocuN = distOcular > 1e-4 ? uv / distOcular : vec2(0.0, 1.0);
      float ringGlint = pow(max(dot(ocuN, sunN) * 0.5 + 0.5, 0.0), 3.0);
      vec3 ringLight = vec3(0.45, 0.45, 0.45) * ringBand * ringGlint * (0.06 + uSunIntensity * 0.40);
      // keep opposite side dark for roundness
      float ringShade = pow(max(dot(ocuN, -sunN) * 0.5 + 0.5, 0.0), 2.0);
      viewWithTunnel -= vec3(0.05) * ringBand * ringShade;
      // the machined rim lights dim with the crescent so they never float
      // as a bright ring over the darkened picture.
      float rimGate = 1.0 - eyeBoxShadow * uOutlineShade;
      viewWithTunnel += ringLight * rimGate;
      // bevel chamfer catches a dull, narrow light
      viewWithTunnel += vec3(0.08, 0.08, 0.082) * bevel * (0.25 + 0.45 * ringGlint) * rimGate;

      vec3 finalColor = mix(viewWithTunnel, vec3(0.0), ocularShadow);

      // Sight-picture brightness: dim center (transmission loss, above), real
      // falloff toward the rim. Never lift the image. Guarded: aperture is
      // exactly 0 at hip (no peephole) so the edge can't be 0.
      float brightT = smoothstep(0.0, max(currentAperture, 1e-4), length(uv - imageCenter));
      finalColor *= mix(1.0, 0.62, brightT);

      // faint grain for tactical grit (not in the black tunnel)
      float grain = hash21(vUv * 913.0 + fract(uTime) * 7.0) - 0.5;
      finalColor += grain * 0.012 * (1.0 - objectiveMask) * (1.0 - ocularShadow);

      gl_FragColor = vec4(finalColor, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }

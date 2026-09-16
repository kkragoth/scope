    uniform sampler2D tSharp;
    uniform sampler2D tBlur;
    uniform sampler2D tDepth;
    uniform float uNear;
    uniform float uFar;
    uniform float uFocus;
    uniform float uStrength;
    varying vec2 vUv;
    void main() {
      vec3 sharp = texture2D(tSharp, vUv).rgb;
      float depth01 = texture2D(tDepth, vUv).x;
      float dist = -(uNear * uFar) / ((uFar - uNear) * depth01 - uFar);
      float coc = dist > uFocus
        ? (dist - uFocus) / (uFocus * 1.2 + 30.0)
        : (uFocus - dist) / (uFocus * 0.3 + 3.0);
      coc = clamp(coc, 0.0, 1.0);
      // gun + sky stay readable; the world between melts
      float nearKeep = 1.0 - smoothstep(0.5, uFocus * 0.6, dist);
      coc *= 1.0 - nearKeep * 0.85;
      coc *= 1.0 - smoothstep(0.9995, 1.0, depth01) * 0.88;
      vec3 col = mix(sharp, texture2D(tBlur, vUv).rgb, clamp(coc * uStrength, 0.0, 1.0));
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }

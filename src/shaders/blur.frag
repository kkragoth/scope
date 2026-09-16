    uniform sampler2D tSrc;
    uniform vec2 uDir;
    uniform vec2 uTexel;
    varying vec2 vUv;
    void main() {
      vec2 o1 = uDir * uTexel * 1.384;
      vec2 o2 = uDir * uTexel * 3.230;
      vec3 c = texture2D(tSrc, vUv).rgb * 0.227027;
      c += texture2D(tSrc, vUv + o1).rgb * 0.3162162;
      c += texture2D(tSrc, vUv - o1).rgb * 0.3162162;
      c += texture2D(tSrc, vUv + o2).rgb * 0.0702703;
      c += texture2D(tSrc, vUv - o2).rgb * 0.0702703;
      gl_FragColor = vec4(c, 1.0);
    }

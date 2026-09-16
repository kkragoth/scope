    uniform vec3 uSunDir;
    uniform float uTime;
    varying vec3 vDir;
    float skyHash(vec2 p) {
      p = fract(p * vec2(234.34, 435.345));
      p += dot(p, p + 34.23);
      return fract(p.x * p.y);
    }
    float skyNoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(skyHash(i), skyHash(i + vec2(1.0, 0.0)), u.x),
                 mix(skyHash(i + vec2(0.0, 1.0)), skyHash(i + vec2(1.0, 1.0)), u.x), u.y);
    }
    void main() {
      vec3 d = normalize(vDir);
      float h = d.y;
      vec3 zen = vec3(0.16, 0.30, 0.52);
      vec3 hor = vec3(0.76, 0.79, 0.81);
      vec3 gnd = vec3(0.32, 0.31, 0.28);
      vec3 col = mix(hor, zen, pow(max(h, 0.0), 0.55));
      col = mix(col, gnd, smoothstep(0.0, -0.35, h));
      float s = max(dot(d, uSunDir), 0.0);
      // streaky clouds (planar projection, slow drift) — silver-lined near sun
      float cl = skyNoise(vec2(d.x * 2.2, d.z * 5.5) / max(h + 0.22, 0.06)
        + vec2(uTime * 0.004, uTime * 0.0015));
      cl = cl * 0.65 + skyNoise(vec2(d.x * 5.0, d.z * 11.0) / max(h + 0.22, 0.06)) * 0.35;
      float cover = smoothstep(0.52, 0.74, cl) * smoothstep(0.02, 0.18, h);
      vec3 cloudCol = mix(vec3(0.62, 0.63, 0.65), vec3(1.06, 0.96, 0.86), pow(s, 3.0));
      col = mix(col, cloudCol, cover * 0.7);
      // disc (smaller, hotter ball) + tight halo + mid haze + wide warmth
      col += vec3(1.0, 0.95, 0.86) * pow(s, 3500.0) * 5.0;
      col += vec3(1.0, 0.92, 0.78) * pow(s, 900.0) * 0.9;
      col += vec3(1.0, 0.90, 0.75) * pow(s, 160.0) * 0.28;
      col += vec3(0.95, 0.85, 0.70) * pow(s, 7.0) * 0.07;
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }

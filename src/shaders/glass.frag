      uniform vec3 uSunDirW;
      uniform float uReflect;
      uniform float uOcular;
      varying vec2 vP;
      varying vec3 vWN;
      varying vec3 vWP;
      void main() {
        float r = clamp(length(vP), 0.0, 1.0);
        vec3 N = normalize(vWN);
        vec3 V = normalize(cameraPosition - vWP);
        float ndv = abs(dot(N, V));
        float fres = pow(1.0 - ndv, 3.5);
        vec3 H = normalize(V + uSunDirW);
        float spec = pow(max(dot(N, H), 0.0), 180.0);
        // MgF2-style coating swing: magenta center → green rim
        vec3 coat = mix(vec3(0.45, 0.18, 0.6), vec3(0.2, 0.65, 0.45), r * r);
        vec3 skyRef = mix(vec3(0.04, 0.05, 0.07), vec3(0.55, 0.60, 0.66), fres);
        float edgeGlow = smoothstep(0.85, 1.0, r) * 0.15;
        if (uOcular > 0.5) {
          // see-through: faint tint + fresnel veil + sun tick. Center stays
          // clear so the sight picture reads through it untouched.
          vec3 col = vec3(0.35, 0.45, 0.55) * fres * uReflect
            + vec3(1.0, 0.95, 0.85) * spec * 1.2
            + coat * fres * 0.12;
          float alpha = clamp(0.03 + fres * 0.55 * uReflect + spec + edgeGlow, 0.0, 0.9);
          gl_FragColor = vec4(col, alpha);
        } else {
          // front element: dark coated glass, mirrored sky + sun glint
          vec3 col = vec3(0.008, 0.01, 0.013)
            + skyRef * uReflect
            + vec3(1.0, 0.95, 0.85) * spec * 1.6
            + coat * fres * 0.3;
          gl_FragColor = vec4(col, 1.0);
        }
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }

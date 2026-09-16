      uniform float uOcular;
      varying vec2 vP;
      varying vec3 vWN;
      varying vec3 vWP;
      void main() {
        vP = uv * 2.0 - 1.0;
        // fake spherical cap: gentle dome so reflections roll to rim
        float dome = uOcular > 0.5 ? 1.0 : -1.0;
        vec3 domeN = normalize(vec3(vP.x * 0.55, vP.y * 0.55, dome));
        vWN = normalize(mat3(modelMatrix) * domeN);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWP = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }

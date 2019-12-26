#ifndef HILO_MAX_FRAGMENT_PRECISION
    #define HILO_MAX_FRAGMENT_PRECISION highp;
#endif
precision HILO_MAX_FRAGMENT_PRECISION float;
varying vec2 v_texcoord0;
uniform sampler2D u_fireCoreTexture;
uniform float u_time;

void main(void) {
    float uOffset = u_time * 0.00;
    float vOffset = u_time * 0.001;
    vec4 fireCore = texture2D(u_fireCoreTexture, vec2(v_texcoord0.x + uOffset, v_texcoord0.y + vOffset));
    if (fireCore.r < 0.5) {
        discard;
    }
    gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);
}
#ifndef HILO_MAX_FRAGMENT_PRECISION
    #define HILO_MAX_FRAGMENT_PRECISION highp;
#endif
precision HILO_MAX_FRAGMENT_PRECISION float;
varying vec2 v_texcoord0;
uniform sampler2D u_fireStenTexture;
void main(void) {
    float gradient_start = 1.0;
    vec2 gradient = vec2(0, -1.0);
    vec4 fireSten = texture2D(u_fireStenTexture, v_texcoord0);
    vec3 col1 = vec3(1.0, 0.0, 0.0);
    vec3 col2 = vec3(1.0, 1.0, 0.0);
    vec3 col = col1 + (col2 - col1) * max(0.0, min(gradient_start+dot(v_texcoord0, gradient)+(fireSten.x-0.5)*0.1, 1.0));
    gl_FragColor = vec4(col, 1);
}
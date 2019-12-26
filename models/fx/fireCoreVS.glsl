#ifndef HILO_MAX_VERTEX_PRECISION
    #define HILO_MAX_VERTEX_PRECISION highp;
#endif
precision HILO_MAX_VERTEX_PRECISION float;
attribute vec3 a_position;
attribute vec2 a_texcoord0;
uniform mat4 u_modelViewProjectionMatrix;
varying vec2 v_texcoord0;

void main(void) {
    vec4 pos = vec4(a_position, 1.0);
    gl_Position = u_modelViewProjectionMatrix * pos;
    v_texcoord0 = a_texcoord0;
}
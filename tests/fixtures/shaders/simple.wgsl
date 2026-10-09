// A minimal WGSL module used by the fixture tests and by tools/shader-compiler.
//
// Kept deliberately tiny: one uniform block, one vertex input, one output struct and
// one entry pair. It is a valid WGSL sketch of the same pipeline as
// tests/fixtures/shaders/simple.glsl, so the two can be compared structurally.

struct Uniforms {
  modelViewMatrix: mat4x4<f32>,
  projectionMatrix: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) normal: vec3<f32>,
};

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.normal = input.normal;
  output.position = uniforms.projectionMatrix * uniforms.modelViewMatrix * vec4<f32>(input.position, 1.0);
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let shade = clamp(dot(normalize(input.normal), vec3<f32>(0.0, 1.0, 0.0)), 0.0, 1.0);
  return vec4<f32>(vec3<f32>(0.18, 0.44, 0.87) * (0.2 + shade * 0.8), 1.0);
}

/**
 * `effects/particles` — pooled, deterministic particle simulation.
 *
 * | Class | Role |
 * | --- | --- |
 * | {@link ParticleEmitter} | where particles are born, and with what initial state |
 * | {@link ParticleMaterial} | blending, size and texture binding as structural data |
 * | {@link ParticleSystem} | the pooled simulation, its attributes and its lifecycle |
 *
 * @packageDocumentation
 */

export * from './ParticleEmitter';
export * from './ParticleMaterial';
export * from './ParticleSystem';

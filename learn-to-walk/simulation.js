// Browser implementation of the checkpoint's observation and control contract.
export async function compressedBuffer(response) {
  if (!response.ok) throw new Error(`Could not load ${response.url} (HTTP ${response.status}).`);
  return new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

function siteVelocity(state, site, body, root) {
  const c = state.cvel;
  const b = 6 * body;
  const s = 3 * site;
  const r = 3 * root;
  const p = state.site_xpos;
  const com = state.subtree_com;
  const dx = p[s] - com[r], dy = p[s+1] - com[r+1], dz = p[s+2] - com[r+2];
  const wx = c[b], wy = c[b+1], wz = c[b+2];
  return [wx, wy, wz,
    c[b+3] + wy*dz - wz*dy,
    c[b+4] + wz*dx - wx*dz,
    c[b+5] + wx*dy - wy*dx];
}

function rotationVector(m) {
  // Convert a row-major rotation matrix to the shortest axis-angle vector.
  let x, y, z, w;
  const trace = m[0] + m[4] + m[8];
  if (trace > 0) {
    const s = 2 * Math.sqrt(trace + 1);
    w = s/4; x = (m[7]-m[5])/s; y = (m[2]-m[6])/s; z = (m[3]-m[1])/s;
  } else if (m[0] >= m[4] && m[0] >= m[8]) {
    const s = 2 * Math.sqrt(1 + m[0] - m[4] - m[8]);
    w = (m[7]-m[5])/s; x = s/4; y = (m[1]+m[3])/s; z = (m[2]+m[6])/s;
  } else if (m[4] >= m[8]) {
    const s = 2 * Math.sqrt(1 + m[4] - m[0] - m[8]);
    w = (m[2]-m[6])/s; x = (m[1]+m[3])/s; y = s/4; z = (m[5]+m[7])/s;
  } else {
    const s = 2 * Math.sqrt(1 + m[8] - m[0] - m[4]);
    w = (m[3]-m[1])/s; x = (m[2]+m[6])/s; y = (m[5]+m[7])/s; z = s/4;
  }
  const norm = Math.hypot(x, y, z);
  const scale = (w < 0 ? -1 : 1) * (norm < 1e-9 ? 2 : 2*Math.atan2(norm, Math.abs(w))/norm);
  return [x*scale, y*scale, z*scale];
}

export function buildObservation(state, schema, reference, output = new Float32Array(schema.size)) {
  for (const [field, [source, destination]] of Object.entries(schema.blocks)) {
    const values = state[field];
    for (let i = 0; i < source.length; i++) output[destination[i]] = values[source[i]];
  }

  const { sites, siteBodies, siteRoots, goalOffset, liveGoalSize } = schema;
  const count = sites.length - 1;
  const positions = state.site_xpos;
  const matrices = state.site_xmat;
  const origin = 3*sites[0], rootMatrix = 9*sites[0];
  const rootVelocity = siteVelocity(state, sites[0], siteBodies[0], siteRoots[0]);
  const relative = new Float64Array(9);
  for (let i = 1; i < sites.length; i++) {
    const site = sites[i];
    const point = 3*site, matrix = 9*site;
    const posOutput = goalOffset + 3*(i-1);
    const angleOutput = posOutput + 3*count;
    const velOutput = goalOffset + 6*count + 6*(i-1);
    const velocity = siteVelocity(state, site, siteBodies[i], siteRoots[i]);
    for (let row = 0; row < 3; row++) {
      output[posOutput + row] = positions[point+row] - positions[origin+row];
      for (let column = 0; column < 3; column++) {
        relative[3*row+column] = matrices[rootMatrix+row] * matrices[matrix+column]
          + matrices[rootMatrix+3+row] * matrices[matrix+3+column]
          + matrices[rootMatrix+6+row] * matrices[matrix+6+column];
      }
    }
    output.set(rotationVector(relative), angleOutput);
    for (let row = 0; row < 3; row++) {
      output[velOutput+row] = relative[row]*velocity[0] + relative[3+row]*velocity[1]
        + relative[6+row]*velocity[2] - rootVelocity[row];
      output[velOutput+3+row] = matrices[rootMatrix+3*row] * (rootVelocity[3]-velocity[3])
        + matrices[rootMatrix+3*row+1] * (rootVelocity[4]-velocity[4])
        + matrices[rootMatrix+3*row+2] * (rootVelocity[5]-velocity[5]);
    }
  }
  output.set(reference.subarray(0, schema.referenceSize), goalOffset + liveGoalSize);
  return output;
}

export class WalkingSimulation {
  constructor(mujoco, model, data, manifest, references, ort, actor, backend) {
    Object.assign(this, { mujoco, model, data, manifest, references, ort, actor, backend });
    this.observation = new Float32Array(manifest.observation.size);
    this.observationTensor = new ort.Tensor('float32', this.observation, [1, this.observation.length]);
    this.noiseOffset = manifest.referenceFrames * manifest.referenceStride;
    this.reset();
  }

  static async create({ manifest, xml, physics, references, actorWeights, backend = 'wasm', vendor, progress = () => {} }) {
    const useGpu = backend === 'webgpu';
    const ortModule = useGpu ? 'ort.webgpu.bundle.min.mjs' : 'ort.wasm.bundle.min.mjs';
    const [ort, { default: loadMujoco }] = await Promise.all([
      import(new URL(ortModule, vendor).href), import(new URL('mujoco.js', vendor).href),
    ]);
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = vendor.href;
    ort.env.wasm.initTimeout = 180_000;
    progress('Starting the physics engine…');
    const mujoco = await loadMujoco({ locateFile: name => new URL(name, vendor).href });
    progress('Compiling the musculoskeletal model…');
    const vfs = new mujoco.MjVFS();
    let model;
    try {
      const bytes = new Uint8Array(physics);
      for (const [name, start, size] of manifest.assets) {
        vfs.addBuffer(name, bytes.subarray(start, start + size));
      }
      model = mujoco.MjModel.from_xml_string(xml, vfs);
    } finally {
      vfs.delete();
    }
    for (const [key, value] of Object.entries(manifest.dimensions)) {
      if (model[key] !== value) {
        model.delete();
        throw new Error(`Model shape mismatch for ${key}.`);
      }
    }
    progress('Initializing the walking policy…');
    let actor;
    try {
      actor = await ort.InferenceSession.create(actorWeights, {
        executionProviders: useGpu ? ['webgpu', 'wasm'] : ['wasm'],
        graphOptimizationLevel: 'all',
      });
    } catch (error) {
      model.delete();
      throw error;
    }
    return new WalkingSimulation(mujoco, model, new mujoco.MjData(model),
      manifest, new Float32Array(references), ort, actor, backend);
  }

  reference(frame = this.frame) {
    const { referenceLoop: [loopStart, loopEnd], referenceStride } = this.manifest;
    const index = frame < loopEnd ? frame : loopStart + (frame-loopEnd) % (loopEnd-loopStart);
    const start = index * referenceStride;
    return this.references.subarray(start, start + referenceStride);
  }

  reset() {
    const { mujoco, model, data, manifest } = this;
    mujoco.mj_resetData(model, data);
    for (const field of ['qpos', 'qvel', 'act', 'ctrl']) data[field].set(manifest.reset[field]);
    mujoco.mj_forward(model, data);
    data.qacc_warmstart.set(manifest.reset.qacc_warmstart);
    this.frame = 0;
    this.pushFrames = 0;
    this.start = [data.qpos[0], data.qpos[1]];
    this.done = null;
  }

  async meanAction(observation = this.observation) {
    const input = observation === this.observation
      ? this.observationTensor : new this.ort.Tensor('float32', observation, [1, observation.length]);
    const outputs = await this.actor.run({ observation: input });
    return outputs.mean_action.data;
  }

  async step() {
    if (this.done) return this.done;
    const { data, manifest, mujoco, model } = this;
    buildObservation(data, manifest.observation, this.reference(), this.observation);
    const t0 = performance.now();
    const mean = await this.meanAction();
    const t1 = performance.now();
    const noise = this.noiseOffset + (this.frame % manifest.referenceFrames) * mean.length;
    const ctrl = data.ctrl;
    for (let i = 0; i < mean.length; i++) {
      const action = mean[i] + manifest.actionStd[i] * this.references[noise+i];
      ctrl[manifest.actionIndices[i]] = .5 * (1 + Math.max(-1, Math.min(1, action)));
    }
    data.xfrc_applied[manifest.pelvis*6] = this.pushFrames > 0 ? 40 : 0;
    if (this.pushFrames > 0) this.pushFrames--;
    for (let i = 0; i < manifest.substeps; i++) mujoco.mj_step(model, data);
    this.inferenceMs = t1-t0;
    this.physicsMs = performance.now()-t1;
    this.frame++;
    this.done = this.endReason();
    return this.done;
  }

  endReason() {
    const { data, manifest } = this;
    const { qpos, qvel, act } = data;
    const t = manifest.terminal;
    const finite = qpos.every(Number.isFinite) && qvel.every(Number.isFinite) && act.every(Number.isFinite);
    if (!finite || Math.abs(data.time - this.frame*manifest.dt) > 1e-5) return 'Numerical failure';
    const upright = 1 - 2*(qpos[4]**2 + qpos[5]**2);
    if (qpos[2] < t.fall_min_height_m || upright < t.fall_min_upright) return 'Fall';
    return null;
  }

  snapshot() {
    const { manifest, data } = this;
    const x = data.qpos[0], y = data.qpos[1];
    const positions = data.xpos, quaternions = data.xquat, activations = data.act;
    const bones = new Float32Array(manifest.bodyIds.length * 7);
    for (const [i, body] of manifest.bodyIds.entries()) {
      const p = 3*body, q = 4*body;
      bones.set([positions[p]-x, positions[p+1]-y, positions[p+2],
        quaternions[q+1], quaternions[q+2], quaternions[q+3], quaternions[q]], 7*i);
    }
    const groups = new Uint8Array(manifest.activationGroups.length);
    for (const [i, group] of manifest.activationGroups.entries()) {
      let sum = 0;
      for (const index of group) sum += activations[index];
      groups[i] = Math.round(255*Math.min(1, Math.max(0, sum/group.length)));
    }
    const seconds = this.frame * manifest.dt;
    const distance = Math.hypot(x-this.start[0], y-this.start[1]);
    return { bones, groups, x, y, seconds, distance, done: this.done };
  }
}

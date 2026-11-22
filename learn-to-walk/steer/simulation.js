import { addBallBody, BallThrows } from './ball.js?v=3';
import { TurnReference, yawOf } from './turn-reference.js?v=1';

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

function writeSites(state, { sites, siteBodies, siteRoots }, output, position, angle, speed) {
  const positions = state.site_xpos;
  const matrices = state.site_xmat;
  const origin = 3*sites[0], rootMatrix = 9*sites[0];
  const rootVelocity = siteVelocity(state, sites[0], siteBodies[0], siteRoots[0]);
  const relative = new Float64Array(9);
  for (let i = 1; i < sites.length; i++) {
    const site = sites[i];
    const point = 3*site, matrix = 9*site;
    const posOutput = position + 3*(i-1);
    const angleOutput = angle + 3*(i-1);
    const velOutput = speed + 6*(i-1);
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
}

export function buildObservation(state, schema, reference, output = new Float32Array(schema.size)) {
  for (const [field, [source, destination]] of Object.entries(schema.blocks)) {
    const values = state[field];
    for (let i = 0; i < source.length; i++) output[destination[i]] = values[source[i]];
  }
  const { goalOffset, liveGoalSize } = schema;
  const size = 3*(schema.sites.length - 1);
  writeSites(state, schema, output, goalOffset, goalOffset + size, goalOffset + 2*size);
  if (reference) output.set(reference.subarray(0, schema.referenceSize), goalOffset + liveGoalSize);
  return output;
}

function speedPreview(speed, target, seconds, acceleration, round = Number) {
  const difference = Math.fround(target-speed);
  const slope = Math.fround(acceleration);
  const duration = round(seconds);
  const ramp = Math.min(duration, Math.fround(Math.abs(difference)/slope));
  const endSpeed = round(speed + round(Math.sign(difference)*slope*ramp));
  const rampDistance = round(round(round(speed + endSpeed)*.5)*ramp);
  const settledDistance = round(target*round(duration-ramp));
  return [endSpeed, round(rampDistance + settledDistance)];
}

function normalize(vector) {
  const length = Math.hypot(...vector);
  return vector.map(value => value / length);
}

function cross(a, b) {
  return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
}

class SpeedCommand {
  constructor(manifest, references) {
    const { speedCommand, dt, dimensions, referenceLoop, referenceStride, observation } = manifest;
    Object.assign(this, { config: speedCommand, dt, references, referenceLoop, referenceStride,
      referenceFrames: manifest.referenceFrames, observation });
    const sites = observation.sites.map((_, index) => index);
    this.siteSchema = { sites, siteBodies: sites, siteRoots: sites };
    this.row = new Float64Array(referenceStride);
    let offset = 0;
    const fields = { qpos: dimensions.nq, qvel: dimensions.nv, subtree_com: 3*sites.length,
      site_xpos: 3*sites.length, site_xmat: 9*sites.length, cvel: 6*sites.length };
    this.sample = Object.fromEntries(Object.entries(fields).map(([field, size]) => {
      const values = this.row.subarray(offset, offset+size);
      offset += size;
      return [field, values];
    }));
    if (offset !== referenceStride) throw new Error('Speed reference shape mismatch.');
    this.natural = Math.fround(speedCommand.natural);
    this.target = this.natural;
    this.turn = manifest.turnCommand && new TurnReference(manifest.turnCommand, speedPreview);
    this.reset();
  }

  reset() {
    this.phase = 0;
    this.speed = this.natural;
    this.retimed = false;
    this.turn?.reset();
  }

  setTarget(target) {
    if (!Number.isFinite(target)) return;
    this.target = Math.fround(Math.max(this.config.minimum, Math.min(this.config.maximum, target)));
  }

  advance(frame) {
    // Native control updates integrate a Float32 clock. Lookahead uses Float64 time offsets.
    const round = Math.fround;
    const [speed, distance] = speedPreview(this.speed, this.target, this.dt, this.config.acceleration, round);
    const travelledFrames = round(distance/round(this.config.natural*this.dt));
    const old = this.turn && this.rootXY(this.phase);
    this.retimed ||= this.target !== this.natural;
    this.phase = this.retimed ? round(this.phase + travelledFrames) : frame;
    this.speed = speed;
    if (old) {
      const next = this.rootXY(this.phase);
      this.turn.advance(this.dt, [next[0]-old[0], next[1]-old[1]]);
    }
  }

  rootXY(phase) {
    const [start, end] = this.referenceLoop;
    const cycles = phase < end ? 0 : 1 + Math.floor((phase-end)/(end-start));
    const stride = this.referenceStride, index = Math.floor(phase), fraction = phase-index;
    const a = (index-cycles*(end-start))*stride;
    const refs = this.references;
    return [0, 1].map(i => refs[a+i] + fraction*(refs[a+stride+i]-refs[a+i])
      + cycles*(refs[end*stride+i]-refs[start*stride+i]));
  }

  readReference(phase, rate) {
    const [start, end] = this.referenceLoop;
    const cycles = phase < end ? 0 : 1 + Math.floor((phase-end)/(end-start));
    const stride = this.referenceStride;
    const index = Math.floor(phase);
    const fraction = phase-index;
    const a = (index-cycles*(end-start))*stride;
    const b = a + stride;
    const source = this.references;
    const { qpos, qvel, site_xmat: matrices, cvel } = this.sample;
    for (let i = 0; i < stride; i++) this.row[i] = source[a+i] + fraction*(source[b+i]-source[a+i]);
    if (fraction) {
      let dot = 0;
      for (let i = 3; i < 7; i++) dot += source[a+i]*source[b+i];
      if (dot < 0) {
        for (let i = 3; i < 7; i++) qpos[i] = source[a+i]-fraction*(source[b+i]+source[a+i]);
      }
      qpos.set(normalize(qpos.subarray(3, 7)), 3);
      for (let i = 0; i < matrices.length; i += 9) {
        const x = normalize([matrices[i], matrices[i+3], matrices[i+6]]);
        const z = normalize(cross(x, [matrices[i+1], matrices[i+4], matrices[i+7]]));
        const y = cross(z, x);
        for (let axis = 0; axis < 3; axis++) matrices.set([x[axis], y[axis], z[axis]], i+3*axis);
      }
    }
    // The pose repeats each stride. The path continues through the scene.
    for (let i = 0; i < 2; i++) {
      const shift = cycles*(source[end*stride+i]-source[start*stride+i]);
      qpos[i] += shift;
      if (this.turn) {
        for (let site = i; site < this.sample.site_xpos.length; site += 3) {
          this.sample.site_xpos[site] += shift;
          this.sample.subtree_com[site] += shift;
        }
      }
    }
    for (let i = 0; i < qvel.length; i++) qvel[i] *= rate;
    for (let i = 0; i < cvel.length; i++) cvel[i] *= rate;
    return this.sample;
  }

  write(state, frame, output) {
    const { natural, target, speed, phase, config } = this;
    const { lookahead, stride, acceleration, qposIndices, qvelIndices } = config;
    const { goalOffset, liveGoalSize } = this.observation;
    const joints = goalOffset + liveGoalSize;
    const velocities = joints + lookahead*qposIndices.length;
    const positions = velocities + lookahead*qvelIndices.length;
    const siteSize = 3*(this.siteSchema.sites.length-1);
    const angles = positions + lookahead*siteSize;
    const siteSpeeds = angles + lookahead*siteSize;
    const motionPhase = siteSpeeds + lookahead*2*siteSize;
    const xy = this.turn && this.rootXY(phase);
    for (let i = 0; i < lookahead; i++) {
      const ahead = i*stride*this.dt;
      const [rate, distance] = speedPreview(speed, target, ahead, acceleration);
      const future = !this.retimed && target === natural
        ? frame + i*stride : phase + distance/(config.natural*this.dt);
      const reference = this.readReference(future, Math.fround(rate/natural));
      this.turn?.apply(reference, xy, ahead);
      if (i === 0) {
        this.writePath(state, reference, output, motionPhase+1);
        this.turn?.write(state, reference, output, motionPhase+6);
      }
      qposIndices.forEach((id, j) => { output[joints + i*qposIndices.length + j] = reference.qpos[id]; });
      qvelIndices.forEach((id, j) => { output[velocities + i*qvelIndices.length + j] = reference.qvel[id]; });
      writeSites(reference, this.siteSchema, output, positions+i*siteSize, angles+i*siteSize, siteSpeeds+i*2*siteSize);
    }
    const [start, end] = this.referenceLoop;
    const nominalFrame = frame < end ? frame : start + (frame-end)%(end-start);
    output[motionPhase] = nominalFrame/this.referenceFrames;
  }

  writePath(state, reference, output, offset) {
    const [, , , w, x, y, z] = reference.qpos;
    const yaw = Math.atan2(2*(w*z+x*y), 1-2*(y*y+z*z));
    const cosine = Math.cos(yaw), sine = Math.sin(yaw);
    const dx = state.qpos[0]-reference.qpos[0]+this.references[0];
    const dy = state.qpos[1]-reference.qpos[1]+this.references[1];
    const vx = state.qvel[0]-reference.qvel[0];
    const vy = state.qvel[1]-reference.qvel[1];
    const features = [(cosine*dx+sine*dy)/.20, (cosine*vx+sine*vy)/.25,
      (this.target-this.natural)/.07, (sine*dx-cosine*dy)/.20, (sine*vx-cosine*vy)/.25];
    features.forEach((value, i) => { output[offset+i] = Math.max(-4, Math.min(4, value)); });
  }
}

export class WalkingSimulation {
  constructor(mujoco, model, data, manifest, references, ort, actor, backend, ballSupport) {
    Object.assign(this, { mujoco, model, data, manifest, references, ort, actor, backend });
    this.observation = new Float32Array(manifest.observation.size);
    this.observationTensor = new ort.Tensor('float32', this.observation, [1, this.observation.length]);
    this.noiseOffset = manifest.referenceFrames * manifest.referenceStride;
    this.speedCommand = manifest.speedCommand ? new SpeedCommand(manifest, references) : null;
    this.ball = ballSupport ? new BallThrows(model, data, manifest, frame => this.reference(frame)) : null;
    this.reset();
  }

  static async create({ manifest, xml, physics, references, actorWeights, backend = 'wasm', vendor, progress = () => {}, ballSupport = false }) {
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
      model = mujoco.MjModel.from_xml_string(ballSupport ? addBallBody(xml) : xml, vfs);
    } finally {
      vfs.delete();
    }
    const extra = ballSupport ? { nq: 7, nv: 6, nbody: 1 } : {};
    for (const [key, value] of Object.entries(manifest.dimensions)) {
      if (model[key] !== value + (extra[key] ?? 0)) {
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
      manifest, new Float32Array(references), ort, actor, backend, ballSupport);
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
    this.ball?.reset();
    mujoco.mj_forward(model, data);
    data.qacc_warmstart.set(manifest.reset.qacc_warmstart);
    this.frame = 0;
    this.speedCommand?.reset();
    this.pushFrames = 0;
    this.start = [data.qpos[0], data.qpos[1]];
    this.done = null;
  }

  setBallThrows(enabled) {
    this.ball?.setEnabled(enabled, this.frame);
  }

  observe(state = this.data, output = this.observation) {
    const command = this.speedCommand;
    buildObservation(state, this.manifest.observation, command ? null : this.reference(), output);
    command?.write(state, this.frame, output);
    return output;
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
    this.observe();
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
    this.ball?.advance(this.frame);
    for (let i = 0; i < manifest.substeps; i++) mujoco.mj_step(model, data);
    this.inferenceMs = t1-t0;
    this.physicsMs = performance.now()-t1;
    this.frame++;
    this.speedCommand?.advance(this.frame);
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
    const turn = this.speedCommand?.turn;
    return { bones, groups, x, y, seconds, distance, done: this.done, ball: this.ball?.snapshot(x, y) ?? null,
      yaw: yawOf(data.qpos), speed: Math.hypot(data.qvel[0], data.qvel[1]),
      turnRate: turn && turn.rate*180/Math.PI };
  }
}

import { compressedBuffer, WalkingSimulation } from './simulation.js';

let simulation;
let paused = true;
let scheduled = false;
let pendingReset = false;
let pendingPush = false;
let deadline = 0;
let resumeAt = 0;
let averageMs = 0;

async function checked(name) {
  const response = await fetch(new URL(name, import.meta.url));
  if (!response.ok) throw new Error(`Could not load ${name} (HTTP ${response.status}).`);
  return response;
}

async function initialize(preferredBackend) {
  postMessage({ type: 'progress', text: 'Loading the walking policy and physics…' });
  const manifest = await checked('manifest.json').then(response => response.json());
  const loadActor = async () => {
    const weights = new Uint8Array(manifest.actorParts.reduce((sum, [, length]) => sum + length, 0));
    let offset = 0;
    await Promise.all(manifest.actorParts.map(async ([name, length]) => {
      const start = offset;
      offset += length;
      const part = new Uint8Array(await checked(name).then(compressedBuffer));
      if (part.length !== length) throw new Error(`Size mismatch in ${name}.`);
      weights.set(part, start);
    }));
    return weights;
  };
  const [xml, physics, references, actorWeights] = await Promise.all([
    checked('model.xml').then(response => response.text()),
    checked('physics.bin.gz').then(compressedBuffer),
    checked('reference.bin.gz').then(compressedBuffer),
    loadActor(),
  ]);
  const assets = { manifest, xml, physics, references, actorWeights,
    vendor: new URL('./vendor/', import.meta.url), progress: text => postMessage({ type: 'progress', text }) };
  const useGpu = preferredBackend !== 'wasm' && !!(await navigator.gpu?.requestAdapter().catch(() => null));
  if (useGpu) {
    try {
      simulation = await WalkingSimulation.create({ ...assets, backend: 'webgpu' });
      // Some providers fail on the first execution rather than session creation.
      await simulation.step();
      simulation.reset();
    } catch {
      if (simulation) {
        await simulation.actor.release();
        simulation.data.delete();
        simulation.model.delete();
        simulation = null;
      }
    }
  }
  simulation ??= await WalkingSimulation.create(assets);
  postMessage({ type: 'ready', backend: simulation.backend, steps: manifest.checkpointSteps });
  paused = false;
  deadline = performance.now();
  publish();
  schedule();
}

function publish() {
  const snapshot = simulation.snapshot();
  postMessage({ type: 'frame', ...snapshot, stepMs: averageMs },
    [snapshot.bones.buffer, snapshot.groups.buffer]);
}

function schedule(delay = 0) {
  if (scheduled || !simulation) return;
  scheduled = true;
  setTimeout(tick, delay);
}

async function tick() {
  try {
    const now = performance.now();
    if (pendingReset || (!paused && simulation.done && now >= resumeAt)) {
      simulation.reset();
      pendingReset = false;
      pendingPush = false;
      deadline = now;
      publish();
    }
    if (paused) return;
    if (simulation.done) return;
    if (pendingPush) {
      simulation.pushFrames = Math.round(.15 / simulation.manifest.dt);
      pendingPush = false;
    }
    const start = performance.now();
    await simulation.step();
    const duration = performance.now() - start;
    averageMs = averageMs ? .92*averageMs + .08*duration : duration;
    if (simulation.frame % 2 === 0 || simulation.done) publish();
    if (simulation.done) resumeAt = performance.now() + 1000;
    deadline = Math.max(deadline + 1000*simulation.manifest.dt, performance.now()-30);
  } catch (error) {
    paused = true;
    postMessage({ type: 'error', message: error.message });
  } finally {
    scheduled = false;
    if (pendingReset || !paused) {
      const next = simulation.done ? resumeAt : deadline;
      schedule(pendingReset ? 0 : Math.max(0, next-performance.now()));
    }
  }
}

self.onmessage = ({ data }) => {
  if (data.type === 'start' && !simulation) {
    initialize(data.backend).catch(error => postMessage({ type: 'error', message: error.message }));
  } else if (data.type === 'pause') {
    paused = data.paused;
    if (!paused) {
      deadline = performance.now();
      schedule();
    }
  } else if (data.type === 'reset') {
    pendingReset = true;
    schedule();
  } else if (data.type === 'push') {
    pendingPush = true;
  }
};

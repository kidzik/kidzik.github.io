import { WalkingSimulation } from './simulation.js?v=5';

let simulation;
let loading = false;
let paused = true;
let scheduled = false;
let pendingReset = false;
let pendingPush = false;
let throwsEnabled = true;
let deadline = 0;
let averageMs = 0;

async function checked(name, base = import.meta.url) {
  const response = await fetch(new URL(name, base));
  if (!response.ok) throw new Error(`Could not load ${name} (HTTP ${response.status}).`);
  return response;
}

async function initialize(preferredBackend, bundleURL) {
  const bundle = new URL(bundleURL || './', import.meta.url);
  postMessage({ type: 'progress', text: 'Preparing the download…' });
  const manifest = await checked('manifest.json?v=3', bundle).then(response => response.json());
  const names = ['model.xml', 'physics.bin.gz', 'reference.bin.gz', ...manifest.actorParts.map(([name]) => name)];
  const total = names.every(name => Number.isSafeInteger(manifest.downloadBytes?.[name]))
    ? names.reduce((sum, name) => sum + manifest.downloadBytes[name], 0) : 0;
  let downloaded = 0;
  let lastProgress = -Infinity;
  function reportDownload(force = false) {
    const now = performance.now();
    if (!force && now - lastProgress < 125) return;
    lastProgress = now;
    postMessage({ type: 'download', downloaded, total });
  }
  async function download(name, gzip = false, base) {
    const response = await checked(name, base);
    const measured = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        downloaded += chunk.byteLength;
        reportDownload();
        controller.enqueue(chunk);
      },
    }));
    return gzip ? measured.pipeThrough(new DecompressionStream('gzip')) : measured;
  }
  async function loadActor() {
    const weights = new Uint8Array(manifest.actorParts.reduce((sum, [, length]) => sum + length, 0));
    let offset = 0;
    // Stream each chunk into the final buffer. Keeping one chunk in flight limits memory on phones.
    for (const [name, length] of manifest.actorParts) {
      const reader = (await download(name, true, bundle)).getReader();
      const end = offset + length;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (offset + value.length > end) throw new Error(`Size mismatch in ${name}.`);
          weights.set(value, offset);
          offset += value.length;
        }
        if (offset !== end) throw new Error(`Size mismatch in ${name}.`);
      } finally {
        reader.releaseLock();
      }
    }
    return weights;
  }
  reportDownload(true);
  const [xml, physics, references, actorWeights] = await Promise.all([
    download('model.xml').then(stream => new Response(stream).text()),
    download('physics.bin.gz', true).then(stream => new Response(stream).arrayBuffer()),
    download('reference.bin.gz', true).then(stream => new Response(stream).arrayBuffer()),
    loadActor(),
  ]);
  reportDownload(true);
  const progress = text => postMessage({ type: 'progress', text });
  progress('Loading the simulation engine…');
  const assets = { manifest, xml, physics, references, actorWeights, ballSupport: true,
    vendor: new URL('./vendor/', import.meta.url), progress };
  const useGpu = preferredBackend !== 'wasm' && !!(await navigator.gpu?.requestAdapter().catch(() => null));
  if (useGpu) {
    try {
      simulation = await WalkingSimulation.create({ ...assets, backend: 'webgpu' });
      // Some providers fail on the first execution rather than session creation.
      await simulation.meanAction();
    } catch {
      if (simulation) {
        await simulation.actor.release();
        simulation.data.delete();
        simulation.model.delete();
        simulation = null;
      }
    }
  }
  if (!simulation) {
    simulation = await WalkingSimulation.create(assets);
    await simulation.meanAction();
  }
  simulation.setBallThrows(throwsEnabled);
  loading = false;
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
    if (pendingReset) {
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
    if (simulation.ball?.activeUntil || simulation.frame % 2 === 0 || simulation.done) publish();
    deadline = Math.max(deadline + 1000*simulation.manifest.dt, performance.now()-30);
  } catch (error) {
    paused = true;
    postMessage({ type: 'error', message: error.message });
  } finally {
    scheduled = false;
    if (pendingReset || (!paused && !simulation.done)) {
      schedule(pendingReset ? 0 : Math.max(0, deadline-performance.now()));
    }
  }
}

self.onmessage = ({ data }) => {
  if (data.type === 'start' && !simulation && !loading) {
    loading = true;
    throwsEnabled = data.throwsEnabled !== false;
    initialize(data.backend, data.bundleURL).catch(error => postMessage({ type: 'error', message: error.message }));
  } else if (data.type === 'pause') {
    paused = data.paused;
    if (!paused) {
      deadline = performance.now();
      schedule();
    }
  } else if (data.type === 'reset') {
    pendingReset = true;
    schedule();
  } else if (data.type === 'ball-throws') {
    throwsEnabled = data.enabled === true;
    if (simulation && !loading) {
      simulation.setBallThrows(throwsEnabled);
      publish();
    }
  } else if (data.type === 'push') {
    pendingPush = true;
  }
};

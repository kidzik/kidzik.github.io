import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { compressedBuffer } from './simulation.js?v=3';

const byId = id => document.getElementById(id);
const stage = byId('stage');
const status = byId('run-status');
const note = byId('status-note');
const muscleToggle = byId('muscles');
const activationToggle = byId('activation');
const touchDevice = /Android|iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.maxTouchPoints > 0 && (matchMedia('(pointer: coarse)').matches || navigator.platform === 'MacIntel'));
const views = {
  front: [0.05, -3.3, 1.4],
  side: [3.3, -.05, 1.4],
  back: [.05, 3.3, 1.4],
};

function geometryFrom(buffer, { vertices, triangles }) {
  const geometry = new THREE.BufferGeometry();
  let offset = 0;
  const positions = new Float32Array(buffer, offset, vertices * 3);
  offset += positions.byteLength;
  const joints = new Uint8Array(buffer, offset, vertices * 8);
  offset += joints.byteLength;
  const weights = new Uint8Array(buffer, offset, vertices * 8);
  offset += weights.byteLength;
  const indices = new Uint32Array(buffer, offset, triangles * 3);
  offset += indices.byteLength;
  const surfaces = new Uint16Array(buffer, offset, vertices);
  if (offset + surfaces.byteLength !== buffer.byteLength) throw new Error('Anatomy asset size mismatch.');
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('surface', new THREE.BufferAttribute(surfaces, 1));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  for (const [name, data, normalized] of [['skinIndex', joints, false], ['skinWeight', weights, true]]) {
    const interleaved = new THREE.InterleavedBuffer(data, 8);
    geometry.setAttribute(name, new THREE.InterleavedBufferAttribute(interleaved, 4, 0, normalized));
    geometry.setAttribute(name+'2', new THREE.InterleavedBufferAttribute(interleaved, 4, 4, normalized));
  }
  return geometry;
}

function anatomyMaterial(palette, count) {
  const material = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: .83 });
  material.onBeforeCompile = shader => {
    shader.uniforms.surfacePalette = { value: palette };
    shader.uniforms.surfaceCount = { value: count };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float surface;
        attribute vec4 skinIndex2;
        attribute vec4 skinWeight2;
        varying float vSurface;
      `)
      .replace('#include <skinbase_vertex>', `#include <skinbase_vertex>
        mat4 additionalSkin = mat4(0.0);
        if (skinWeight2.x > 0.0) additionalSkin += skinWeight2.x * getBoneMatrix(skinIndex2.x);
        if (skinWeight2.y > 0.0) additionalSkin += skinWeight2.y * getBoneMatrix(skinIndex2.y);
        if (skinWeight2.z > 0.0) additionalSkin += skinWeight2.z * getBoneMatrix(skinIndex2.z);
        if (skinWeight2.w > 0.0) additionalSkin += skinWeight2.w * getBoneMatrix(skinIndex2.w);
      `)
      .replace('#include <skinnormal_vertex>', `
        vec3 bindNormal = objectNormal;
        #include <skinnormal_vertex>
        objectNormal += (bindMatrixInverse * additionalSkin * bindMatrix * vec4(bindNormal, 0.0)).xyz;
      `)
      .replace('#include <skinning_vertex>', `#include <skinning_vertex>
        transformed += (bindMatrixInverse * additionalSkin * skinVertex).xyz;
        vSurface = surface;
      `);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D surfacePalette;
        uniform float surfaceCount;
        varying float vSurface;
      `)
      .replace('#include <color_fragment>', `
        vec4 surfaceColor = texture2D(surfacePalette, vec2((vSurface + .5) / surfaceCount, .5));
        if (surfaceColor.a < .5) discard;
        diffuseColor *= surfaceColor;
      `);
  };
  return material;
}

const colorStops = [
  [0, .82, .64, .61], [.35, .74, .38, .34], [.7, .80, .15, .12], [1, .60, .025, .035],
];
function activationColor(value) {
  const upper = colorStops.findIndex(stop => stop[0] >= value && stop[0] !== 0);
  const a = colorStops[upper-1], b = colorStops[upper];
  const fraction = (value-a[0])/(b[0]-a[0]);
  return [1, 2, 3].map(channel => a[channel]+fraction*(b[channel]-a[channel]));
}

async function createViewer() {
  const [anatomy, bytes] = await Promise.all([
    fetch(new URL('anatomy.json', import.meta.url)).then(response => {
      if (!response.ok) throw new Error('Anatomy description unavailable.');
      return response.json();
    }),
    fetch(new URL('anatomy.bin.gz', import.meta.url)).then(compressedBuffer),
  ]);
  const renderer = new THREE.WebGLRenderer({ antialias: !touchDevice, powerPreference: touchDevice ? 'low-power' : 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, touchDevice ? 1.35 : 1.75));
  stage.prepend(renderer.domElement);
  renderer.domElement.setAttribute('aria-label', 'Rotatable anatomical walking model');
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#171a20');
  scene.fog = new THREE.FogExp2('#171a20', .085);
  const camera = new THREE.PerspectiveCamera(37, 1, .04, 55);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.minDistance = .68;
  controls.maxDistance = 10;
  controls.enableDamping = true;
  controls.dampingFactor = .16;
  controls.maxPolarAngle = Math.PI * .88;

  function setView(position) {
    camera.position.set(...position);
    controls.target.set(0, 0, .84);
    controls.update();
  }
  setView([1.85, -3.05, 1.42]);
  for (const button of document.querySelectorAll('[data-view]')) {
    button.addEventListener('click', () => setView(views[button.dataset.view]));
  }

  scene.add(new THREE.HemisphereLight(0xf7e8d8, 0x6c7484, 1.8));
  const light = new THREE.DirectionalLight(0xffede1, 2.1);
  light.position.set(-2.4, -3.8, 4.3);
  scene.add(light);
  const rim = new THREE.DirectionalLight(0xc4d3f0, 1.3);
  rim.position.set(2.3, 2, 2.7);
  scene.add(rim);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(75, 75),
    new THREE.MeshStandardMaterial({ color: 0x262b33, roughness: 1 }));
  floor.position.z = -.017;
  scene.add(floor);
  const grid = new THREE.GridHelper(32, 64, 0x474d58, 0x474d58);
  grid.rotation.x = Math.PI/2;
  grid.position.z = -.014;
  scene.add(grid);

  const paletteBytes = new Uint8Array(anatomy.surfaces.length*4);
  const palette = new THREE.DataTexture(paletteBytes, anatomy.surfaces.length, 1);
  palette.colorSpace = THREE.SRGBColorSpace;
  palette.minFilter = palette.magFilter = THREE.NearestFilter;
  const geometry = geometryFrom(bytes, anatomy);
  const mesh = new THREE.SkinnedMesh(geometry, anatomyMaterial(palette, anatomy.surfaces.length));
  const bones = anatomy.bones.map(([x, y, z, qx, qy, qz, qw]) => {
    const bone = new THREE.Bone();
    bone.position.set(x, y, z);
    bone.quaternion.set(qx, qy, qz, qw);
    mesh.add(bone);
    return bone;
  });
  scene.add(mesh);
  mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones), new THREE.Matrix4());
  mesh.frustumCulled = false;
  byId('coverage').textContent = `${anatomy.mappedActuators} of ${anatomy.actuators}`;

  let previous;
  let current;
  let blendStart = 0;
  let blendDuration = 40;
  const previousPosition = new THREE.Vector3();
  const previousRotation = new THREE.Quaternion();
  const nextRotation = new THREE.Quaternion();
  let dirty = true;

  function updatePalette() {
    for (const [i, surface] of anatomy.surfaces.entries()) {
      let color = surface.rgba;
      if (surface.muscle && activationToggle.checked && current) {
        color = surface.activation === null ? [.43,.30,.29] : activationColor(current.groups[surface.activation]/255);
      }
      for (let k = 0; k < 3; k++) paletteBytes[4*i+k] = Math.round(color[k]*255);
      paletteBytes[4*i+3] = !surface.muscle || muscleToggle.checked ? 255 : 0;
    }
    palette.needsUpdate = true;
    dirty = true;
  }
  for (const toggle of [muscleToggle, activationToggle]) toggle.addEventListener('change', updatePalette);
  controls.addEventListener('change', () => { dirty = true; });

  function setSnapshot(frame) {
    const time = performance.now();
    previous = current && frame.seconds > current.seconds ? current : frame;
    blendDuration = Math.min(100, Math.max(20, time-blendStart));
    blendStart = time;
    current = frame;
    updatePalette();
  }

  let stageWidth = 0;
  let stageHeight = 0;
  function resize() {
    const { clientWidth: width, clientHeight: height } = stage;
    if (!width || !height || (width === stageWidth && height === stageHeight)) return;
    stageWidth = width;
    stageHeight = height;
    camera.aspect = width/height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    dirty = true;
  }
  new ResizeObserver(() => requestAnimationFrame(resize)).observe(stage);
  resize();
  updatePalette();

  function draw(time) {
    const amount = Math.min(1, (time-blendStart)/blendDuration);
    if (current && (dirty || amount < 1)) {
      const a = previous.bones, b = current.bones;
      for (const [i, bone] of bones.entries()) {
        const index = i*7;
        previousPosition.fromArray(a,index);
        bone.position.fromArray(b,index).lerp(previousPosition,1-amount);
        previousRotation.fromArray(a,index+3);
        nextRotation.fromArray(b,index+3);
        bone.quaternion.slerpQuaternions(previousRotation,nextRotation,amount);
      }
      grid.position.x = -(current.x % .5);
      grid.position.y = -(current.y % .5);
    }
    controls.update();
    if (dirty || (current && amount < 1)) {
      renderer.render(scene, camera);
      dirty = !!current && amount < 1;
    }
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
  return setSnapshot;
}

function connectFullscreen() {
  const viewer = byId('walking-viewer');
  const dialog = byId('viewer-dialog');
  const button = byId('full-screen');
  function update() {
    const expanded = document.fullscreenElement === viewer || dialog.open;
    button.textContent = expanded ? 'Exit full screen' : 'Full screen';
    button.setAttribute('aria-pressed', String(expanded));
  }
  if (!viewer.requestFullscreen && !dialog.showModal) return;
  button.hidden = false;
  update();
  document.addEventListener('fullscreenchange', update);
  dialog.addEventListener('close', () => {
    dialog.before(viewer);
    update();
    button.focus({ preventScroll: true });
  });
  button.addEventListener('click', async () => {
    if (dialog.open) {
      dialog.close();
      return;
    }
    if (document.fullscreenElement === viewer) {
      await document.exitFullscreen();
      return;
    }
    if (viewer.requestFullscreen) {
      try {
        await viewer.requestFullscreen();
        return;
      } catch {
        // Some phone browsers only allow native fullscreen for videos.
      }
    }
    if (dialog.showModal) {
      dialog.append(viewer);
      dialog.showModal();
      update();
      button.focus({ preventScroll: true });
    }
  });
}

function connect(setSnapshot) {
  const start = byId('start');
  const pause = byId('pause');
  const reset = byId('reset-walk');
  const push = byId('push');
  const controls = [pause, reset, push];
  const startNote = byId('start-note');
  const loadingPanel = byId('load-progress');
  const meter = byId('download-meter');
  const details = byId('download-details');
  const mb = bytes => (bytes / 1e6).toFixed(1);
  function phase(text) {
    status.textContent = text;
    details.textContent = text;
    meter.removeAttribute('value');
    meter.removeAttribute('aria-valuetext');
    meter.setAttribute('aria-label', 'Simulation setup');
  }
  let worker;
  let paused = false;
  let checkpoint;
  let backend;
  let lastStatus = 0;

  function fail(message) {
    status.textContent = 'Simulation unavailable';
    note.textContent = message;
    for (const button of controls) button.disabled = true;
    worker?.terminate();
    worker = undefined;
    start.disabled = false;
    start.hidden = false;
    start.textContent = 'Try again';
    loadingPanel.hidden = true;
    startNote.textContent = message;
    startNote.hidden = false;
    byId('start-panel').hidden = false;
  }

  start.addEventListener('click', () => {
    if (worker) return;
    start.disabled = true;
    start.hidden = true;
    startNote.hidden = true;
    loadingPanel.hidden = false;
    phase('Preparing the download…');
    note.textContent = '';
    try {
      worker = new Worker(new URL('physics-worker.js?v=3', import.meta.url), { type: 'module' });
    } catch (error) {
      fail(error.message);
      return;
    }
    worker.onerror = event => fail(event.message || 'The physics worker stopped unexpectedly.');
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') phase(data.text);
      if (data.type === 'download') {
        if (status.textContent !== 'Downloading the model…') status.textContent = 'Downloading the model…';
        const size = data.total ? `${mb(data.downloaded)} / ${mb(data.total)} MB`
          : `${mb(data.downloaded)} MB downloaded`;
        details.textContent = size;
        meter.setAttribute('aria-label', 'Model download progress');
        if (data.total) {
          meter.max = data.total;
          meter.value = data.downloaded;
          meter.setAttribute('aria-valuetext', size);
        }
      }
      if (data.type === 'error') fail(data.message);
      if (data.type === 'ready') {
        checkpoint = data.steps;
        backend = data.backend === 'webgpu' ? 'WebGPU' : 'WASM';
        paused = false;
        pause.textContent = 'Pause';
        status.textContent = 'Running on this device';
        loadingPanel.hidden = true;
        byId('start-panel').hidden = true;
        for (const button of controls) button.disabled = false;
      }
      if (data.type === 'frame') {
        setSnapshot(data);
        const speed = data.seconds ? data.distance/data.seconds : 0;
        byId('speed').textContent = `${speed.toFixed(2)} m/s`;
        byId('duration').textContent = `${data.seconds.toFixed(2)} s`;
        byId('distance').textContent = `${data.distance.toFixed(2)} m`;
        pause.disabled = push.disabled = !!data.done;
        const runStatus = data.done ? `${data.done} · click Reset walk`
          : paused ? 'Paused on this device' : 'Running on this device';
        if (status.textContent !== runStatus) status.textContent = runStatus;
        if (data.done || performance.now()-lastStatus > 500) {
          note.textContent = `${backend} inference · ${Number(checkpoint).toLocaleString()} training steps`
            + (data.stepMs > 0 ? ` · ${data.stepMs.toFixed(1)} ms per control update` : '');
          lastStatus = performance.now();
        }
      }
    };
    const requested = new URL(location.href).searchParams.get('backend');
    worker.postMessage({ type: 'start', backend: requested || (touchDevice ? 'wasm' : null) });
  });

  pause.addEventListener('click', () => {
    paused = !paused;
    pause.textContent = paused ? 'Resume' : 'Pause';
    status.textContent = paused ? 'Paused on this device' : 'Running on this device';
    worker?.postMessage({ type: 'pause', paused });
  });
  reset.addEventListener('click', () => worker?.postMessage({ type: 'reset' }));
  push.addEventListener('click', () => worker?.postMessage({ type: 'push' }));
}

connectFullscreen();
createViewer().then(async setSnapshot => {
  if (stage.dataset.previewPose) {
    try {
      const response = await fetch(stage.dataset.previewPose);
      if (response.ok) setSnapshot(await response.json());
    } catch {
      // The default anatomy is still available if the optional preview is missing.
    }
  }
  connect(setSnapshot);
  status.textContent = 'MS-Human-700 anatomy';
  byId('start-panel').hidden = false;
}).catch(error => {
  status.textContent = '3D preview unavailable';
  note.textContent = error.message;
});

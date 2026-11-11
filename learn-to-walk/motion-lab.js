const id = name => document.getElementById(name);
const video = id('replay-video');
const scrub = id('replay-scrub');
const canvas = id('trace-chart');
const ctx = canvas.getContext('2d');
const playButton = id('replay-play');

const signals = [
  {label: 'Sideways drift', unit: 'm', digits: 2,
    description: 'Offset from the starting line. The shaded band marks when the force was applied.'},
  {label: 'Forward speed', unit: 'm/s', digits: 2,
    description: 'Instantaneous velocity along the walking direction.'},
  {label: 'Mean muscle activation', unit: '%', digits: 1,
    description: 'Modeled activation averaged across 700 actuators. Muscle color in the replay shows local changes.'},
];
const runs = [
  {key: 'steady', label: 'No push', color: '#496664', dash: [5, 4]},
  {key: 'push', label: 'Sideways push', color: '#973e30', dash: []},
];

let condition = 'push';
let metric = 0;
let selectedTime = 0;
let duration = Number(scrub.max);
let data;
let pendingSeek = false;
let resumeWhenLoaded = false;
let loadingClip = true;
let clipRequest = 0;
let frameId;
const clipUrls = new Map();

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function dataAt(run, time) {
  const trace = data.traces[run];
  const sample = clamp(time / data.stepSeconds, 0, trace.length - 1);
  const first = Math.floor(sample);
  const next = Math.min(first + 1, trace.length - 1);
  return trace[first][metric] + (trace[next][metric] - trace[first][metric]) * (sample - first);
}

function scale(values) {
  const lo = Math.min(0, ...values);
  const hi = Math.max(...values);
  const raw = Math.max(hi - lo, .01) / 3.5;
  const power = 10 ** Math.floor(Math.log10(raw));
  const tick = ([1, 2, 2.5, 5, 10].find(step => step >= raw / power) ?? 10) * power;
  return {min: Math.floor(lo / tick) * tick, max: Math.ceil(hi / tick) * tick || tick, tick};
}

function drawChart() {
  if (!data || !ctx) return;
  const {width, height} = canvas.getBoundingClientRect();
  if (!width || !height) return;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const px = Math.round(width * dpr), py = Math.round(height * dpr);
  if (canvas.width !== px || canvas.height !== py) {
    canvas.width = px;
    canvas.height = py;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const left = 44, right = width - 14, top = 12, bottom = height - 24;
  const {min, max, tick} = scale(runs.flatMap(run => data.traces[run.key].map(row => row[metric])));
  const x = t => left + (right - left) * t / duration;
  const y = v => bottom - (bottom - top) * (v - min) / (max - min);
  const pushStart = x(data.pushStartSeconds);
  ctx.fillStyle = '#edd6ca';
  ctx.fillRect(pushStart, top, x(data.pushStartSeconds + data.pushDurationSeconds) - pushStart, bottom - top);
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  ctx.fillStyle = '#63564a';
  ctx.lineWidth = 1;
  for (let v = min; v <= max + tick / 100; v += tick) {
    ctx.strokeStyle = '#e4d9ca';
    ctx.beginPath();
    ctx.moveTo(left, y(v));
    ctx.lineTo(right, y(v));
    ctx.stroke();
    const display = Number(v.toFixed(3));
    ctx.fillText(String(display), left - 6, y(v));
  }
  ctx.textAlign = 'center';
  for (let i = 0; i <= 4; i++) {
    const t = i * duration / 4;
    ctx.fillText(i === 4 ? t.toFixed(1) + ' s' : t.toFixed(1), x(t), bottom + 14);
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(left - 2, top - 2, right - left + 4, bottom - top + 4);
  ctx.clip();
  for (const run of runs) {
    ctx.strokeStyle = run.color;
    ctx.setLineDash(run.dash);
    ctx.lineWidth = run.key === condition ? 2.4 : 1.6;
    ctx.beginPath();
    data.traces[run.key].forEach((row, i) => {
      const pointX = x(i * data.stepSeconds), pointY = y(row[metric]);
      if (i === 0) ctx.moveTo(pointX, pointY);
      else ctx.lineTo(pointX, pointY);
    });
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.strokeStyle = '#726659';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x(selectedTime), top);
  ctx.lineTo(x(selectedTime), bottom);
  ctx.stroke();
  for (const run of runs) {
    ctx.fillStyle = run.color;
    ctx.beginPath();
    ctx.arc(x(selectedTime), y(dataAt(run.key, selectedTime)), 3.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function render(time) {
  selectedTime = clamp(time, 0, duration);
  scrub.value = selectedTime;
  const stamp = selectedTime.toFixed(2) + ' s';
  id('replay-time').textContent = stamp;
  scrub.setAttribute('aria-valuetext', stamp);
  if (!data) return;
  const signal = signals[metric];
  const reading = key => dataAt(key, selectedTime).toFixed(signal.digits) + ' ' + signal.unit;
  id('steady-reading').textContent = reading('steady');
  id('push-reading').textContent = reading('push');
  id('push-flag').hidden = condition !== 'push' || selectedTime < data.pushStartSeconds
    || selectedTime >= data.pushStartSeconds + data.pushDurationSeconds;
  drawChart();
}

function seek(time) {
  render(time);
  if (!loadingClip && video.readyState >= HTMLMediaElement.HAVE_METADATA) {
    video.currentTime = selectedTime;
    pendingSeek = false;
  } else {
    pendingSeek = true;
  }
}

function reportError(message) {
  const error = id('replay-error');
  error.textContent = message;
  error.hidden = !message;
}

async function play() {
  try {
    await video.play();
    reportError('');
  } catch (error) {
    if (error.name !== 'AbortError') reportError('The replay could not play. Try scrubbing or choosing the other walk.');
  }
}

function chooseRun(next) {
  if (next === condition) return;
  resumeWhenLoaded ||= !video.paused;
  video.pause();
  condition = next;
  for (const button of document.querySelectorAll('[data-condition]')) {
    button.setAttribute('aria-pressed', String(button.dataset.condition === condition));
  }
  video.setAttribute('aria-label', runs.find(run => run.key === condition).label + ' simulation replay');
  pendingSeek = true;
  loadClip(next);
  render(selectedTime);
}

async function loadClip(key) {
  const request = ++clipRequest;
  loadingClip = true;
  playButton.disabled = true;
  if (!clipUrls.has(key)) {
    const file = key === 'push' ? 'walk-push.mp4' : 'walk-steady.mp4';
    clipUrls.set(key, fetch('./media/' + file).then(response => {
      if (!response.ok) throw Error('Video unavailable.');
      return response.blob();
    }).then(URL.createObjectURL).catch(error => {
      clipUrls.delete(key);
      throw error;
    }));
  }
  try {
    const url = await clipUrls.get(key);
    if (request === clipRequest) video.src = url;
  } catch (error) {
    if (request === clipRequest) reportError(error.message + ' The traces can still be explored with the slider.');
  }
}

function playbackFrame() {
  render(video.currentTime);
  if (video.currentTime >= duration) video.pause();
  if (!video.paused) frameId = requestAnimationFrame(playbackFrame);
}

video.addEventListener('loadedmetadata', () => {
  loadingClip = false;
  playButton.disabled = false;
  reportError('');
  if (pendingSeek) seek(selectedTime);
  if (resumeWhenLoaded) {
    resumeWhenLoaded = false;
    play();
  }
});
video.addEventListener('play', () => {
  playButton.textContent = 'Pause';
  playButton.setAttribute('aria-label', 'Pause replay');
  cancelAnimationFrame(frameId);
  frameId = requestAnimationFrame(playbackFrame);
});
video.addEventListener('pause', () => {
  playButton.textContent = 'Play';
  playButton.setAttribute('aria-label', 'Play replay');
  cancelAnimationFrame(frameId);
});
video.addEventListener('error', () => {
  playButton.disabled = true;
  reportError('Video unavailable. The traces can still be explored with the slider.');
});

playButton.addEventListener('click', () => {
  if (!video.paused) return video.pause();
  if (selectedTime >= duration - .02) seek(0);
  play();
});
scrub.addEventListener('input', () => seek(Number(scrub.value)));
id('jump-push').addEventListener('click', () => {
  chooseRun('push');
  seek((data?.pushStartSeconds ?? 1.6) + .04);
});
for (const button of document.querySelectorAll('[data-condition]')) {
  button.addEventListener('click', () => chooseRun(button.dataset.condition));
}
loadClip(condition);
for (const button of document.querySelectorAll('[data-metric]')) {
  button.addEventListener('click', () => {
    metric = Number(button.dataset.metric);
    const signal = signals[metric];
    for (const choice of document.querySelectorAll('[data-metric]')) choice.setAttribute('aria-pressed', String(choice === button));
    canvas.setAttribute('aria-label', signal.label + ' over time for both simulated walks');
    id('trace-note').textContent = signal.description;
    render(selectedTime);
  });
}

if ('ResizeObserver' in window) {
  new ResizeObserver(() => requestAnimationFrame(drawChart)).observe(canvas.parentElement);
}
canvas.addEventListener('pointerdown', event => {
  const box = canvas.getBoundingClientRect();
  if (data) seek(clamp((event.clientX - box.left - 44) / (box.width - 58), 0, 1) * duration);
});

fetch('./media/walk-traces.json').then(response => {
  if (!response.ok) throw Error('Trace data could not be loaded.');
  return response.json();
}).then(recording => {
  data = recording;
  duration = data.lastSeconds;
  scrub.max = duration;
  id('trace-meta').textContent = data.pushForceN + ' N for ' + data.pushDurationSeconds.toFixed(2) + ' s';
  render(selectedTime);
}).catch(error => {
  id('trace-meta').textContent = 'Trace unavailable';
  reportError(error.message);
});

const loopDetails = {
  sense: 'The controller reads joint motion, muscle state and foot contact, alongside a short preview of the target stride.',
  decide: 'A trained neural network turns that information into 700 muscle commands. Each command tells one modeled actuator how strongly to excite the muscle.',
  move: 'MuJoCo computes how muscles, gravity and ground contact move the body. The next decision uses the resulting state.',
};
for (const button of document.querySelectorAll('[data-loop]')) {
  button.addEventListener('click', () => {
    for (const choice of document.querySelectorAll('[data-loop]')) choice.setAttribute('aria-pressed', String(choice === button));
    id('loop-detail').textContent = loopDetails[button.dataset.loop];
  });
}

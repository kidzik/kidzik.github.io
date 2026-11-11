export const BALL_RADIUS = .12;
const FLIGHT = .70;
const THROW_DISTANCE = 2.5;
const RELEASE_HEIGHT = .26;
const TARGET_HEIGHT = .10;
const FIRST_THROW = 6;
const THROW_INTERVALS = [8, 9, 7];
// The source model uses bit 1 for its own contacts. Reserve bit 2 for the ball.
const BALL_CONTACT = 2;

// Fit to the rendered anatomy in the model's rest pose, in each body's local
// coordinates. These primitives follow the simulated bones and have no mass.
const TORSO = [
  ['pelvis', '0 .054 -.018', '1 0 0 0', '.141 .104 .123'],
  ['lumbar3', '.021 -.009 0', '.538 -.459 .538 .459', '.128 .094 .119'],
  ['thoracic9', '.063 -.033 0', '.530 -.469 .530 .469', '.165 .118 .140'],
  ['thoracic4', '.069 -.012 0', '.395 -.586 .395 .586', '.164 .109 .123'],
  ['head_neck', '.007 .032 0', '.5 -.5 .5 .5', '.060 .057 .081'],
  ['head_neck', '.023 .165 0', '.5 -.5 .5 .5', '.073 .090 .101'],
];

function addBallContacts(xml) {
  const shapes = new Map();
  function add(body, shape) {
    const geoms = shapes.get(body) ?? [];
    geoms.push(`<geom name="demo_ball_contact_${body}_${geoms.length}" ${shape}
      contype="${BALL_CONTACT}" conaffinity="0" mass="0" margin="0"/>`);
    shapes.set(body, geoms);
  }
  for (const [body, pos, quat, size] of TORSO) {
    add(body, `type="ellipsoid" pos="${pos}" quat="${quat}" size="${size}"`);
  }
  for (const [side, sign] of [['r', 1], ['l', -1]]) {
    const capsule = (part, radius, from, to) => add(`${part}_${side}`,
      `type="capsule" size="${radius}" fromto="${[...from, ...to].join(' ')}"`);
    capsule('femur', .064, [.008, -.043, .012*sign], [.002, -.293, .003*sign]);
    capsule('femur', .044, [.002, -.294, .003*sign], [0, -.382, 0]);
    capsule('tibia', .044, [-.019, -.061, .005*sign], [-.020, -.225, .009*sign]);
    capsule('tibia', .031, [-.020, -.225, .009*sign], [-.011, -.368, .003*sign]);
    capsule('calcn', .031, [.032, .006, 0], [.164, .005, .005*sign]);
    capsule('toes', .024, [.002, .008, 0], [.044, .006, .009*sign]);
    capsule('humerus', .045, [.004, -.036, 0], [.005, -.184, -.003*sign]);
    capsule('humerus', .032, [.005, -.184, -.003*sign], [.007, -.272, -.006*sign]);
    capsule('ulna', .034, [.002, -.022, .016*sign], [.001, -.151, .020*sign]);
    capsule('ulna', .024, [.001, -.151, .020*sign], [.004, -.236, .022*sign]);
    capsule('hand', .032, [.008, -.026, -.012*sign], [.010, -.083, -.019*sign]);
  }
  const extended = xml.replace(/<body name="([^"]+)"[^>]*>/g, (tag, name) => {
    const geoms = shapes.get(name);
    if (!geoms) return tag;
    shapes.delete(name);
    return `${tag}\n      ${geoms.join('\n      ')}`;
  });
  if (shapes.size) throw new Error(`Ball contact bodies missing: ${[...shapes.keys()].join(', ')}.`);
  return extended;
}

export function addBallBody(xml) {
  const close = '</worldbody>';
  const floor = '<geom name="floor"';
  if (!xml.includes(close)) throw new Error('The walking model has no world body.');
  if (!xml.includes(floor)) throw new Error('The walking model has no floor.');
  return addBallContacts(xml).replace(floor, `${floor} contype="${1 | BALL_CONTACT}"`).replace(close, `
    <body name="demo_ball" pos="0 50 .35" gravcomp="1">
      <freejoint name="demo_ball_free"/>
      <geom name="demo_ball_sphere" type="sphere" size="${BALL_RADIUS}" mass="4"
            contype="0" conaffinity="${BALL_CONTACT}" priority="1" margin="0"
            friction=".65 .005 .0001" solref=".010 .70" solimp=".94 .995 .004"/>
    </body>
  ${close}`);
}

export class BallThrows {
  constructor(model, data, manifest, reference) {
    Object.assign(this, { model, data, pelvis: manifest.pelvis, dt: manifest.dt });
    this.qpos = manifest.dimensions.nq;
    this.qvel = manifest.dimensions.nv;
    this.body = manifest.dimensions.nbody;
    const joint = model.njnt - 1;
    if (model.jnt_qposadr[joint] !== this.qpos || model.jnt_dofadr[joint] !== this.qvel
        || model.jnt_bodyid[joint] !== this.body) {
      throw new Error('The ball changed the walking model state layout.');
    }
    const offset = manifest.observation.referenceSize;
    const first = reference(0), late = reference(140);
    const dx = late[offset] - first[offset], dy = late[offset+1] - first[offset+1];
    const length = Math.hypot(dx, dy);
    if (!(length > 0)) throw new Error('The walking reference has no forward direction.');
    this.forward = [dx/length, dy/length];
    this.enabled = false;
  }

  frames(seconds) {
    return Math.round(seconds / this.dt);
  }

  park() {
    this.activeUntil = 0;
    const { data, model, body, qpos, qvel } = this;
    model.body_gravcomp[body] = 1;
    data.qpos.set([data.qpos[0]+50, data.qpos[1], .35, 1, 0, 0, 0], qpos);
    data.qvel.fill(0, qvel, qvel+6);
    data.qacc_warmstart.fill(0, qvel, qvel+6);
  }

  reset() {
    this.throwCount = 0;
    this.forwardSpeed = null;
    this.nextThrow = this.frames(FIRST_THROW);
    this.park();
  }

  setEnabled(enabled, frame) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (enabled) this.nextThrow = frame + this.frames(frame === 0 ? FIRST_THROW : 3);
    else this.park();
  }

  advance(frame) {
    if (this.activeUntil && frame >= this.activeUntil) this.park();
    if (!this.enabled) return;
    const { data, model, body, qpos, qvel, pelvis, forward, throwCount } = this;
    const [fx, fy] = forward;
    const speed = data.qvel[0]*fx + data.qvel[1]*fy;
    this.forwardSpeed ??= speed;
    this.forwardSpeed += Math.min(1, this.dt/.35) * (speed-this.forwardSpeed);
    if (frame < this.nextThrow) return;
    const side = throwCount % 2 === 0 ? 1 : -1;
    const dx = -side * fy * THROW_DISTANCE;
    const dy = side * fx * THROW_DISTANCE;
    const p = pelvis*3;
    const gravity = model.opt.gravity[2];
    model.body_gravcomp[body] = 0;
    data.qpos.set([data.xipos[p]+dx, data.xipos[p+1]+dy, data.xipos[p+2]+RELEASE_HEIGHT, 1, 0, 0, 0], qpos);
    data.qvel.set([fx*this.forwardSpeed-dx/FLIGHT, fy*this.forwardSpeed-dy/FLIGHT,
      (TARGET_HEIGHT-RELEASE_HEIGHT-.5*gravity*FLIGHT**2)/FLIGHT, 0, 0, 0], qvel);
    data.qacc_warmstart.fill(0, qvel, qvel+6);
    this.throwCount++;
    this.activeUntil = frame + this.frames(2.6);
    this.nextThrow = frame + this.frames(THROW_INTERVALS[throwCount % THROW_INTERVALS.length]);
  }

  snapshot(x, y) {
    if (!this.activeUntil) return null;
    const { data, qpos } = this;
    return { id: this.throwCount, position: [data.qpos[qpos]-x, data.qpos[qpos+1]-y, data.qpos[qpos+2]] };
  }
}

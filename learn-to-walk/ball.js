export const BALL_RADIUS = .12;
const FLIGHT = .70;
const THROW_DISTANCE = 2.5;
const RELEASE_HEIGHT = .26;
const TARGET_HEIGHT = .10;
const FIRST_THROW = 6;
const THROW_INTERVALS = [8, 9, 7];

export function addBallBody(xml) {
  const close = '</worldbody>';
  if (!xml.includes(close)) throw new Error('The walking model has no world body.');
  return xml.replace(close, `
    <body name="demo_ball" pos="0 50 .35" gravcomp="1">
      <freejoint name="demo_ball_free"/>
      <geom name="demo_ball_sphere" type="sphere" size="${BALL_RADIUS}" mass="4"
            contype="1" conaffinity="1"/>
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

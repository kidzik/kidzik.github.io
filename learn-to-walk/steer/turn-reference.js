const radians = Math.PI / 180;

export function yawOf([, , , w, x, y, z]) {
  return Math.atan2(2*(w*z+x*y), 1-2*(y*y+z*z));
}

export class TurnReference {
  constructor(config, preview) {
    this.config = config;
    this.preview = preview;
    this.reset();
  }

  reset() {
    this.target = this.rate = this.yaw = this.offsetX = this.offsetY = 0;
  }

  setTarget(degrees) {
    if (!Number.isFinite(degrees)) return;
    const { maximum } = this.config;
    this.target = Math.fround(Math.max(-maximum, Math.min(maximum, degrees))*radians);
  }

  advance(dt, [dx, dy]) {
    const [rate, angle] = this.preview(this.rate, this.target, dt, this.config.acceleration);
    const mid = this.yaw + angle/2;
    this.offsetX = Math.fround(this.offsetX + Math.cos(mid)*dx - Math.sin(mid)*dy - dx);
    this.offsetY = Math.fround(this.offsetY + Math.sin(mid)*dx + Math.cos(mid)*dy - dy);
    this.yaw = Math.fround(this.yaw + angle);
    this.rate = Math.fround(rate);
  }

  apply(reference, [xNow, yNow], ahead) {
    const [rate, angle] = this.preview(this.rate, this.target, ahead, this.config.acceleration);
    const yaw = this.yaw + angle;
    if (yaw === 0 && rate === 0 && this.offsetX === 0 && this.offsetY === 0) return;
    const { qpos, qvel, site_xpos: sites, site_xmat: matrices, subtree_com: com, cvel } = reference;
    const [x0,y0,,w,x,y,z] = qpos;
    const dx = x0-xNow, dy = y0-yNow;
    const mid = this.yaw + angle/2;
    const targetX = xNow + this.offsetX + Math.cos(mid)*dx - Math.sin(mid)*dy;
    const targetY = yNow + this.offsetY + Math.sin(mid)*dx + Math.cos(mid)*dy;
    const cosine = Math.cos(yaw), sine = Math.sin(yaw);
    const c = Math.cos(yaw/2), s = Math.sin(yaw/2);
    qpos.set([targetX, targetY], 0);
    qpos.set([c*w-s*z, c*x-s*y, c*y+s*x, c*z+s*w], 3);
    qvel.set([cosine*qvel[0]-sine*qvel[1], sine*qvel[0]+cosine*qvel[1]], 0);
    // The free joint stores angular velocity in the root's local frame.
    qvel[3] += rate*2*(x*z-w*y);
    qvel[4] += rate*2*(y*z+w*x);
    qvel[5] += rate*(1-2*(x*x+y*y));
    for (let i=0; i<sites.length/3; i++) {
      const p = i*3, m = i*9, v = i*6;
      const px = sites[p]-x0, py = sites[p+1]-y0;
      const cx = com[p]-x0, cy = com[p+1]-y0;
      const rx = cosine*cx-sine*cy, ry = sine*cx+cosine*cy;
      sites.set([targetX+cosine*px-sine*py, targetY+sine*px+cosine*py], p);
      com.set([targetX+rx, targetY+ry], p);
      for (let column=0; column<3; column++) {
        const a = matrices[m+column], b = matrices[m+3+column];
        matrices[m+column] = cosine*a-sine*b;
        matrices[m+3+column] = sine*a+cosine*b;
      }
      const [wx,wy,wz,vx,vy] = cvel.subarray(v,v+5);
      cvel.set([cosine*wx-sine*wy, sine*wx+cosine*wy, wz+rate,
        cosine*vx-sine*vy-rate*ry, sine*vx+cosine*vy+rate*rx], v);
    }
  }

  write(state, reference, output, offset) {
    const error = yawOf(state.qpos)-yawOf(reference.qpos);
    output[offset] = Math.max(-4, Math.min(4, this.target/.20));
    output[offset+1] = Math.max(-4, Math.min(4, Math.atan2(Math.sin(error),Math.cos(error))/.25));
  }
}

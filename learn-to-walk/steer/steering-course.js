import * as THREE from 'three';

const gates = [
  [3.9, 0], [7, -.31], [10.2, -.84], [13.6, -.53], [17, .09], [20.4, .25],
];
const gateHalfWidth = .74;
const green = 0x8af8ce;
const amber = 0xfbd18c;
const quiet = 0x3c6768;

export function steeringCourse(scene) {
  const world = new THREE.Group();
  scene.add(world);
  const frame = new THREE.Group();
  world.add(frame);
  scene.background.set(0x101b23);
  scene.fog = new THREE.FogExp2(0x101b23, .038);
  const surface = new THREE.Mesh(new THREE.PlaneGeometry(100, 100),
    new THREE.MeshStandardMaterial({ color: 0x192c32, roughness: 1 }));
  surface.position.z = -.035;
  frame.add(surface);
  const lane = new THREE.Mesh(new THREE.PlaneGeometry(30, 4.4),
    new THREE.MeshStandardMaterial({ color: 0x3b494a, roughness: 1 }));
  lane.position.set(10, 0, -.025);
  frame.add(lane);

  function flat(width, height, x, y, color, z = -.017) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ color }));
    mesh.position.set(x, y, z);
    frame.add(mesh);
    return mesh;
  }

  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(
    [[-.8, 0], ...gates, [22.5, .25]].map(([x, y]) => new THREE.Vector3(x, y, -.012))),
  new THREE.LineDashedMaterial({ color: 0x83a99d, dashSize: .18, gapSize: .18 }));
  line.computeLineDistances();
  frame.add(line);
  for (const side of [-1, 1]) {
    flat(30, .032, 10, side*2.14, 0x7e9591);
    flat(30, .014, 10, side*2.24, 0x506c6c);
    for (let i = -2; i <= 24; i++) flat(.025, .18, i, side*2.04, 0x748c87);
  }
  for (const x of [0, gates.at(-1)[0]]) {
    for (let i=0; i<12; i++) {
      flat(.13, .18, x-.065, (i-5.5)*.18, i%2 ? 0xcadbd4 : 0x293d3e);
      flat(.13, .18, x+.065, (i-5.5)*.18, i%2 ? 0x293d3e : 0xcadbd4);
    }
  }

  const posts = new THREE.CylinderGeometry(.055, .075, .68, 12);
  const bases = new THREE.CylinderGeometry(.105, .13, .046, 14);
  const lamps = new THREE.SphereGeometry(.082, 14, 10);
  const markers = gates.map(([x,y]) => {
    const material = new THREE.MeshStandardMaterial({ color: quiet, emissive: quiet, emissiveIntensity: .22, roughness: .4 });
    for (const side of [-1, 1]) {
      for (const [geo,z] of [[bases,.018],[posts,.36],[lamps,.73]]) {
        const item = new THREE.Mesh(geo, material);
        item.rotation.x = Math.PI/2;
        item.position.set(x, y+side*gateHalfWidth, z);
        frame.add(item);
      }
    }
    const beam = flat(.06, 2*gateHalfWidth, x, y, quiet);
    return { material, beam };
  });

  let initial, previous, heading = 0, next = 0;
  let outcomes = [];

  function setHeading(value) {
    heading = value;
    frame.rotation.z = value;
  }

  function local(snapshot) {
    const x = snapshot.x-initial.x, y = snapshot.y-initial.y;
    return [x*Math.cos(heading)+y*Math.sin(heading), -x*Math.sin(heading)+y*Math.cos(heading)];
  }

  function updateMarkers() {
    markers.forEach(({ material, beam }, i) => {
      const color = i === next ? amber : i >= next ? quiet : outcomes[i] ? green : 0x9a635a;
      material.color.setHex(color);
      material.emissive.setHex(color);
      beam.material.color.setHex(color);
    });
  }
  updateMarkers();

  function update(snapshot) {
    if (!initial || snapshot.seconds === 0) {
      initial = snapshot;
      previous = [0, 0];
      next = 0;
      outcomes = [];
      frame.position.set(initial.x, initial.y, 0);
      updateMarkers();
    }
    const [x, y] = local(snapshot);
    let crossed = false;
    while (next < gates.length && x >= gates[next][0] && x > previous[0]) {
      const [gateX, gateY] = gates[next];
      const ratio = (gateX-previous[0])/(x-previous[0]);
      const crossing = previous[1]+ratio*(y-previous[1]);
      outcomes.push(Math.abs(crossing-gateY) <= gateHalfWidth);
      next++;
      crossed = true;
    }
    previous = [x, y];
    if (crossed) updateMarkers();
    return { x, y, next, total: gates.length, score: outcomes.filter(Boolean).length,
      finished: next === gates.length };
  }

  return { setHeading, update, pan: (x,y) => world.position.set(-x, -y, 0) };
}

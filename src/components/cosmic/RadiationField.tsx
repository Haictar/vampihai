import { useEffect, useRef } from "react";
import * as THREE from "three";

interface RadiationFieldProps {
  active: boolean;
}

const LOBES = [
  { angle: -2.7, spread: 0.24, reach: 1.34 },
  { angle: -1.95, spread: 0.58, reach: 0.82 },
  { angle: -1.08, spread: 0.28, reach: 1.52 },
  { angle: -0.28, spread: 0.62, reach: 1.02 },
  { angle: 0.52, spread: 0.32, reach: 1.62 },
  { angle: 1.4, spread: 0.5, reach: 0.92 },
  { angle: 2.18, spread: 0.26, reach: 1.38 },
  { angle: 2.9, spread: 0.44, reach: 1.06 },
];

const PALETTE = [0x6e8bff, 0xa24dff, 0xff4dd8, 0x8aa8ff];

type Electron = {
  mesh: THREE.Mesh;
  radius: number;
  speed: number;
  phase: number;
  tilt: THREE.Euler;
};

function randomDirection(): THREE.Vector3 {
  const direction = new THREE.Vector3(
    Math.random() * 2 - 1,
    Math.random() * 2 - 1,
    Math.random() * 2 - 1,
  );
  return direction.normalize();
}

function createParticleCloud(
  count: number,
  size: number,
  color: number,
  innerRadius: number,
  outerRadius: number,
) {
  const positions = new Float32Array(count * 3);
  for (let index = 0; index < count; index += 1) {
    const lobe = LOBES[index % LOBES.length]!;
    const clustered = index % 5 !== 0;
    const angle = clustered
      ? lobe.angle + (Math.random() - 0.5) * lobe.spread
      : Math.random() * Math.PI * 2;
    const elevation = Math.acos(Math.random() * 2 - 1);
    const radius = innerRadius + Math.random() * (outerRadius - innerRadius);
    const offset = index * 3;
    positions[offset] = Math.sin(elevation) * Math.cos(angle) * radius;
    positions[offset + 1] = Math.sin(elevation) * Math.sin(angle) * radius;
    positions[offset + 2] = Math.cos(elevation) * radius * (0.72 + Math.random() * 0.52);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color,
    size,
    transparent: true,
    opacity: 0.52,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  return new THREE.Points(geometry, material);
}

function createBeams() {
  const positions: number[] = [];
  for (let index = 0; index < 30; index += 1) {
    const direction = randomDirection();
    const lobe = LOBES[index % LOBES.length]!;
    const length = lobe.reach + Math.random() * 0.52;
    const start = 0.48 + Math.random() * 0.2;
    const end = length + (Math.random() - 0.5) * 0.12;
    positions.push(
      direction.x * start,
      direction.y * start,
      direction.z * start,
      direction.x * end,
      direction.y * end,
      direction.z * end,
    );
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({
    color: 0xffb2ef,
    transparent: true,
    opacity: 0.4,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  return new THREE.LineSegments(geometry, material);
}

function createStrand(index: number) {
  const lobe = LOBES[index % LOBES.length]!;
  const points: THREE.Vector3[] = [];
  const baseAngle = lobe.angle + (Math.random() - 0.5) * lobe.spread;
  const direction = index % 2 === 0 ? 1 : -1;

  for (let point = 0; point <= 72; point += 1) {
    const progress = point / 72;
    const radius = 0.72 + progress * (lobe.reach - 0.72) + Math.sin(progress * 15 + index) * 0.05;
    const angle =
      baseAngle +
      direction * progress * (0.8 + (index % 3) * 0.2) +
      Math.sin(progress * 11 + index * 1.7) * 0.12;
    const z = Math.sin(progress * 8 + index * 0.9) * (0.12 + progress * 0.3);
    points.push(new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, z));
  }

  const curve = new THREE.CatmullRomCurve3(points);
  const geometry = new THREE.TubeGeometry(curve, 72, index % 3 === 0 ? 0.014 : 0.008, 5, false);
  const material = new THREE.MeshBasicMaterial({
    color: PALETTE[index % PALETTE.length],
    transparent: true,
    opacity: 0.4,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  return new THREE.Mesh(geometry, material);
}

function createRing(index: number) {
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.02 + (index % 3) * 0.16, index % 2 === 0 ? 0.012 : 0.007, 8, 180),
    new THREE.MeshBasicMaterial({
      color: PALETTE[index % PALETTE.length],
      transparent: true,
      opacity: index % 2 === 0 ? 0.42 : 0.24,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  ring.rotation.set(
    0.5 + index * 0.43,
    0.25 + index * 0.32,
    index * 0.64,
  );
  return ring;
}

function createElectrons(): Electron[] {
  return Array.from({ length: 7 }, (_, index) => ({
    mesh: new THREE.Mesh(
      new THREE.SphereGeometry(index % 2 === 0 ? 0.038 : 0.028, 8, 8),
      new THREE.MeshBasicMaterial({
        color: index % 3 === 0 ? 0xfff1fd : 0xff9de8,
        transparent: true,
        opacity: 0.88,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    ),
    radius: 0.78 + (index % 4) * 0.16,
    speed: 0.48 + (index % 5) * 0.13,
    phase: index * 1.73,
    tilt: new THREE.Euler(
      0.35 + index * 0.29,
      0.2 + index * 0.41,
      index * 0.52,
    ),
  }));
}

export function RadiationField({ active }: RadiationFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = canvas?.parentElement;
    if (!canvas || !stage) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    } catch {
      return;
    }

    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 20);
    camera.position.set(0, 0, 4.2);

    const orbitalGroup = new THREE.Group();
    scene.add(orbitalGroup);

    const rings = [0, 1, 2, 3].map((index) => createRing(index));
    const ringBaseRotations = rings.map((ring) => ring.rotation.clone());
    rings.forEach((ring) => orbitalGroup.add(ring));

    const strands = Array.from({ length: 14 }, (_, index) => createStrand(index));
    strands.forEach((strand) => orbitalGroup.add(strand));

    const beams = createBeams();
    orbitalGroup.add(beams);

    const electrons = createElectrons();
    electrons.forEach((electron) => orbitalGroup.add(electron.mesh));

    const particles = [
      createParticleCloud(1100, 0.028, 0xff4dd8, 1.08, 1.62),
      createParticleCloud(720, 0.018, 0x6e8bff, 1.2, 1.86),
      createParticleCloud(360, 0.042, 0xffc2f1, 0.95, 1.42),
    ];
    particles.forEach((cloud) => orbitalGroup.add(cloud));

    const resize = () => {
      const bounds = stage.getBoundingClientRect();
      renderer.setSize(Math.max(1, bounds.width), Math.max(1, bounds.height), false);
      camera.aspect = Math.max(1, bounds.width) / Math.max(1, bounds.height);
      camera.updateProjectionMatrix();
    };

    let reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handleMotionPreference = (event: MediaQueryListEvent) => {
      reducedMotion = event.matches;
    };
    motionQuery.addEventListener("change", handleMotionPreference);

    let animationFrame = 0;
    const render = (now: number) => {
      const time = now * 0.001;
      const animationTime = reducedMotion ? 0 : time;
      const disturbed = activeRef.current ? 1 : 0;
      const energy = activeRef.current ? 1.16 : 1;
      const orbitSpeed = reducedMotion ? 0 : activeRef.current ? 2.8 : 1;
      orbitalGroup.scale.setScalar(energy + disturbed * Math.sin(animationTime * 5.2) * 0.025);
      if (!reducedMotion) {
        orbitalGroup.rotation.y = time * (0.12 + disturbed * 0.2);
        orbitalGroup.rotation.x = Math.sin(time * (0.18 + disturbed * 1.1)) * (0.12 + disturbed * 0.12);
        orbitalGroup.rotation.z = time * (0.045 + disturbed * 0.08);
        rings.forEach((ring, index) => {
          const base = ringBaseRotations[index]!;
          ring.rotation.x = base.x + time * (0.03 + index * 0.009) * orbitSpeed + Math.sin(time * 3.2 + index) * disturbed * 0.14;
          ring.rotation.y = base.y - time * (0.04 + index * 0.011) * orbitSpeed + Math.cos(time * 2.7 + index) * disturbed * 0.12;
          ring.rotation.z = base.z + Math.sin(time * 4.1 + index * 0.8) * disturbed * 0.18;
          ring.scale.setScalar(1 + Math.sin(time * 4.6 + index) * disturbed * 0.035);
        });
        strands.forEach((strand, index) => {
          strand.rotation.x = Math.sin(time * (1.4 + index * 0.06) + index) * disturbed * 0.16;
          strand.rotation.y = Math.cos(time * (1.1 + index * 0.04) + index) * disturbed * 0.14;
          strand.scale.setScalar(1 + Math.sin(time * 3.8 + index) * disturbed * 0.06);
        });
        beams.rotation.x = Math.sin(time * 3.7) * disturbed * 0.16;
        beams.rotation.y = Math.cos(time * 2.9) * disturbed * 0.2;
        particles[0]!.rotation.y = -time * (0.08 + disturbed * 0.3);
        particles[1]!.rotation.x = time * (0.06 + disturbed * 0.22);
        particles[2]!.rotation.z = -time * (0.1 + disturbed * 0.38);
      }

      electrons.forEach((electron, index) => {
        const angle = electron.phase + animationTime * electron.speed * orbitSpeed;
        const jitter = disturbed * Math.sin(animationTime * (5.2 + index * 0.3) + electron.phase) * 0.12;
        const position = new THREE.Vector3(
          Math.cos(angle + jitter) * electron.radius,
          Math.sin(angle + jitter) * electron.radius,
          Math.sin(angle * 1.7 + index) * 0.06,
        );
        position.applyEuler(electron.tilt);
        electron.mesh.position.copy(position);
        electron.mesh.scale.setScalar(1 + disturbed * (0.25 + Math.sin(animationTime * 6 + index) * 0.12));
      });

      (beams.material as THREE.LineBasicMaterial).opacity = 0.3 + Math.sin(animationTime * 2.1) * 0.08 + (energy - 1) * 0.45;
      if (!document.hidden) renderer.render(scene, camera);
      animationFrame = requestAnimationFrame(render);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(stage);
    animationFrame = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
      motionQuery.removeEventListener("change", handleMotionPreference);
      rings.forEach((ring) => {
        ring.geometry.dispose();
        (ring.material as THREE.Material).dispose();
      });
      strands.forEach((strand) => {
        strand.geometry.dispose();
        (strand.material as THREE.Material).dispose();
      });
      beams.geometry.dispose();
      beams.material.dispose();
      particles.forEach((cloud) => {
        cloud.geometry.dispose();
        (cloud.material as THREE.Material).dispose();
      });
      electrons.forEach((electron) => {
        electron.mesh.geometry.dispose();
        (electron.mesh.material as THREE.Material).dispose();
      });
      renderer.dispose();
    };
  }, []);

  return <canvas ref={canvasRef} className="radiation-field" aria-hidden="true" />;
}

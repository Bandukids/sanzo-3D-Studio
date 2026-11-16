// 首页主视觉：实时渲染的玻璃丝带（呼应 SANZO Music 的蓝橙流体），带网格线框、星尘与辉光。
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

class KnotCurve extends THREE.Curve {
  constructor(p, q, R, r, squash = 1) { super(); Object.assign(this, { p, q, R, r, squash }); }
  getPoint(t, target = new THREE.Vector3()) {
    const a = t * Math.PI * 2;
    const k = this.R + this.r * Math.cos(this.q * a);
    return target.set(k * Math.cos(this.p * a), k * Math.sin(this.p * a) * this.squash, this.r * Math.sin(this.q * a) * 1.25);
  }
}

/** 沿曲线生成扁平椭圆截面的带状几何体 */
function ribbonGeometry(curve, seg, radial, width, thick, turns = 1) {
  const frames = curve.computeFrenetFrames(seg, true);
  const pos = new Float32Array((seg + 1) * (radial + 1) * 3);
  const idx = [];
  const P = new THREE.Vector3();
  let k = 0;
  for (let i = 0; i <= seg; i++) {
    curve.getPointAt(i / seg, P);
    const N = frames.normals[i], B = frames.binormals[i];
    const tw = (i / seg) * Math.PI * 2 * turns;
    const c = Math.cos(tw), s = Math.sin(tw);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const ex = Math.cos(a) * width, ey = Math.sin(a) * thick;
      const x = ex * c - ey * s, y = ex * s + ey * c;
      pos[k++] = P.x + N.x * x + B.x * y;
      pos[k++] = P.y + N.y * x + B.y * y;
      pos[k++] = P.z + N.z * x + B.z * y;
    }
  }
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j, b = a + radial + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export function initHero(canvas, host) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050a12);
  scene.fog = new THREE.FogExp2(0x050a12, 0.035);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.set(0, 0, 9);

  const group = new THREE.Group();
  scene.add(group);

  const glass = (color, attenuation, emissive) => new THREE.MeshPhysicalMaterial({
    color, roughness: 0.06, metalness: 0, transmission: 1, thickness: 1.4, ior: 1.42,
    attenuationColor: attenuation, attenuationDistance: 3.2,
    clearcoat: 1, clearcoatRoughness: 0.05, iridescence: 0.9, iridescenceIOR: 1.6,
    emissive, emissiveIntensity: 0.22, side: THREE.DoubleSide,
  });

  const blueCurve = new KnotCurve(2, 3, 1.9, 0.75, 0.92);
  const orangeCurve = new KnotCurve(3, 2, 1.55, 0.95, 1.05);
  const blue = new THREE.Mesh(ribbonGeometry(blueCurve, 520, 20, 0.44, 0.045, 2), glass(0x9cc4ff, 0x2d6fe0, 0x1b4fb8));
  const orange = new THREE.Mesh(ribbonGeometry(orangeCurve, 520, 20, 0.34, 0.04, 1), new THREE.MeshPhysicalMaterial({
    // 琥珀色半透明层：用普通透明混合，这样能透出后面的蓝色玻璃
    color: 0xff9a5c, transparent: true, opacity: 0.5, depthWrite: false, roughness: 0.1, metalness: 0.15,
    clearcoat: 1, clearcoatRoughness: 0.04, iridescence: 1, iridescenceIOR: 1.7,
    emissive: 0xff6a1e, emissiveIntensity: 0.4, side: THREE.DoubleSide,
  }));
  orange.rotation.set(0.9, 0.4, 0.2);
  group.add(blue, orange);

  // 线框“拓扑”幽灵层 —— 点题 3D 网格
  const wire = new THREE.LineSegments(
    new THREE.WireframeGeometry(ribbonGeometry(blueCurve, 150, 6, 0.5, 0.07, 2)),
    new THREE.LineBasicMaterial({ color: 0x86b6ff, transparent: true, opacity: 0.11, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  wire.scale.setScalar(1.035);
  group.add(wire);

  const lightA = new THREE.PointLight(0xff9f66, 60, 30);
  const lightB = new THREE.PointLight(0x5d9bff, 70, 30);
  const lightC = new THREE.PointLight(0xffffff, 16, 30);
  lightC.position.set(0, 4, 6);
  scene.add(lightA, lightB, lightC);

  // 星尘
  const COUNT = 900;
  const sp = new Float32Array(COUNT * 3);
  const sc = new Float32Array(COUNT * 3);
  const warm = new THREE.Color(0xffb98a), cool = new THREE.Color(0xa9caff);
  for (let i = 0; i < COUNT; i++) {
    sp[i * 3] = (Math.random() - 0.5) * 26;
    sp[i * 3 + 1] = (Math.random() - 0.5) * 15;
    sp[i * 3 + 2] = (Math.random() - 0.5) * 16 - 2;
    const col = Math.random() < 0.3 ? warm : cool;
    const b = 0.35 + Math.random() * 0.65;
    sc[i * 3] = col.r * b; sc[i * 3 + 1] = col.g * b; sc[i * 3 + 2] = col.b * b;
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  starGeo.setAttribute('color', new THREE.BufferAttribute(sc, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
    size: 0.075, map: dotTexture(), vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  scene.add(stars);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.85, 0.72);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  let baseX = 0;
  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const wide = w / h > 1.05;
    baseX = wide ? Math.min(2.6, 1.1 + (w / h - 1) * 1.5) : 0;
    group.scale.setScalar(wide ? 1 : 0.8);
    group.position.y = wide ? 0.1 : 1.2;
  }
  new ResizeObserver(resize).observe(host);
  resize();

  const mouse = new THREE.Vector2(), eased = new THREE.Vector2();
  addEventListener('pointermove', (e) => {
    mouse.set((e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1);
  }, { passive: true });

  let visible = true, raf = 0;
  const clock = new THREE.Clock();
  let t = 0;
  function frame() {
    raf = 0;
    if (!visible || document.hidden) return;
    const dt = Math.min(clock.getDelta(), 0.05);
    t += dt * (reduced ? 0.15 : 1);
    eased.lerp(mouse, 0.04);
    const scroll = Math.min(1, scrollY / Math.max(1, host.clientHeight));

    group.rotation.y = t * 0.16 + eased.x * 0.35;
    group.rotation.x = Math.sin(t * 0.21) * 0.22 + eased.y * 0.22;
    group.rotation.z = Math.sin(t * 0.13) * 0.12;
    group.position.x = baseX - eased.x * 0.15;
    orange.rotation.z = 0.2 + t * 0.22;
    orange.rotation.x = 0.9 + Math.sin(t * 0.3) * 0.25;
    wire.material.opacity = 0.03 + (Math.sin(t * 0.8) * 0.5 + 0.5) * 0.07;

    lightA.position.set(baseX + Math.cos(t * 0.6) * 4.2, Math.sin(t * 0.8) * 2.4, 3 + Math.sin(t * 0.6) * 2.5);
    lightB.position.set(baseX + Math.cos(t * 0.45 + 3) * 4.6, Math.sin(t * 0.55 + 2) * 2.8, 2 + Math.sin(t * 0.45 + 3) * 3);

    stars.rotation.y = t * 0.012 + eased.x * 0.04;
    stars.rotation.x = eased.y * 0.03;
    camera.position.z = 9 + scroll * 2.5;
    camera.position.y = -scroll * 1.2;
    camera.lookAt(0, -scroll * 0.6, 0);

    composer.render();
    raf = requestAnimationFrame(frame);
  }
  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible && !document.hidden && !raf) { clock.getDelta(); raf = requestAnimationFrame(frame); }
  }).observe(host);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && visible && !raf) { clock.getDelta(); raf = requestAnimationFrame(frame); }
  });
  raf = requestAnimationFrame(frame);
}

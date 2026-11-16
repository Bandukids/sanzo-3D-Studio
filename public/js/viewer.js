// 创作台的 3D 预览器：待命 / 生成中（粒子全息）/ 模型展示 三种状态。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const HOME = new THREE.Vector3(2.2, 1.1, 3.2);
function disposeObject(root) {
  root.traverse(o => {
    o.geometry?.dispose();
    for (const m of [].concat(o.material || [])) {
      for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
      m.dispose();
    }
  });
}

export class Viewer {
  constructor(el) {
    this.el = el;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    el.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    this.camera = new THREE.PerspectiveCamera(36, 1, 0.05, 200);
    this.camera.position.copy(HOME);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.07, autoRotate: true, autoRotateSpeed: 1.4, minDistance: 1.2, maxDistance: 14 });

    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(3, 5, 4);
    const rimA = new THREE.PointLight(0xff9f66, 14, 20); rimA.position.set(-3.5, 1.5, -2.5);
    const rimB = new THREE.PointLight(0x5d9bff, 16, 20); rimB.position.set(3.5, 0.5, -3);
    // FBX 多为 Phong 材质，不吃环境贴图，补一盏半球光
    this.scene.add(key, rimA, rimB, new THREE.HemisphereLight(0xdfe9ff, 0x1a2233, 0.9));
    this.mixer = null;
    this.actions = [];
    this.current = null;
    this.bones = null;
    this.showBones = false;

    this.grid = new THREE.PolarGridHelper(3, 12, 6, 96, 0x86b6ff, 0x3a5f9c);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.2;
    this.grid.material.depthWrite = false;
    this.grid.position.y = -1.15;
    this.scene.add(this.grid);

    this.idle = this.#buildIdle();
    this.holo = this.#buildHolo();
    this.holo.visible = false;
    this.scene.add(this.idle, this.holo);

    this.model = null;
    this.wireframe = false;
    this.reveal = 1;
    this.clock = new THREE.Clock();
    this.visible = true;
    this.loadVersion = 0;
    this.controls.autoRotate = !matchMedia('(prefers-reduced-motion: reduce)').matches;

    new ResizeObserver(() => this.#resize()).observe(el);
    this.#resize();
    new IntersectionObserver(([e]) => {
      this.visible = e.isIntersecting;
      if (this.visible && !document.hidden && !this.raf) { this.clock.getDelta(); this.raf = requestAnimationFrame(this.#frame); }
    }).observe(el);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.visible && !this.raf) { this.clock.getDelta(); this.raf = requestAnimationFrame(this.#frame); }
    });
    this.raf = requestAnimationFrame(this.#frame);
  }

  #buildIdle() {
    const g = new THREE.Group();
    const outer = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1, 1)),
      new THREE.LineBasicMaterial({ color: 0x86b6ff, transparent: true, opacity: 0.4 }),
    );
    const inner = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.42, 0),
      new THREE.MeshPhysicalMaterial({ color: 0xffb98a, roughness: 0.15, metalness: 0.2, iridescence: 1, clearcoat: 1, emissive: 0xff7a2e, emissiveIntensity: 0.25, flatShading: true }),
    );
    g.add(outer, inner);
    g.userData = { outer, inner };
    return g;
  }

  #buildHolo() {
    const g = new THREE.Group();
    const geo = new THREE.IcosahedronGeometry(1, 22);
    this.holoUniforms = { uTime: { value: 0 }, uScan: { value: 0 }, uPx: { value: this.renderer.getPixelRatio() } };
    const points = new THREE.Points(geo, new THREE.ShaderMaterial({
      uniforms: this.holoUniforms,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        uniform float uTime, uScan, uPx;
        varying float vGlow;
        void main() {
          vec3 n = normalize(position);
          float w = sin(n.x * 4.0 + uTime * 1.3) * sin(n.y * 5.0 - uTime * 1.1) * sin(n.z * 4.5 + uTime * 0.9);
          float w2 = sin(n.y * 11.0 + uTime * 2.0) * 0.5;
          vec3 p = n * (0.92 + w * 0.2 + w2 * 0.04);
          vGlow = smoothstep(0.24, 0.0, abs(p.y - uScan));
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = (1.6 + vGlow * 4.5) * uPx * (5.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        varying float vGlow;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          vec3 c = mix(vec3(0.42, 0.66, 1.0), vec3(1.0, 0.62, 0.38), vGlow);
          gl_FragColor = vec4(c, (0.35 + vGlow * 0.65) * smoothstep(0.5, 0.1, d));
        }`,
    }));
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.35, 0.006, 8, 128),
      new THREE.MeshBasicMaterial({ color: 0xff9f66, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending }),
    );
    ring.rotation.x = Math.PI / 2;
    g.add(points, ring);
    g.userData = { points, ring };
    return g;
  }

  #resize() {
    const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // 竖长画布时放大纵向视角，保证模型横向不被裁切
    const half = Math.tan(THREE.MathUtils.degToRad(18)) * Math.max(1, 1.25 / (w / h));
    this.camera.fov = THREE.MathUtils.radToDeg(Math.atan(half)) * 2;
    this.camera.updateProjectionMatrix();
  }

  #frame = () => {
    this.raf = 0;
    if (!this.visible || document.hidden) return;
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;
    if (this.idle.visible) {
      this.idle.userData.outer.rotation.set(t * 0.12, t * 0.18, 0);
      this.idle.userData.inner.rotation.set(-t * 0.4, t * 0.55, 0);
      this.idle.userData.inner.position.y = Math.sin(t * 1.2) * 0.06;
    }
    if (this.holo.visible) {
      const scan = Math.sin(t * 1.1) * 1.15;
      this.holoUniforms.uTime.value = t;
      this.holoUniforms.uScan.value = scan;
      this.holo.userData.ring.position.y = scan;
      this.holo.userData.ring.scale.setScalar(Math.max(0.15, Math.sqrt(Math.max(0, 1 - (scan / 1.25) ** 2))));
      this.holo.userData.points.rotation.y = t * 0.25;
    }
    if (this.model && this.reveal < 1) {
      this.reveal = Math.min(1, this.reveal + dt * 1.1);
      const e = 1 - Math.pow(1 - this.reveal, 4);
      this.model.scale.setScalar(this.model.userData.fit * (0.55 + 0.45 * e));
      this.model.rotation.y = (1 - e) * -2.2;
    }
    this.mixer?.update(dt);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.raf = requestAnimationFrame(this.#frame);
  };

  #clearModel() {
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.actions = [];
    this.current = null;
    if (this.bones) { this.scene.remove(this.bones); this.bones.dispose(); this.bones = null; }
    if (!this.model) return;
    this.scene.remove(this.model);
    disposeObject(this.model);
    this.model = null;
  }

  #present(root, clips = []) {
    let hasSkeleton = false, tris = 0;
    root.traverse((o) => {
      if (o.isBone) hasSkeleton = true;
      if (o.isSkinnedMesh) o.frustumCulled = false; // 动画会把网格带出静态包围盒
      if (o.isMesh) tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
    });
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const fit = 2.2 / Math.max(size.x, size.y, size.z, 1e-6);
    const holder = new THREE.Group();
    root.position.sub(center);
    holder.add(root);
    holder.userData.fit = fit;
    holder.scale.setScalar(fit * 0.55);
    this.grid.position.y = -(size.y * fit) / 2 - 0.02;
    this.model = holder;
    this.reveal = 0;
    this.scene.add(holder);
    this.idle.visible = false;
    this.holo.visible = false;
    this.setWireframe(this.wireframe);
    this.resetView();
    if (hasSkeleton) {
      this.bones = new THREE.SkeletonHelper(root);
      Object.assign(this.bones.material, { depthTest: false, transparent: true, opacity: 0.95 });
      this.bones.renderOrder = 10;
      this.bones.visible = this.showBones;
      this.scene.add(this.bones);
    }
    clips = clips.filter((c) => c.tracks.length && c.duration > 0);
    if (clips.length) {
      this.mixer = new THREE.AnimationMixer(root);
      this.actions = clips.map((c) => this.mixer.clipAction(c));
      this.playClip(0);
    }
    return {
      triangles: Math.round(tris), hasSkeleton,
      clips: clips.map((c, i) => ({ name: c.name || `动画 ${i + 1}`, duration: c.duration })),
    };
  }

  playClip(index) {
    const next = this.actions[index];
    if (!next) return;
    if (next === this.current) { this.mixer.timeScale = 1; return; }
    next.reset().setEffectiveWeight(1).play();
    if (this.current) this.current.crossFadeTo(next, 0.3, false);
    this.current = next;
    this.mixer.timeScale = 1;
  }
  setPaused(paused) { if (this.mixer) this.mixer.timeScale = paused ? 0 : 1; }
  setSkeleton(on) { this.showBones = on; if (this.bones) this.bones.visible = on; }

  showIdle() { this.loadVersion++; this.#clearModel(); this.idle.visible = true; this.holo.visible = false; this.grid.position.y = -1.15; }
  showGenerating() { this.loadVersion++; this.#clearModel(); this.idle.visible = false; this.holo.visible = true; this.grid.position.y = -1.35; }

  async loadModel(url) {
    const version = ++this.loadVersion;
    if (/\.fbx(\?|$)/i.test(url)) {
      const fbx = await new FBXLoader().loadAsync(url);
      if (version !== this.loadVersion) { disposeObject(fbx); return null; }
      // FBX 的 Phong 材质高光过强、显得发黑发亮，换成与 GLB 一致的 PBR 材质
      fbx.traverse((o) => {
        if (!o.isMesh) return;
        const convert = (m) => {
          const next = new THREE.MeshStandardMaterial({
            name: m.name, color: m.map ? 0xffffff : m.color, map: m.map || null, normalMap: m.normalMap || null,
            roughness: 0.75, metalness: 0, transparent: m.transparent, opacity: m.opacity, side: m.side,
          });
          m.dispose();
          return next;
        };
        o.material = Array.isArray(o.material) ? o.material.map(convert) : convert(o.material);
      });
      this.#clearModel();
      return this.#present(fbx, fbx.animations || []);
    }
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(url);
    if (version !== this.loadVersion) { disposeObject(gltf.scene); return null; }
    this.#clearModel();
    return this.#present(gltf.scene, gltf.animations || []);
  }

  /** 演示模式的绑骨 / 动作成品：程序化的骨骼人偶，可选附带行走与待机动画 */
  showDemoRig(withClips) {
    this.loadVersion++;
    this.#clearModel();
    const root = new THREE.Group();
    const skin = new THREE.MeshStandardMaterial({ color: 0xd3deee, roughness: 0.42, metalness: 0.15 });
    const joint = new THREE.MeshStandardMaterial({ color: 0xff9f66, roughness: 0.3, metalness: 0.4 });
    const bone = (name, parent, x, y, z) => {
      const b = new THREE.Bone();
      b.name = name;
      b.position.set(x, y, z);
      parent.add(b);
      return b;
    };
    const part = (b, geo, y = 0, mat = skin, z = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(0, y, z);
      b.add(m);
    };
    const hips = bone('Hips', root, 0, 1, 0);
    const spine = bone('Spine', hips, 0, 0.14, 0);
    const chest = bone('Chest', spine, 0, 0.24, 0);
    const head = bone('Head', bone('Neck', chest, 0, 0.22, 0), 0, 0.08, 0);
    part(hips, new THREE.SphereGeometry(0.15, 24, 16), 0.02, joint);
    part(spine, new THREE.CapsuleGeometry(0.13, 0.14, 6, 16), 0.12);
    part(chest, new THREE.CapsuleGeometry(0.16, 0.08, 6, 16), 0.08);
    part(head, new THREE.SphereGeometry(0.13, 24, 16), 0.12);
    for (const [s, S] of [[1, 'L'], [-1, 'R']]) {
      const shoulder = bone('Shoulder' + S, chest, s * 0.24, 0.14, 0);
      shoulder.rotation.z = s * 0.28; // A Pose
      const elbow = bone('Elbow' + S, shoulder, 0, -0.3, 0);
      bone('Hand' + S, elbow, 0, -0.28, 0);
      part(shoulder, new THREE.SphereGeometry(0.065, 16, 12), 0, joint);
      part(shoulder, new THREE.CapsuleGeometry(0.05, 0.19, 4, 12), -0.15);
      part(elbow, new THREE.CapsuleGeometry(0.043, 0.2, 4, 12), -0.15);
      const hip = bone('UpLeg' + S, hips, s * 0.1, -0.06, 0);
      const knee = bone('Knee' + S, hip, 0, -0.44, 0);
      const foot = bone('Foot' + S, knee, 0, -0.44, 0);
      bone('Toe' + S, foot, 0, -0.04, 0.16);
      part(hip, new THREE.CapsuleGeometry(0.072, 0.3, 4, 12), -0.22);
      part(knee, new THREE.SphereGeometry(0.06, 16, 12), 0, joint);
      part(knee, new THREE.CapsuleGeometry(0.056, 0.3, 4, 12), -0.22);
      part(foot, new THREE.BoxGeometry(0.11, 0.07, 0.26), -0.03, skin, 0.06);
    }

    const clips = [];
    if (withClips) {
      const N = 24;
      const times = Array.from({ length: N + 1 }, (_, i) => i / N);
      const q = new THREE.Quaternion(), e = new THREE.Euler();
      const rot = (name, fn) => new THREE.QuaternionKeyframeTrack(`${name}.quaternion`,
        times, times.flatMap((t) => { const [x, y, z] = fn(t * Math.PI * 2); return q.setFromEuler(e.set(x, y, z)).toArray(); }));
      const walk = [
        new THREE.VectorKeyframeTrack('Hips.position', times, times.flatMap((t) => [0, 1 + Math.abs(Math.sin(t * Math.PI * 2)) * 0.035 - 0.02, 0])),
        rot('Hips', (p) => [0.05, Math.sin(p) * 0.12, 0]),
        rot('Chest', (p) => [0.04, -Math.sin(p) * 0.18, 0]),
      ];
      const idle = [
        new THREE.VectorKeyframeTrack('Hips.position', times, times.flatMap((t) => [0, 1 + Math.sin(t * Math.PI * 2) * 0.012, 0])),
        rot('Chest', (p) => [Math.sin(p) * 0.03, Math.sin(p) * 0.05, 0]),
        rot('Head', (p) => [0, Math.sin(p) * 0.2, 0]),
      ];
      for (const [s, S] of [[1, 'L'], [-1, 'R']]) {
        walk.push(
          rot('UpLeg' + S, (p) => [-Math.sin(p) * 0.62 * s, 0, 0]),
          rot('Knee' + S, (p) => [Math.max(0, Math.cos(p) * s) * 0.95 + 0.06, 0, 0]),
          rot('Shoulder' + S, (p) => [Math.sin(p) * 0.55 * s, 0, s * 0.12]),
          rot('Elbow' + S, (p) => [-0.35 - Math.max(0, Math.sin(p) * s) * 0.4, 0, 0]),
        );
        idle.push(rot('Shoulder' + S, (p) => [0, 0, s * (0.24 + Math.sin(p) * 0.03)]), rot('Elbow' + S, () => [-0.12, 0, 0]));
      }
      clips.push(new THREE.AnimationClip('行走（演示）', 1, walk), new THREE.AnimationClip('待机（演示）', 3, idle.map((t) => { t.times = t.times.map((v) => v * 3); return t; })));
    }
    return this.#present(root, clips);
  }

  /** 演示模式的占位成品：程序化生成的雕塑 */
  showDemoModel() {
    this.loadVersion++;
    this.#clearModel();
    const root = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.TorusKnotGeometry(0.62, 0.22, 240, 36, 2, 3),
      new THREE.MeshPhysicalMaterial({ color: 0xffb184, metalness: 0.85, roughness: 0.22, clearcoat: 1, iridescence: 0.8 }),
    );
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.7, 0.8, 0.14, 64),
      new THREE.MeshStandardMaterial({ color: 0x1a2740, metalness: 0.6, roughness: 0.35 }),
    );
    base.position.y = -1.12;
    root.add(body, base);
    return this.#present(root);
  }

  setWireframe(on) {
    this.wireframe = on;
    this.model?.traverse((o) => { for (const m of [].concat(o.material || [])) m.wireframe = on; });
  }
  setAutoRotate(on) { this.controls.autoRotate = on; }
  resetView() { this.camera.position.copy(HOME); this.controls.target.set(0, 0, 0); this.controls.update(); }
}

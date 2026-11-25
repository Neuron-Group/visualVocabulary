import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);
const EASE_OUT = (t) => 1 - Math.pow(1 - t, 4);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const rnd = mulberry32(777);
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.18, 'rgba(255,255,255,0.24)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.075)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  ctx.globalCompositeOperation = 'lighter';
  ctx.filter = 'blur(14px)';
  for (let i = 0; i < 34; i++) {
    const x = 128 + (rnd() - 0.5) * 160;
    const y = 128 + (rnd() - 0.5) * 160;
    const r = 10 + rnd() * 38;
    const a = 0.008 + rnd() * 0.028;
    ctx.fillStyle = `rgba(255,255,255,${a})`;
    ctx.beginPath();
    ctx.ellipse(x, y, r * (0.5 + rnd()), r * (0.4 + rnd() * 0.7), rnd() * TAU, 0, TAU);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeRingTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  ctx.translate(128, 128);
  const glow = ctx.createRadialGradient(0, 0, 52, 0, 0, 96);
  glow.addColorStop(0, 'rgba(255,255,255,0)');
  glow.addColorStop(0.55, 'rgba(255,255,255,0.05)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.beginPath(); ctx.arc(0, 0, 110, 0, TAU); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.92)';
  ctx.lineWidth = 2.1;
  ctx.beginPath(); ctx.arc(0, 0, 82, 0, TAU); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(0, 0, 94, 0, TAU); ctx.stroke();
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(0, 0, 102, a - 0.09, a + 0.09);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeStars(count, rMin, rMax, rnd) {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const palette = [
    [0.62, 0.82, 1.0], [1.0, 0.94, 0.8], [0.7, 1.0, 0.92], [0.8, 0.78, 1.0], [0.92, 0.96, 1.0]
  ];
  for (let i = 0; i < count; i++) {
    const r = rMin + rnd() * (rMax - rMin);
    const theta = rnd() * TAU;
    const phi = Math.acos(2 * rnd() - 1);
    pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    pos[i * 3 + 1] = r * Math.cos(phi) * 0.65;
    pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    const p = palette[Math.floor(rnd() * palette.length)];
    const bright = 0.35 + rnd() * 0.65;
    col[i * 3] = p[0] * bright;
    col[i * 3 + 1] = p[1] * bright;
    col[i * 3 + 2] = p[2] * bright;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({
    size: 1.25,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  return new THREE.Points(geo, mat);
}

export class Atlas {
  constructor(opts) {
    this.canvas = opts.canvas;
    this.labelsEl = opts.labelsEl;
    this.data = opts.data;
    this.words = this.data.words;
    this.meta = this.data.meta;
    this.n = this.words.length;
    this.onHover = opts.onHover || (() => {});
    this.onSelect = opts.onSelect || (() => {});
    this.onHint = opts.onHint || (() => {});
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.isMobile = window.matchMedia('(max-width: 860px)').matches;

    this.selected = -1;
    this.hovered = -1;
    this.focusCluster = -1;
    this.projection = 'umap';
    this.pointers = new Map();
    this.keys = new Set();
    this.dragging = false;
    this.dragDistance = 0;
    this.pointer = { x: -1, y: -1, inside: false };
    this.velocity = new THREE.Vector3();
    this.time = 0;
    this.labelAccum = 0;
    this.frame = 0;

    this.colors = this.meta.clusters.map(c => {
      const col = new THREE.Color(c.color);
      col.convertSRGBToLinear();
      return col;
    });
    this.cssColors = this.meta.clusters.map(c => c.color);
    this.wordColors = this.words.map(w => this.colors[w.cl] || this.colors[0]);

    this.initRenderer();
    this.initCamera();
    this.makeProjectionArrays();
    this.buildScene();
    this.buildPoints();
    this.buildBackgroundEdges();
    this.buildSelection();
    this.buildLabels();
    this.bindEvents();
    this.resize();
  }

  initRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance',
      alpha: false,
      stencil: false
    });
    this.dpr = Math.min(window.devicePixelRatio || 1, this.isMobile ? 1.75 : 2);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    this.renderer.setClearColor(0x03050b, 1);
    try {
      const gl = this.renderer.getContext();
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      this.softwareRenderer = /swiftshader|llvmpipe|softpipe|software|virgl/i.test(String(gpu || ''));
    } catch {
      this.softwareRenderer = false;
    }
    if (this.softwareRenderer) {
      this.dpr = Math.min(window.devicePixelRatio || 1, 0.8);
      this.renderer.setPixelRatio(this.dpr);
    }

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x03050b);
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1200);
    this.camera.rotation.order = 'YXZ';
    this.home = new THREE.Vector3(54, 34, 164);
    this.camera.position.copy(this.home);
    this.camera.lookAt(0, 0, 0);
    this.forward = new THREE.Vector3();
    this.right = new THREE.Vector3();

    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(this.dpr);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), this.isMobile ? 0.55 : 0.72, 0.5, 0.68);
    this.bloom.enabled = !this.softwareRenderer;
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  initCamera() {
    this.projection = 'umap';
    this.tween = null;
    this.posTween = null;
    this.syncAngles = this.syncAngles.bind(this);
    this.syncAngles();
    this.lastFrame = 0;
  }

  makeProjectionArrays() {
    this.proj = {
      umap: new Float32Array(this.n * 3),
      pca: new Float32Array(this.n * 3)
    };
    this.words.forEach((w, i) => {
      for (let d = 0; d < 3; d++) {
        this.proj.umap[i * 3 + d] = w.u[d];
        this.proj.pca[i * 3 + d] = w.a[d];
      }
    });
    this.positions = this.proj.umap.slice();
    this.screen = new Float32Array(this.n * 4);
  }

  buildScene() {
    const rnd = mulberry32(91);
    const starLayer = makeStars(1400, 270, 610, rnd);
    this.stars = starLayer;
    this.scene.add(starLayer);
    const bright = makeStars(120, 300, 560, rnd);
    bright.material.size = 2.1;
    bright.material.opacity = 0.9;
    this.brightStars = bright;
    this.scene.add(bright);

    // deep-space gradient dome
    const domeGeo = new THREE.SphereGeometry(760, 32, 20);
    const domeMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uTop: { value: new THREE.Color(0x07111f) },
        uBottom: { value: new THREE.Color(0x020309) },
        uGlow: { value: new THREE.Color(0x0b2931) }
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vDir;
        uniform vec3 uTop;
        uniform vec3 uBottom;
        uniform vec3 uGlow;
        void main() {
          float h = smoothstep(-0.35, 0.75, vDir.y);
          vec3 col = mix(uBottom, uTop, h);
          float band = exp(-pow((vDir.y + 0.15) * 3.2, 2.0));
          col += uGlow * band * 0.22;
          float vignette = smoothstep(0.9, 0.2, length(vDir.xy));
          col *= 0.7 + 0.3 * vignette;
          gl_FragColor = vec4(col, 1.0);
        }
      `
    });
    this.scene.add(new THREE.Mesh(domeGeo, domeMat));

    // faint orbital rings
    this.rings = new THREE.Group();
    const ringDefs = [
      { r: 128, color: 0x6fe9d6, opacity: 0.05, rot: [1.18, 0.2, 0.5] },
      { r: 156, color: 0x7dd3fc, opacity: 0.03, rot: [0.3, 1.1, -0.5] },
      { r: 188, color: 0xc4b5fd, opacity: 0.024, rot: [1.6, 0.5, 1.2] }
    ];
    for (const def of ringDefs) {
      const pts = [];
      for (let i = 0; i < 180; i++) {
        const a = (i / 180) * TAU;
        pts.push(new THREE.Vector3(Math.cos(a) * def.r, 0, Math.sin(a) * def.r));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({
        color: def.color, transparent: true, opacity: def.opacity,
        blending: THREE.AdditiveBlending, depthWrite: false
      });
      const ring = new THREE.LineLoop(geo, mat);
      ring.rotation.set(...def.rot);
      this.rings.add(ring);
    }
    this.scene.add(this.rings);

    // nebula halos at cluster centroids
    const glowTex = makeGlowTexture();
    this.glowTex = glowTex;
    this.clusterGlows = this.meta.clusters.map(c => {
      const group = new THREE.Group();
      const color = new THREE.Color(c.color).convertSRGBToLinear();
      const core = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex, color, transparent: true, opacity: 0.115,
        blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true
      }));
      core.scale.set(64, 64, 1);
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex, color, transparent: true, opacity: 0.042,
        blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true
      }));
      halo.scale.set(126, 126, 1);
      group.add(halo); group.add(core);
      this.scene.add(group);
      return { group, core, halo, baseCore: 0.115, baseHalo: 0.042 };
    });
    this.updateClusterGlowPositions();
  }

  buildPoints() {
    const n = this.n;
    const geo = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(this.positions, 3);
    pos.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', pos);

    const colorArr = new Float32Array(n * 3);
    const sizeArr = new Float32Array(n);
    const clusterArr = new Float32Array(n);
    const indexArr = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const w = this.words[i];
      const c = this.wordColors[i];
      colorArr[i * 3] = c.r;
      colorArr[i * 3 + 1] = c.g;
      colorArr[i * 3 + 2] = c.b;
      sizeArr[i] = 1.4 + w.imp * 1.75;
      clusterArr[i] = w.cl;
      indexArr[i] = i;
    }
    geo.setAttribute('aColor', new THREE.BufferAttribute(colorArr, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizeArr, 1));
    geo.setAttribute('aCluster', new THREE.BufferAttribute(clusterArr, 1));
    geo.setAttribute('aIndex', new THREE.BufferAttribute(indexArr, 1));

    this.pointMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uPixelRatio: { value: this.dpr },
        uTime: { value: 0 },
        uSelected: { value: -1 },
        uHovered: { value: -1 },
        uFocusCluster: { value: -1 },
        uScale: { value: 300 }
      },
      vertexShader: `
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aCluster;
        attribute float aIndex;
        uniform float uPixelRatio;
        uniform float uTime;
        uniform float uSelected;
        uniform float uHovered;
        uniform float uFocusCluster;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float isSel = step(abs(aIndex - uSelected), 0.5);
          float isHov = step(abs(aIndex - uHovered), 0.5);
          float dim = 1.0;
          if (uFocusCluster > -0.5) {
            dim = mix(0.032, 1.0, step(abs(aCluster - uFocusCluster), 0.5));
          }
          float twinkle = 0.86 + 0.14 * sin(uTime * 1.45 + aIndex * 2.17);
          float size = aSize * (1.0 + isHov * 0.95 + isSel * 1.4) * twinkle;
          gl_PointSize = size * uPixelRatio * (285.0 / max(7.0, -mv.z));
          gl_Position = projectionMatrix * mv;
          vColor = mix(aColor, vec3(1.0), isSel * 0.82 + isHov * 0.35);
          vAlpha = dim * (0.62 + 0.38 * twinkle) * (1.0 + isSel * 0.45 + isHov * 0.25);
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec2 p = gl_PointCoord - 0.5;
          float r = length(p) * 2.0;
          if (r > 1.0) discard;
          float q = 1.0 - r;
          float core = pow(q, 2.2);
          float halo = pow(q, 0.75) * 0.28;
          float alpha = (core + halo) * vAlpha;
          vec3 col = vColor * (0.8 + core * 1.25);
          gl_FragColor = vec4(col, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending
    });
    this.pointsGeo = geo;
    this.points = new THREE.Points(geo, this.pointMaterial);
    this.points.frustumCulled = false;
    this.scene.add(this.points);
  }

  buildBackgroundEdges() {
    const seen = new Set();
    const pairs = [];
    for (let i = 0; i < this.n; i++) {
      const w = this.words[i];
      for (const [j] of (w.nb || []).slice(0, 1)) {
        if (i === j) continue;
        const a = Math.min(i, j), b = Math.max(i, j);
        const key = a * 10000 + b;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push([a, b]);
      }
    }
    this.edgePairs = pairs;
    const positions = new Float32Array(pairs.length * 6);
    const colors = new Float32Array(pairs.length * 6);
    for (let e = 0; e < pairs.length; e++) {
      const [a, b] = pairs[e];
      const ca = this.wordColors[a], cb = this.wordColors[b];
      for (let k = 0; k < 3; k++) {
        colors[e * 6 + k] = ca.r * 0.55;
        colors[e * 6 + 3 + k] = cb.r * 0.55;
      }
    }
    const geo = new THREE.BufferGeometry();
    const attr = new THREE.BufferAttribute(positions, 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', attr);
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.edgeGeo = geo;
    this.edgePositions = positions;
    this.edgeMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.032,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    this.edges = new THREE.LineSegments(geo, this.edgeMaterial);
    this.edges.frustumCulled = false;
    this.scene.add(this.edges);
    this.updateEdges();
  }

  buildSelection() {
    this.ringTex = makeRingTexture();
    this.ring = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.ringTex,
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false
    }));
    this.ring.scale.set(8, 8, 1);
    this.ring.visible = false;
    this.ring.renderOrder = 100;
    this.scene.add(this.ring);

    const maxLinks = 7;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(maxLinks * 6);
    const col = new Float32Array(maxLinks * 6);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.selectLinkGeo = geo;
    this.selectLinkPos = pos;
    this.selectLinkMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.48,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    this.selectLinks = new THREE.LineSegments(geo, this.selectLinkMat);
    this.selectLinks.frustumCulled = false;
    this.selectLinks.visible = false;
    this.scene.add(this.selectLinks);
    this.selectedList = [];
  }

  buildLabels() {
    this.labelPool = [];
    this.landmark = new Set();
    for (const c of this.meta.clusters) for (const w of (c.landmarks || c.samples)) this.landmark.add(w);
    this.functionWords = new Set(('a an the and or but if of to in on at by for from with without into onto upon about as than then that this these those there here where when while who whom whose which what why how be am is are was were been being do does did done have has had having can could may might must shall should will would i you he she it we they me him her us them my your his its our their mine yours myself yourself himself herself itself ourselves themselves very really quite rather too also just only even still yet so such not no nor none some any all both each every either neither one two three first second last next more most less least many much few several other another same own up down out off over under again further once').split(' '));
    this.labelsEl.addEventListener('click', (e) => {
      const el = e.target.closest('.map-label');
      if (!el) return;
      const i = Number(el.dataset.index);
      if (Number.isInteger(i)) this.onSelect(i, { source: 'label' });
    });
  }

  bindEvents() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
      c.setPointerCapture?.(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.cancelTween();
      if (this.pointers.size === 2) {
        this.dragging = false;
        const [p1, p2] = [...this.pointers.values()];
        this.pinchDist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
        this.pinchActive = true;
      } else if (this.pointers.size === 1) {
        this.dragging = true;
        this.dragDistance = 0;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.downX = e.clientX;
        this.downY = e.clientY;
        this.downTime = performance.now();
        document.body.classList.add('is-dragging');
      }
      this.hideHover();
    });

    c.addEventListener('pointermove', (e) => {
      this.pointer.x = e.clientX;
      this.pointer.y = e.clientY;
      this.pointer.inside = true;
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pinchActive && this.pointers.size >= 2) {
        const [p1, p2] = [...this.pointers.values()];
        const d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
        if (this.pinchDist) this.dolly((this.pinchDist - d) * 0.13);
        this.pinchDist = d;
        return;
      }
      if (this.dragging) {
        const dx = e.clientX - this.lastX;
        const dy = e.clientY - this.lastY;
        this.dragDistance += Math.abs(dx) + Math.abs(dy);
        this.lastX = e.clientX; this.lastY = e.clientY;
        this.yaw -= dx * 0.0032;
        this.pitch = clamp(this.pitch + dy * 0.0032, -1.42, 1.42);
        this.updateForward();
        this.velocity.multiplyScalar(0.82);
        if (this.dragDistance > 8) this.onHint('drag');
        return;
      }
      this.updatePointerHover();
    });

    const end = (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      const wasSingle = this.pointers.size === 1;
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinchActive = false;
      if (this.pointers.size === 0 && this.dragging) {
        this.dragging = false;
        document.body.classList.remove('is-dragging');
        const dt = performance.now() - (this.downTime || 0);
        if (wasSingle && dt < 500 && this.dragDistance < 7) {
          const hit = this.pickAt(e.clientX, e.clientY);
          if (hit >= 0) this.onSelect(hit, { source: 'canvas' });
        }
        if (this.pointer.inside) this.updatePointerHover();
      }
      c.releasePointerCapture?.(e.pointerId);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => {
      this.pointer.inside = false;
      if (!this.dragging) this.hideHover();
    });

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.cancelTween();
      const scale = e.deltaMode === 1 ? 16 : 1;
      this.dolly(-e.deltaY * scale * 0.055);
      this.onHint('wheel');
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      const tag = (e.target?.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || e.target?.isContentEditable;
      if (typing) return;
      if (e.key === '/' || (e.key === 'k' && !e.metaKey && !e.ctrlKey)) {
        e.preventDefault();
        document.getElementById('searchInput')?.focus();
        return;
      }
      if (e.key === 'Escape') {
        this.onSelect(-1, { source: 'escape' });
        return;
      }
      if (e.key === 'r' || e.key === 'R') {
        document.getElementById('randomBtn')?.click();
        return;
      }
      if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
        document.getElementById('helpBtn')?.click();
        return;
      }
      const k = e.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'q', 'e'].includes(k)) {
        this.keys.add(k);
        this.cancelTween();
      }
      if (e.key === 'Shift') this.shift = true;
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.key.toLowerCase());
      if (e.key === 'Shift') this.shift = false;
    });
    window.addEventListener('blur', () => { this.keys.clear(); this.shift = false; });
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.width = w; this.height = h;
    this.dpr = Math.min(window.devicePixelRatio || 1, this.softwareRenderer || this.lowQuality ? 0.8 : this.isMobile ? 1.75 : 2);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.dpr);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.pointMaterial.uniforms.uPixelRatio.value = this.dpr;
    this.bloom.setSize(w, h);
  }

  updateForward() {
    this.camera.rotation.set(this.pitch, this.yaw, 0);
    this.camera.getWorldDirection(this.forward);
    this.right.crossVectors(this.forward, UP).normalize();
  }

  syncAngles() {
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.pitch = e.x;
    this.yaw = e.y;
    this.updateForward();
  }

  dolly(amount) {
    this.camera.position.addScaledVector(this.forward, amount);
    this.clampCamera();
  }

  clampCamera() {
    const p = this.camera.position;
    const r = p.length();
    if (r < 14) p.multiplyScalar(14 / Math.max(r, 0.001));
    if (r > 500) p.multiplyScalar(500 / r);
  }

  updatePointerHover() {
    if (!this.pointer.inside || this.dragging) return;
    const id = this.pickAt(this.pointer.x, this.pointer.y);
    if (id !== this.hovered) {
      this.hovered = id;
      this.pointMaterial.uniforms.uHovered.value = id;
      this.onHover(id, { x: this.pointer.x, y: this.pointer.y });
      this.canvas.style.cursor = id >= 0 ? 'pointer' : '';
    }
  }

  hideHover() {
    if (this.hovered !== -1) {
      this.hovered = -1;
      this.pointMaterial.uniforms.uHovered.value = -1;
      this.onHover(-1, null);
      this.canvas.style.cursor = '';
    }
  }

  pickAt(clientX, clientY) {
    if (!this.screen) return -1;
    let best = -1, bestDepth = Infinity;
    const threshold = this.isMobile ? 24 : 15;
    const t2 = threshold * threshold;
    for (let i = 0; i < this.n; i++) {
      const o = i * 4;
      if (this.screen[o + 3] < 0.5) continue;
      const dx = this.screen[o] - clientX;
      const dy = this.screen[o + 1] - clientY;
      const d2 = dx * dx + dy * dy;
      if (d2 > t2) continue;
      const depth = this.screen[o + 2];
      if (depth < bestDepth) { bestDepth = depth; best = i; }
    }
    return best;
  }

  updateScreen() {
    this.camera.updateMatrixWorld();
    const w = this.width, h = this.height;
    const v = new THREE.Vector3();
    for (let i = 0; i < this.n; i++) {
      v.set(this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2]).project(this.camera);
      const o = i * 4;
      if (v.z < -1 || v.z > 1) {
        this.screen[o + 3] = 0;
        continue;
      }
      this.screen[o] = (v.x * 0.5 + 0.5) * w;
      this.screen[o + 1] = (-v.y * 0.5 + 0.5) * h;
      this.screen[o + 2] = v.z;
      this.screen[o + 3] = (
        this.screen[o] > -80 && this.screen[o] < w + 80 &&
        this.screen[o + 1] > -60 && this.screen[o + 1] < h + 60
      ) ? 1 : 0;
    }
  }

  updateLabels() {
    if (!this.width) return;
    const maxLabels = this.width < 600 ? 7 : this.width < 900 ? 11 : this.width < 1300 ? 16 : 20;
    const candidates = [];
    for (let i = 0; i < this.n; i++) {
      const o = i * 4;
      if (this.screen[o + 3] < 0.5) continue;
      const w = this.words[i];
      if (this.focusCluster >= 0 && w.cl !== this.focusCluster) continue;
      const x = this.screen[o], y = this.screen[o + 1];
      if (x < 18 || x > this.width - 18 || y < 80 || y > this.height - 84) continue;
      const center = Math.hypot(x - this.width / 2, y - this.height / 2) / Math.hypot(this.width / 2, this.height / 2);
      let score = w.imp * 0.5 + (this.landmark.has(w.w) ? 1.25 : 0) + (1 - Math.min(1, center)) * 0.45 + (1 - this.screen[o + 2]) * 0.1;
      if (i === this.hovered) score += 8;
      if (i === this.selected) score += 14;
      candidates.push([score, i, x, y]);
    }
    candidates.sort((a, b) => b[0] - a[0]);
    const boxes = [];
    const chosen = [];
    const extra = [];
    // Avoid labels sliding under the fixed UI surfaces.
    const avoidRects = [];
    for (const sel of ['.constellation-panel', '.detail-panel.is-open']) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 4 && r.height > 4 && getComputedStyle(el).visibility !== 'hidden') {
        avoidRects.push({ x: r.left - 10, y: r.top - 8, w: r.width + 20, h: r.height + 16 });
      }
    }
    // Always keep selected + hovered in view.
    if (this.selected >= 0) extra.push(this.selected);
    if (this.hovered >= 0 && this.hovered !== this.selected) extra.push(this.hovered);
    for (const idx of extra) {
      const o = idx * 4;
      if (this.screen[o + 3] > 0.5) chosen.push([idx, this.screen[o], this.screen[o + 1]]);
    }
    const clusterUsage = new Array(this.meta.clusters.length).fill(0);
    const clusterCap = this.focusCluster >= 0 ? 10 : 2;
    for (const [, i, x, y] of candidates) {
      if (chosen.length >= maxLabels) break;
      if (chosen.some(([idx]) => idx === i)) continue;
      const word = this.words[i].w;
      if (this.functionWords.has(word)) continue;
      const w = this.words[i];
      if (clusterUsage[w.cl] >= clusterCap) continue;
      const bw = Math.min(150, 24 + word.length * 6.6);
      const bh = 22;
      const bx = x - bw / 2, by = y - bh / 2;
      let overlap = false;
      for (const b of boxes) {
        if (bx < b.x + b.w + 6 && bx + bw + 6 > b.x && by < b.y + b.h + 4 && by + bh + 4 > b.y) { overlap = true; break; }
      }
      if (overlap) continue;
      for (const b of avoidRects) {
        if (bx < b.x + b.w && bx + bw > b.x && by < b.y + b.h && by + bh > b.y) { overlap = true; break; }
      }
      if (overlap) continue;
      boxes.push({ x: bx, y: by, w: bw, h: bh });
      chosen.push([i, x, y]);
      clusterUsage[w.cl]++;
    }
    // Ensure pool
    while (this.labelPool.length < chosen.length) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'map-label hidden-label';
      el.innerHTML = '<span class="ldot"></span><span class="lbl-text"></span>';
      this.labelsEl.appendChild(el);
      this.labelPool.push(el);
    }
    const used = new Set();
    chosen.forEach(([i, x, y], k) => {
      const el = this.labelPool[k];
      const w = this.words[i];
      el.dataset.index = i;
      el.style.left = `${x.toFixed(1)}px`;
      el.style.top = `${y.toFixed(1)}px`;
      el.style.setProperty('--c', this.cssColors[w.cl]);
      el.classList.remove('hidden-label');
      el.classList.toggle('is-selected', i === this.selected);
      el.classList.toggle('is-bright', i === this.hovered);
      const text = el.querySelector('.lbl-text');
      if (text.textContent !== w.w) text.textContent = w.w;
      used.add(k);
    });
    for (let k = chosen.length; k < this.labelPool.length; k++) this.labelPool[k].classList.add('hidden-label');
  }

  updateEdges() {
    if (!this.edgePairs) return;
    const p = this.positions;
    const ep = this.edgePositions;
    for (let e = 0; e < this.edgePairs.length; e++) {
      const [a, b] = this.edgePairs[e];
      ep[e * 6] = p[a * 3]; ep[e * 6 + 1] = p[a * 3 + 1]; ep[e * 6 + 2] = p[a * 3 + 2];
      ep[e * 6 + 3] = p[b * 3]; ep[e * 6 + 4] = p[b * 3 + 1]; ep[e * 6 + 5] = p[b * 3 + 2];
    }
    this.edgeGeo.attributes.position.needsUpdate = true;
  }

  updateSelectionVisuals() {
    const i = this.selected;
    if (i < 0) {
      this.ring.visible = false;
      this.selectLinks.visible = false;
      return;
    }
    const w = this.words[i];
    const x = this.positions[i * 3], y = this.positions[i * 3 + 1], z = this.positions[i * 3 + 2];
    this.ring.visible = true;
    this.ring.position.set(x, y, z);
    this.ring.material.color.set(this.cssColors[w.cl]);
    this.selectLinks.visible = true;
    this.selectedList = (w.nb || []).slice(0, 7).map(([j]) => j);
    const pos = this.selectLinkPos;
    const col = this.selectLinkGeo.attributes.color.array;
    const ca = this.wordColors[i];
    for (let k = 0; k < 7; k++) {
      const j = this.selectedList[k];
      if (j === undefined) {
        for (let d = 0; d < 6; d++) pos[k * 6 + d] = 0;
        continue;
      }
      pos[k * 6] = x; pos[k * 6 + 1] = y; pos[k * 6 + 2] = z;
      pos[k * 6 + 3] = this.positions[j * 3];
      pos[k * 6 + 4] = this.positions[j * 3 + 1];
      pos[k * 6 + 5] = this.positions[j * 3 + 2];
      const cb = this.wordColors[j];
      col[k * 6] = ca.r; col[k * 6 + 1] = ca.g; col[k * 6 + 2] = ca.b;
      col[k * 6 + 3] = cb.r; col[k * 6 + 4] = cb.g; col[k * 6 + 5] = cb.b;
    }
    this.selectLinkGeo.attributes.position.needsUpdate = true;
    this.selectLinkGeo.attributes.color.needsUpdate = true;
  }

  updateClusterGlowPositions() {
    if (!this.clusterGlows) return;
    const sums = this.meta.clusters.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < this.n; i++) {
      const w = this.words[i];
      const s = sums[w.cl];
      s[0] += this.positions[i * 3];
      s[1] += this.positions[i * 3 + 1];
      s[2] += this.positions[i * 3 + 2];
      s[3]++;
    }
    this.clusterGlows.forEach((g, j) => {
      const s = sums[j];
      if (!s[3]) return;
      g.group.position.set(s[0] / s[3], s[1] / s[3], s[2] / s[3]);
    });
  }

  updateFocusState() {
    this.pointMaterial.uniforms.uFocusCluster.value = this.focusCluster;
    const dim = this.focusCluster >= 0;
    this.edgeMaterial.opacity = dim ? 0.009 : 0.032;
    this.clusterGlows.forEach((g, j) => {
      const focused = this.focusCluster === j;
      g.core.material.opacity = dim ? (focused ? 0.18 : 0.02) : g.baseCore;
      g.halo.material.opacity = dim ? (focused ? 0.06 : 0.006) : g.baseHalo;
    });
  }

  selectWord(i, { fly = true, distance = 32 } = {}) {
    if (i < 0) {
      this.selected = -1;
      this.focusCluster = -1;
      this.pointMaterial.uniforms.uSelected.value = -1;
      this.pointMaterial.uniforms.uFocusCluster.value = -1;
      this.updateSelectionVisuals();
      this.updateFocusState();
      this.updateLabels();
      return;
    }
    this.focusCluster = -1;
    this.selected = i;
    this.pointMaterial.uniforms.uSelected.value = i;
    this.pointMaterial.uniforms.uFocusCluster.value = -1;
    this.updateSelectionVisuals();
    this.updateFocusState();
    if (fly) this.flyToWord(i, distance);
    this.updateLabels();
  }

  focusOnCluster(id, { fly = true } = {}) {
    this.focusCluster = id;
    this.selected = -1;
    this.pointMaterial.uniforms.uSelected.value = -1;
    this.updateSelectionVisuals();
    this.updateFocusState();
    if (fly) this.flyToCluster(id);
    this.updateLabels();
  }

  clearFocus({ fly = false } = {}) {
    this.focusCluster = -1;
    this.selected = -1;
    this.pointMaterial.uniforms.uSelected.value = -1;
    this.updateSelectionVisuals();
    this.updateFocusState();
    if (fly) this.flyHome();
    this.updateLabels();
  }

  flyHome() {
    const target = new THREE.Vector3(0, 0, 0);
    const dest = this.home.clone();
    this.startTween(dest, target, 1.8);
  }

  flyToWord(i, distance = 30) {
    const target = new THREE.Vector3(this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2]);
    let approach = new THREE.Vector3().subVectors(this.camera.position, target);
    if (approach.lengthSq() < 1) approach.copy(this.forward).negate();
    approach.normalize();
    if (Math.abs(approach.y) < 0.16) {
      approach.y += 0.22;
      approach.normalize();
    }
    const dest = target.clone().addScaledVector(approach, distance);
    const dist = this.camera.position.distanceTo(dest);
    this.startTween(dest, target, clamp(0.9 + dist / 260, 1.05, 1.85));
  }

  flyToCluster(id) {
    const c = this.meta.clusters[id];
    const target = new THREE.Vector3(0, 0, 0);
    let count = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.words[i].cl !== id) continue;
      target.x += this.positions[i * 3];
      target.y += this.positions[i * 3 + 1];
      target.z += this.positions[i * 3 + 2];
      count++;
    }
    if (count) target.divideScalar(count);
    let approach = new THREE.Vector3().subVectors(this.camera.position, target);
    if (approach.lengthSq() < 1) approach.set(0.1, 0.35, 1);
    approach.normalize();
    if (Math.abs(approach.y) < 0.2) { approach.y += 0.3; approach.normalize(); }
    const dest = target.clone().addScaledVector(approach, this.width < 860 ? 82 : 68);
    this.startTween(dest, target, 1.75);
  }

  startTween(dest, look, dur) {
    if (this.reducedMotion) {
      this.camera.position.copy(dest);
      this.camera.lookAt(look);
      this.syncAngles();
      return;
    }
    const currentForward = new THREE.Vector3();
    this.camera.getWorldDirection(currentForward);
    const fromLook = this.camera.position.clone().addScaledVector(currentForward, 70);
    this.tween = {
      fromPos: this.camera.position.clone(),
      toPos: dest.clone(),
      fromLook,
      toLook: look.clone(),
      t: 0,
      dur
    };
    this.velocity.set(0, 0, 0);
  }

  cancelTween() {
    if (!this.tween) return;
    this.tween = null;
    this.syncAngles();
  }

  setProjection(p, { animate = true } = {}) {
    if (p !== 'umap' && p !== 'pca') return;
    if (p === this.projection && !this.posTween) return;
    const target = this.proj[p];
    const from = this.positions.slice();
    this.projection = p;
    if (!animate || this.reducedMotion) {
      this.positions.set(target);
      this.posTween = null;
      this.afterPositionsMove();
      return;
    }
    this.posTween = { from, to: target, t: 0, dur: 1.55 };
  }

  afterPositionsMove() {
    this.pointsGeo.attributes.position.needsUpdate = true;
    this.updateEdges();
    this.updateSelectionVisuals();
    this.updateClusterGlowPositions();
  }

  stepPositions(dt) {
    if (!this.posTween) return;
    const tw = this.posTween;
    tw.t = Math.min(1, tw.t + dt / tw.dur);
    const e = tw.t < 0.5 ? 4 * tw.t ** 3 : 1 - Math.pow(-2 * tw.t + 2, 3) / 2;
    for (let i = 0; i < this.positions.length; i++) {
      this.positions[i] = lerp(tw.from[i], tw.to[i], e);
    }
    this.afterPositionsMove();
    if (tw.t >= 1) this.posTween = null;
  }

  stepCamera(dt) {
    if (this.tween) {
      const tw = this.tween;
      tw.t = Math.min(1, tw.t + dt / tw.dur);
      const e = EASE_OUT(tw.t);
      this.camera.position.lerpVectors(tw.fromPos, tw.toPos, e);
      const look = new THREE.Vector3().lerpVectors(tw.fromLook, tw.toLook, e);
      this.camera.lookAt(look);
      if (tw.t >= 1) {
        this.tween = null;
        this.syncAngles();
      }
      return;
    }

    const keys = this.keys;
    let mx = 0, my = 0, mz = 0;
    if (keys.has('w')) mz -= 1;
    if (keys.has('s')) mz += 1;
    if (keys.has('a')) mx -= 1;
    if (keys.has('d')) mx += 1;
    if (keys.has('e')) my += 1;
    if (keys.has('q')) my -= 1;
    const desire = new THREE.Vector3();
    if (mx || my || mz) {
      desire.addScaledVector(this.forward, -mz);
      desire.addScaledVector(this.right, mx);
      desire.y += my;
      desire.normalize();
      const speed = (this.shift ? 128 : 54);
      desire.multiplyScalar(speed);
      this.onHint('keys');
    }
    const damp = 1 - Math.exp(-dt * 8);
    this.velocity.lerp(desire, damp);
    if (this.velocity.lengthSq() > 0.001) {
      this.camera.position.addScaledVector(this.velocity, dt);
      this.clampCamera();
    }
    this.updateForward();
  }

  updateStars(dt) {
    if (!this.stars) return;
    this.stars.rotation.y += dt * 0.0035;
    this.stars.rotation.x = Math.sin(this.time * 0.02) * 0.02;
    this.brightStars.rotation.y -= dt * 0.002;
    this.rings.rotation.y += dt * 0.006;
    this.rings.rotation.z = Math.sin(this.time * 0.04) * 0.03;
  }

  animate(now = performance.now() / 1000) {
    const dt = Math.min(this.lastFrame ? now - this.lastFrame : 0.016, 0.05);
    this.lastFrame = now;
    this.time += dt;
    this.frame++;
    this.stepCamera(dt);
    this.stepPositions(dt);
    this.updateStars(dt);
    this.pointMaterial.uniforms.uTime.value = this.time;

    if (this.selected >= 0) {
      const p = 1 + Math.sin(this.time * 2.2) * 0.12;
      this.ring.scale.set(8 * p, 8 * p, 1);
      this.ring.material.opacity = 0.72 + Math.sin(this.time * 2.2) * 0.16;
    }

    this.updateScreen();
    this.labelAccum += dt;
    if (this.labelAccum > 0.075) {
      this.updateLabels();
      this.labelAccum = 0;
    }
    this.composer.render();

    // Adaptive fallback for weak GPUs / masked software renderers.
    if (!this.perfChecked) {
      const elapsed = now - this.perfStart;
      if (elapsed > 7) {
        const fps = (this.frame - this.perfStartFrame) / elapsed;
        if (fps < 24 && !this.softwareRenderer) this.enablePerformanceMode();
        this.perfChecked = true;
      }
    }
  }

  enablePerformanceMode() {
    if (this.lowQuality) return;
    this.lowQuality = true;
    this.bloom.enabled = false;
    this.dpr = Math.min(window.devicePixelRatio || 1, 0.8);
    this.renderer.setPixelRatio(this.dpr);
    this.composer.setPixelRatio(this.dpr);
    this.composer.setSize(this.width, this.height);
    this.pointMaterial.uniforms.uPixelRatio.value = this.dpr;
  }

  start() {
    if (this.raf) return;
    this.lastFrame = performance.now() / 1000;
    this.perfStart = performance.now() / 1000;
    this.perfStartFrame = 0;
    this.perfChecked = this.softwareRenderer;
    const loop = (now) => {
      this.animate(now / 1000);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  beginIntro() {
    if (this.reducedMotion) return;
    this.camera.position.set(112, 82, 302);
    this.startTween(this.home.clone(), new THREE.Vector3(0, 0, 0), 2.9);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.renderer.dispose();
  }
}

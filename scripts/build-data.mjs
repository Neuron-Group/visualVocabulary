/**
 * Build the 5500-word semantic atlas.
 *
 * Inputs (see scripts/fetch-data.sh):
 *   data/raw/NPEE_Wordlist.txt   - 考研英语大纲词表 (mahavivo/english-wordlists)
 *   data/raw/ecdict.csv          - ECDICT (skywind3000/ECDICT, MIT)
 *   data/raw/glove100.gz         - GloVe wiki-gigaword 100d
 *
 * Output:
 *   public/data/graph.json
 *   public/data/build-report.json
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { parse } from 'csv-parse/sync';
import { UMAP } from 'umap-js';

const ROOT = path.resolve(import.meta.dirname, '..');
const RAW = path.join(ROOT, 'data/raw');
const OUT = path.join(ROOT, 'public/data');
const NPEE_PATH = path.join(RAW, 'NPEE_Wordlist.txt');
const ECDICT_PATH = path.join(RAW, 'ecdict.csv');
const GLOVE_PATH = path.join(RAW, 'glove100.gz');
const TARGET = 5500;
const K = 14;
const DIMS = 100;
const LOG = (...a) => console.log('[build]', ...a);

for (const p of [NPEE_PATH, ECDICT_PATH, GLOVE_PATH]) {
  if (!fs.existsSync(p)) {
    console.error(`Missing ${p}\nRun: bash scripts/fetch-data.sh`);
    process.exit(1);
  }
}
fs.mkdirSync(OUT, { recursive: true });

// ---------- deterministic RNG ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20251125);

// ---------- helpers ----------
const POS_MAP = {
  'vt': 'vt.', 'vi': 'vi.', 'v': 'v.', 'n': 'n.', 'a': 'adj.', 'adj': 'adj.',
  'ad': 'adv.', 'adv': 'adv.', 'prep': 'prep.', 'pron': 'pron.', 'conj': 'conj.',
  'num': 'num.', 'art': 'art.', 'int': 'int.', 'aux': 'aux.', 'abbr': 'abbr.'
};
function cleanTranslation(s) {
  if (!s) return '';
  let t = String(s).replace(/\\n/g, '\n').replace(/\r/g, '');
  const lines = t.split('\n').map(x => x.trim()).filter(Boolean)
    .filter(x => !/^\[(网络|网络释义)\]/.test(x))
    .filter(x => !/^\[/.test(x) || /^\[[^\]]+\]\s*\S/.test(x));
  t = lines.join('；');
  t = t.replace(/\[网络\][^；]*/g, '')
       .replace(/\s+/g, ' ')
       .replace(/；+/g, '；')
       .replace(/^；|；$/g, '')
       .trim();
  if (t.length > 230) t = t.slice(0, 228).trimEnd() + '…';
  return t;
}
function cleanPhonetic(s) {
  return String(s || '').replace(/^\/|\/$/g, '').replace(/\s+/g, ' ').trim();
}
function normWord(s) {
  return String(s || '').toLowerCase().replace(/[’]/g, "'").replace(/ˈ/g, "'").trim();
}
function extractPos(def, tag = '') {
  const out = [];
  const re = /\b(vt|vi|v|n|a|adj|ad|adv|prep|pron|conj|num|art|int|aux)\./g;
  let m;
  while ((m = re.exec(def || '')) !== null) {
    const p = POS_MAP[m[1]];
    if (p && !out.includes(p)) out.push(p);
  }
  if (!out.length && tag) {
    for (const t of tag.split(' ')) {
      if (t === 'ky' || t === 'cet4' || t === 'cet6' || t === 'gk' || t === 'toefl' || t === 'ielts' || t === 'gre') continue;
    }
  }
  return out.slice(0, 3);
}

// ---------- parse NPEE ----------
LOG('Parsing NPEE wordlist…');
const npeeText = fs.readFileSync(NPEE_PATH, 'utf8').replace(/^\uFEFF/, '');
const byWord = new Map();
for (const rawLine of npeeText.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line) continue;
  let word, phonetic = '', def = '';
  const bi = line.indexOf('[');
  if (bi > 0) {
    const prefix = line.slice(0, bi).trim();
    if (/\s/.test(prefix)) continue; // skip multi-word phrases
    const close = line.indexOf(']', bi);
    if (close < 0) continue;
    word = prefix;
    phonetic = line.slice(bi + 1, close);
    def = line.slice(close + 1).trim();
  } else {
    const m = line.match(/^([A-Za-z][A-Za-z'’.\-]*)\s+(.*)$/);
    if (!m) continue;
    word = m[1];
    def = m[2].trim();
  }
  word = normWord(word);
  if (word === 'oˈclock') word = "o'clock";
  if (!/^[a-z][a-z'\-.]*$/.test(word)) continue;
  def = def.replace(/\s+/g, ' ').trim();
  if (!def) continue;
  if (!byWord.has(word)) {
    byWord.set(word, { word, phonetic: cleanPhonetic(phonetic), defs: [def], source: 'NPEE' });
  } else {
    const rec = byWord.get(word);
    if (!rec.phonetic && phonetic) rec.phonetic = cleanPhonetic(phonetic);
    if (!rec.defs.includes(def)) rec.defs.push(def);
  }
}
LOG(`  ${byWord.size} unique NPEE words`);

// ---------- ECDICT lookup ----------
LOG('Parsing ECDICT (66 MB)…');
const ecdictRows = parse(fs.readFileSync(ECDICT_PATH), {
  columns: true, skip_empty_lines: true, relax_quotes: true, relax_column_count: true
});
const ecdictByWord = new Map();
for (const row of ecdictRows) ecdictByWord.set(normWord(row.word), row);
LOG(`  ${ecdictByWord.size} dictionary entries`);

const vectorWords = new Set(byWord.keys());
const noVector = [];
// Add high-frequency 考研-tagged words that the NPEE list omitted.
const candidates = [];
for (const [w, row] of ecdictByWord) {
  if (vectorWords.has(w)) continue;
  if (!/^[a-z][a-z'\-.]*$/.test(w)) continue;
  if (!(row.tag || '').split(' ').includes('ky')) continue;
  const bnc = Number(row.bnc) || 1e9;
  const frq = Number(row.frq) || 1e9;
  candidates.push({ w, row, rank: Math.min(bnc, frq) });
}
candidates.sort((a, b) => a.rank - b.rank || a.w.localeCompare(b.w));
for (const { w, row } of candidates) {
  if (byWord.size >= TARGET) break;
  const def = cleanTranslation(row.translation);
  if (!def) continue;
  byWord.set(w, {
    word: w,
    phonetic: cleanPhonetic(row.phonetic),
    defs: [def.replace(/；/g, '; ')],
    source: 'ECDICT-ky'
  });
}
if (byWord.size < TARGET) throw new Error(`Only ${byWord.size} words; need ${TARGET}`);
const words = [...byWord.values()].slice(0, TARGET);
LOG(`  final list: ${words.length} words (${words.filter(w => w.source === 'NPEE').length} NPEE + ${words.filter(w => w.source !== 'NPEE').length} supplements)`);

// ---------- load GloVe ----------
LOG('Streaming GloVe vectors…');
const FALLBACK = { appal: 'appall', cigaret: 'cigarette' };
const wordList = words.map(w => w.word);
const need = new Set(wordList);
for (const f of Object.values(FALLBACK)) need.add(f);
const vecMap = new Map();
const rl = readline.createInterface({
  input: fs.createReadStream(GLOVE_PATH).pipe(zlib.createGunzip()),
  crlfDelay: Infinity
});
let first = true;
for await (const line of rl) {
  if (first) { first = false; continue; }
  const sp = line.indexOf(' ');
  if (sp < 0) continue;
  const w = line.slice(0, sp);
  if (!need.has(w)) continue;
  const parts = line.slice(sp + 1).split(' ');
  const v = new Float32Array(DIMS);
  for (let i = 0; i < DIMS; i++) v[i] = Number(parts[i]);
  vecMap.set(w, v);
}
for (const [w, f] of Object.entries(FALLBACK)) {
  if (!vecMap.has(w) && vecMap.has(f)) vecMap.set(w, vecMap.get(f).slice());
}
const missing = wordList.filter(w => !vecMap.has(w));
if (missing.length) {
  LOG(`  no vector for ${missing.length}: ${missing.slice(0, 20).join(', ')}`);
  if (missing.length > 50) throw new Error('Too many words without vectors');
}
LOG(`  loaded ${vecMap.size} vectors (${DIMS}d)`);

// ---------- preprocess: center + remove dominant principal component ----------
LOG('Preprocessing vectors (center, remove dominant PC, L2 normalise)…');
let X = new Float32Array(words.length * DIMS);
for (let i = 0; i < words.length; i++) {
  const v = vecMap.get(wordList[i]);
  for (let d = 0; d < DIMS; d++) X[i * DIMS + d] = v ? v[d] : 0;
}
const mean = new Float64Array(DIMS);
for (let i = 0; i < words.length; i++) for (let d = 0; d < DIMS; d++) mean[d] += X[i * DIMS + d];
for (let d = 0; d < DIMS; d++) mean[d] /= words.length;
for (let i = 0; i < words.length; i++) for (let d = 0; d < DIMS; d++) X[i * DIMS + d] -= mean[d];
// top principal direction by power iteration
const top = new Float64Array(DIMS);
for (let d = 0; d < DIMS; d++) top[d] = Math.sin(d * 12.9898 + 78.233);
for (let it = 0; it < 80; it++) {
  const next = new Float64Array(DIMS);
  for (let i = 0; i < words.length; i++) {
    let dot = 0;
    for (let d = 0; d < DIMS; d++) dot += X[i * DIMS + d] * top[d];
    for (let d = 0; d < DIMS; d++) next[d] += dot * X[i * DIMS + d];
  }
  let n = 0;
  for (let d = 0; d < DIMS; d++) n += next[d] * next[d];
  n = Math.sqrt(n) || 1;
  for (let d = 0; d < DIMS; d++) top[d] = next[d] / n;
}
for (let i = 0; i < words.length; i++) {
  let dot = 0;
  for (let d = 0; d < DIMS; d++) dot += X[i * DIMS + d] * top[d];
  let n = 0;
  for (let d = 0; d < DIMS; d++) {
    X[i * DIMS + d] -= dot * top[d];
    n += X[i * DIMS + d] * X[i * DIMS + d];
  }
  n = Math.sqrt(n) || 1;
  for (let d = 0; d < DIMS; d++) X[i * DIMS + d] /= n;
}

// ---------- PCA (linear projection) ----------
LOG('Computing 3-D PCA (linear baseline)…');
function covariance(A, n, dims) {
  const C = new Float64Array(dims * dims);
  for (let i = 0; i < n; i++) {
    const o = i * dims;
    for (let a = 0; a < dims; a++) {
      const va = A[o + a];
      for (let b = a; b < dims; b++) C[a * dims + b] += va * A[o + b];
    }
  }
  for (let a = 0; a < dims; a++) for (let b = a; b < dims; b++) {
    C[a * dims + b] /= n - 1;
    C[b * dims + a] = C[a * dims + b];
  }
  return C;
}
function matVec(C, v, dims) {
  const out = new Float64Array(dims);
  for (let a = 0; a < dims; a++) {
    let s = 0;
    const o = a * dims;
    for (let b = 0; b < dims; b++) s += C[o + b] * v[b];
    out[a] = s;
  }
  return out;
}
function orthonormalize(vecs) {
  for (let i = 0; i < vecs.length; i++) {
    for (let j = 0; j < i; j++) {
      let dot = 0;
      for (let d = 0; d < DIMS; d++) dot += vecs[i][d] * vecs[j][d];
      for (let d = 0; d < DIMS; d++) vecs[i][d] -= dot * vecs[j][d];
    }
    let n = Math.sqrt(vecs[i].reduce((s, x) => s + x * x, 0)) || 1;
    for (let d = 0; d < DIMS; d++) vecs[i][d] /= n;
  }
}
const C = covariance(X, words.length, DIMS);
const components = [];
const eigenvalues = [];
for (let c = 0; c < 3; c++) {
  let v = new Float64Array(DIMS);
  for (let d = 0; d < DIMS; d++) v[d] = Math.sin((c + 1) * 7.13 + d * 3.71) + 0.01;
  for (let it = 0; it < 160; it++) {
    const w = matVec(C, v, DIMS);
    for (const prev of components) {
      let dot = 0;
      for (let d = 0; d < DIMS; d++) dot += w[d] * prev[d];
      for (let d = 0; d < DIMS; d++) w[d] -= dot * prev[d];
    }
    let n = 0;
    for (let d = 0; d < DIMS; d++) n += w[d] * w[d];
    n = Math.sqrt(n) || 1;
    for (let d = 0; d < DIMS; d++) v[d] = w[d] / n;
  }
  const cv = matVec(C, v, DIMS);
  let lambda = 0;
  for (let d = 0; d < DIMS; d++) lambda += v[d] * cv[d];
  components.push(v); eigenvalues.push(lambda);
}
const pcaRaw = words.map((_, i) => {
  const o = i * DIMS;
  return components.map((comp) => {
    let s = 0;
    for (let d = 0; d < DIMS; d++) s += X[o + d] * comp[d];
    return s;
  });
});
const totalVar = (() => {
  let s = 0;
  for (let a = 0; a < DIMS; a++) s += C[a * DIMS + a];
  return s;
})();
const pcaVar3 = eigenvalues.reduce((a, b) => a + b, 0) / totalVar;
const pcVar = eigenvalues.map(v => v / totalVar);
LOG(`  3-D PCA variance explained: ${(pcaVar3 * 100).toFixed(1)}% (PC1 ${(pcVar[0]*100).toFixed(1)}%, PC2 ${(pcVar[1]*100).toFixed(1)}%, PC3 ${(pcVar[2]*100).toFixed(1)}%)`);

// ---------- UMAP (nonlinear, topology-aware) ----------
LOG('Running UMAP 100D → 3D (this takes a moment)…');
const t0 = Date.now();
const umap = new UMAP({
  nComponents: 3,
  nNeighbors: 22,
  minDist: 0.08,
  spread: 1.0,
  nEpochs: 700,
  random: mulberry32(424242)
});
const vectors = words.map((_, i) => Array.from(X.subarray(i * DIMS, (i + 1) * DIMS)));
const umapRaw = umap.fit(vectors);
LOG(`  UMAP done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ---------- scale both projections into a common display volume ----------
function scaleProjection(points, targetRadius = 96) {
  const n = points.length;
  const c = [0, 0, 0];
  for (const p of points) for (let d = 0; d < 3; d++) c[d] += p[d];
  for (let d = 0; d < 3; d++) c[d] /= n;
  for (const p of points) for (let d = 0; d < 3; d++) p[d] -= c[d];
  const radii = points.map(p => Math.hypot(p[0], p[1], p[2])).sort((a, b) => a - b);
  const p98 = radii[Math.floor(radii.length * 0.98)] || 1;
  const s = targetRadius / p98;
  for (const p of points) for (let d = 0; d < 3; d++) p[d] *= s;
  return points;
}
scaleProjection(pcaRaw, 94);
scaleProjection(umapRaw, 96);

// ---------- k-means in high-dimensional space ----------
LOG(`Clustering 100-D vectors into ${K} semantic constellations…`);
function kmeans(A, n, dims, k, iters = 28) {
  const centroids = [];
  // farthest-point-ish deterministic seeding starting from the least central word
  let first = 0, best = -1;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let d = 0; d < dims; d++) s += A[i * dims + d];
    const score = -Math.abs(s) + rng() * 1e-4;
    if (score > best) { best = score; first = i; }
  }
  centroids.push(Float64Array.from(A.subarray(first * dims, (first + 1) * dims)));
  const minD = new Float64Array(n).fill(1e9);
  for (let c = 1; c < k; c++) {
    const last = centroids[c - 1];
    for (let i = 0; i < n; i++) {
      let d2 = 0;
      for (let d = 0; d < dims; d++) { const diff = A[i * dims + d] - last[d]; d2 += diff * diff; }
      if (d2 < minD[i]) minD[i] = d2;
    }
    // weighted random pick among far points, deterministic
    let idx = 0, mx = -1;
    for (let i = 0; i < n; i++) { const s = minD[i] * (0.85 + rng() * 0.3); if (s > mx) { mx = s; idx = i; } }
    centroids.push(Float64Array.from(A.subarray(idx * dims, (idx + 1) * dims)));
  }
  const assign = new Int32Array(n);
  for (let iter = 0; iter < iters; iter++) {
    // assign
    for (let i = 0; i < n; i++) {
      let bj = 0, bd = 1e18;
      for (let j = 0; j < k; j++) {
        let d2 = 0;
        const c = centroids[j];
        for (let d = 0; d < dims; d++) { const diff = A[i * dims + d] - c[d]; d2 += diff * diff; }
        if (d2 < bd) { bd = d2; bj = j; }
      }
      assign[i] = bj;
    }
    // update
    const sums = Array.from({ length: k }, () => new Float64Array(dims));
    const counts = new Int32Array(k);
    for (let i = 0; i < n; i++) {
      const j = assign[i]; counts[j]++;
      const c = sums[j];
      for (let d = 0; d < dims; d++) c[d] += A[i * dims + d];
    }
    for (let j = 0; j < k; j++) {
      if (!counts[j]) continue;
      for (let d = 0; d < dims; d++) centroids[j][d] = sums[j][d] / counts[j];
    }
  }
  return { assign, centroids };
}
const { assign, centroids } = kmeans(X, words.length, DIMS, K, 32);
const clusterCounts = new Array(K).fill(0);
assign.forEach(c => clusterCounts[c]++);
// sort clusters by size, remap
const order = [...Array(K).keys()].sort((a, b) => clusterCounts[b] - clusterCounts[a]);
const remap = new Int32Array(K);
order.forEach((old, i) => remap[old] = i);
const clusterOf = Array.from(assign, c => remap[c]);
const clusterSizes = order.map(c => clusterCounts[c]);
LOG('  sizes:', clusterSizes.join(', '));

// representative words per cluster (closest to centroid, favour decent frequency)
const reps = [];
for (let j = 0; j < K; j++) {
  const old = order[j];
  const scored = [];
  for (let i = 0; i < words.length; i++) {
    if (clusterOf[i] !== j) continue;
    let dot = 0;
    for (let d = 0; d < DIMS; d++) dot += X[i * DIMS + d] * centroids[old][d];
    scored.push([dot, i]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const top = scored.slice(0, 24).map(([, i]) => wordList[i]);
  reps.push(top);
  LOG(`  cluster ${j} (${clusterSizes[j]}): ${top.slice(0, 14).join(', ')}`);
}

// ---------- kNN search in a 50-D PCA space (fast, high fidelity) ----------
LOG('Finding semantic neighbours…');
const SEARCH_DIMS = 50;
// project onto top 50 PC directions by repeated power iteration (reuse covariance)
const pcDirs = [];
for (let c = 0; c < SEARCH_DIMS; c++) {
  let v = new Float64Array(DIMS);
  for (let d = 0; d < DIMS; d++) v[d] = Math.sin((c + 2) * 3.17 + d * 1.37);
  for (let it = 0; it < 100; it++) {
    const w = matVec(C, v, DIMS);
    for (const prev of pcDirs) {
      let dot = 0;
      for (let d = 0; d < DIMS; d++) dot += w[d] * prev[d];
      for (let d = 0; d < DIMS; d++) w[d] -= dot * prev[d];
    }
    let n = 0;
    for (let d = 0; d < DIMS; d++) n += w[d] * w[d];
    n = Math.sqrt(n) || 1;
    for (let d = 0; d < DIMS; d++) v[d] = w[d] / n;
  }
  pcDirs.push(v);
}
const Y = new Float32Array(words.length * SEARCH_DIMS);
for (let i = 0; i < words.length; i++) {
  const o = i * DIMS;
  let norm = 0;
  for (let c = 0; c < SEARCH_DIMS; c++) {
    let s = 0;
    for (let d = 0; d < DIMS; d++) s += X[o + d] * pcDirs[c][d];
    Y[i * SEARCH_DIMS + c] = s;
    norm += s * s;
  }
  norm = Math.sqrt(norm) || 1;
  for (let c = 0; c < SEARCH_DIMS; c++) Y[i * SEARCH_DIMS + c] /= norm;
}
function topNeighbors(query, n, exclude) {
  const scores = [];
  for (let i = 0; i < words.length; i++) {
    if (i === exclude) continue;
    let s = 0;
    for (let d = 0; d < SEARCH_DIMS; d++) s += query[d] * Y[i * SEARCH_DIMS + d];
    scores.push([s, i]);
  }
  scores.sort((a, b) => b[0] - a[0]);
  return scores.slice(0, n);
}
const neighbors = [];
const trueNbrs = [];
for (let i = 0; i < words.length; i++) {
  const q = Y.subarray(i * SEARCH_DIMS, (i + 1) * SEARCH_DIMS);
  const ns = topNeighbors(q, 12, i);
  neighbors.push(ns.slice(0, 8));
  trueNbrs.push(new Set(ns.slice(0, 10).map(([, j]) => j)));
}
LOG('  done');

// ---------- projection fidelity (10-NN recall vs high-D) ----------
function knn3(points, i, k) {
  const [x, y, z] = points[i];
  const arr = [];
  for (let j = 0; j < points.length; j++) {
    if (j === i) continue;
    const dx = x - points[j][0], dy = y - points[j][1], dz = z - points[j][2];
    arr.push([dx * dx + dy * dy + dz * dz, j]);
  }
  arr.sort((a, b) => a[0] - b[0]);
  return new Set(arr.slice(0, k).map(([, j]) => j));
}
function recall(points, k = 10) {
  let hit = 0;
  for (let i = 0; i < points.length; i++) {
    const nn = knn3(points, i, k);
    for (const j of nn) if (trueNbrs[i].has(j)) hit++;
  }
  return hit / (points.length * k);
}
const pcaRecall = recall(pcaRaw, 10);
const umapRecall = recall(umapRaw, 10);
LOG(`  10-NN recall — PCA ${(pcaRecall*100).toFixed(1)}% | UMAP ${(umapRecall*100).toFixed(1)}%`);

// ---------- assign constellation names (edit after inspecting reps) ----------
const CLUSTER_META = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/cluster-meta.json'), 'utf8'));
const usedColors = new Set();
for (let j = 0; j < K; j++) {
  const m = CLUSTER_META.clusters[j] || {};
  if (m.name) continue;
  CLUSTER_META.clusters[j] = {
    name: `语义星群 ${String(j + 1).padStart(2, '0')}`,
    en: `Semantic cluster ${j + 1}`,
    color: ['#5eead4','#a78bfa','#fbbf24','#fb7185','#60a5fa','#a3e635','#f472b6','#22d3ee','#fb923c','#818cf8','#f87171','#2dd4bf','#c084fc','#facc15'][j % 14],
    desc: '由 100 维语义向量自动聚类得到。'
  };
}

// ---------- write graph ----------
LOG('Assembling graph.json…');
const clusters = [];
for (let j = 0; j < K; j++) {
  const m = CLUSTER_META.clusters[j];
  const pts = words.map((_, i) => i).filter(i => clusterOf[i] === j);
  const centroid3 = [0, 0, 0];
  const pcaCentroid = [0, 0, 0];
  for (const i of pts) for (let d = 0; d < 3; d++) {
    centroid3[d] += umapRaw[i][d] / pts.length;
    pcaCentroid[d] += pcaRaw[i][d] / pts.length;
  }
  clusters.push({
    id: j, name: m.name, en: m.en, desc: m.desc, color: m.color,
    count: pts.length,
    centroid: centroid3.map(v => +v.toFixed(2)),
    pcaCentroid: pcaCentroid.map(v => +v.toFixed(2)),
    samples: reps[j].slice(0, 6),
    landmarks: m.landmarks || reps[j].slice(0, 6)
  });
}
const outWords = words.map((w, i) => {
  const dict = ecdictByWord.get(w.word) || {};
  const rawDef = w.defs.join('；').replace(/\s+/g, ' ').trim();
  const translation = cleanTranslation(rawDef);
  const pos = extractPos(rawDef, dict.tag || '');
  const english = (dict.definition || '')
    .replace(/\\n/g, ' · ').replace(/\\r/g, ' ').replace(/\s+/g, ' ').trim();
  const bnc = Number(dict.bnc) || 0;
  const frq = Number(dict.frq) || 0;
  const rank = Math.min(bnc || 1e9, frq || 1e9);
  const importance = Math.min(1, Math.max(0, 1 - (Math.log10(Math.max(rank, 30)) - Math.log10(30)) / (Math.log10(22000) - Math.log10(30))));
  return {
    i,
    w: w.word,
    p: w.phonetic || cleanPhonetic(dict.phonetic),
    zh: translation,
    en: english.length > 190 ? english.slice(0, 188).trimEnd() + '…' : english,
    pos,
    bnc, frq,
    imp: +importance.toFixed(3),
    cl: clusterOf[i],
    u: umapRaw[i].map(v => +v.toFixed(2)),
    a: pcaRaw[i].map(v => +v.toFixed(2)),
    nb: neighbors[i].map(([s, j]) => [j, +s.toFixed(3)])
  };
});
// sort words alphabetically for convenient search, but keep an original index map
const alpha = outWords.slice().sort((a, b) => a.w.localeCompare(b.w)).map(w => w.i);
const meta = {
  title: '词穹 Word Cosmos',
  subtitle: '考研英语 5500 · 3D 语义知识图谱',
  total: outWords.length,
  dims: DIMS,
  projection: {
    primary: 'UMAP',
    primaryParams: { nNeighbors: 22, minDist: 0.08, nEpochs: 700, nComponents: 3 },
    linear: 'PCA',
    pcaVariance3D: +(pcaVar3 * 100).toFixed(2),
    pcaComponents: pcVar.map(v => +(v * 100).toFixed(2)),
    umapRecall10: +(umapRecall * 100).toFixed(1),
    pcaRecall10: +(pcaRecall * 100).toFixed(1)
  },
  sources: {
    words: 'NPEE 考研英语大纲词表 + ECDICT 补充',
    vectors: 'GloVe wiki-gigaword 100d',
    projection: 'UMAP (cosine-friendly, local topology) · PCA (linear baseline)',
    licenses: 'ECDICT: MIT · GloVe: Public domain · UMAP-js: Apache-2.0'
  },
  generated: new Date().toISOString(),
  clusters,
  alpha
};
fs.writeFileSync(path.join(OUT, 'graph.json'), JSON.stringify({ meta, words: outWords }));
fs.writeFileSync(path.join(OUT, 'build-report.json'), JSON.stringify({
  meta, clusterSamples: reps,
  sizes: clusterSizes,
  generated: new Date().toISOString()
}, null, 2));
LOG(`Wrote ${(fs.statSync(path.join(OUT, 'graph.json')).size / 1e6).toFixed(2)} MB graph.json`);
LOG('Done.');

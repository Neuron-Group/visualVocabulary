import './style.css';
import { Atlas } from './atlas.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const els = {
  canvas: $('#scene'),
  labels: $('#labels'),
  loader: $('#loader'),
  loaderBar: $('#loaderBar'),
  loaderStatus: $('#loaderStatus'),
  searchBox: $('#searchBox'),
  searchInput: $('#searchInput'),
  searchResults: $('#searchResults'),
  clusterList: $('#clusterList'),
  clusterPanel: $('#constellationPanel'),
  clusterToggle: $('#clusterToggle'),
  detailPanel: $('#detailPanel'),
  detailContent: $('#detailContent'),
  detailClose: $('#detailClose'),
  hoverTip: $('#hoverTip'),
  toast: $('#toast'),
  projectionMeta: $('#projectionMeta'),
  randomBtn: $('#randomBtn'),
  helpBtn: $('#helpBtn'),
  helpDialog: $('#helpDialog'),
  helpClose: $('#helpClose'),
  aboutLink: $('#aboutLink'),
  resetClusters: $('#resetClusters'),
  wordCount: $('#wordCount'),
  switchEl: $('.projection-switch')
};

const state = {
  data: null,
  words: [],
  meta: null,
  atlas: null,
  selected: -1,
  cluster: -1,
  hover: -1,
  fam: loadFamiliarity(),
  searchActive: 0,
  searchItems: [],
  projection: 'umap',
  toastTimer: null,
  searchTimer: null
};

function loadFamiliarity() {
  try {
    const raw = localStorage.getItem('wordcosmos.familiarity.v1');
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}
function saveFamiliarity() {
  try { localStorage.setItem('wordcosmos.familiarity.v1', JSON.stringify(state.fam)); } catch { /* private mode */ }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function highlight(text, query) {
  const safe = escapeHtml(text);
  if (!query) return safe;
  try {
    return safe.replace(new RegExp(`(${escapeRegExp(query)})`, 'ig'), '<mark>$1</mark>');
  } catch { return safe; }
}
function shortZh(zh, max = 24) {
  let s = String(zh || '').replace(/\b(vt|vi|v|n|a|adj|ad|adv|prep|pron|conj|num|art|int)\./gi, ' ');
  s = s.replace(/；/g, ' · ').replace(/\s+/g, ' ').trim();
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + '…';
  return s;
}
function posHtml(zh) {
  const safe = escapeHtml(zh);
  return safe.replace(/(^|[；;]\s*)(vt|vi|v|n|a|adj|ad|adv|prep|pron|conj|num|art|int)\./g, (m, pre, pos) => `${pre}<span class="pos-inline">${pos}.</span>`);
}
function rank(value) {
  return value ? Number(value).toLocaleString('en-US') : '—';
}
function clusterOf(w) {
  return state.meta.clusters[w.cl] || state.meta.clusters[0];
}
function setProgress(value, status) {
  if (els.loaderBar) els.loaderBar.style.width = `${Math.round(value)}%`;
  if (status && els.loaderStatus) els.loaderStatus.textContent = status;
}
function showToast(message, duration = 2200) {
  clearTimeout(state.toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add('is-visible');
  state.toastTimer = setTimeout(() => els.toast.classList.remove('is-visible'), duration);
}

async function fetchGraphWithProgress() {
  const url = new URL('data/graph.json', document.baseURI);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} — 无法读取图谱数据`);
  const total = Number(res.headers.get('content-length') || 0);
  if (!res.body || !total) {
    setProgress(32, '正在解析词义坐标');
    return res.json();
  }
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    const pct = 8 + (received / total) * 55;
    setProgress(pct, `正在装载语义坐标 · ${(received / 1e6).toFixed(1)} MB`);
  }
  const blob = new Blob(chunks);
  const text = await blob.text();
  setProgress(63, '正在解析 5,500 个词义坐标');
  return JSON.parse(text);
}

function initUi() {
  const { meta, words } = state.data;
  state.meta = meta;
  state.words = words;
  els.wordCount.textContent = meta.total.toLocaleString('en-US');
  $('#helpTotal').textContent = meta.total.toLocaleString('en-US');
  $('#helpUmapRecall').textContent = `${meta.projection.umapRecall10}%`;
  $('#helpPcaVar').textContent = `${meta.projection.pcaVariance3D}%`;

  // brand counts and cluster list
  buildClusterList();
  updateProjectionUi(meta.projection.primary === 'UMAP' ? 'umap' : 'pca');

  els.clusterList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cluster]');
    if (!btn) return;
    const id = Number(btn.dataset.cluster);
    if (state.cluster === id) {
      resetFocus();
    } else {
      focusCluster(id);
    }
  });

  els.clusterToggle?.addEventListener('click', () => {
    els.clusterPanel.classList.toggle('is-open');
    if (els.clusterPanel.classList.contains('is-open')) {
      closeDetail();
    }
  });

  els.resetClusters.addEventListener('click', resetFocus);
  els.detailClose.addEventListener('click', closeDetail);

  els.detailContent.addEventListener('click', onDetailClick);
  els.detailContent.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      const btn = e.target.closest('button');
      if (btn) { e.preventDefault(); btn.click(); }
    }
  });

  els.searchInput.addEventListener('focus', () => {
    renderSearch(els.searchInput.value);
  });
  els.searchInput.addEventListener('input', () => {
    state.searchActive = 0;
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => renderSearch(els.searchInput.value), 55);
  });
  els.searchInput.addEventListener('keydown', onSearchKeydown);
  els.searchResults.addEventListener('pointerdown', (e) => e.preventDefault());
  els.searchResults.addEventListener('click', (e) => {
    const result = e.target.closest('[data-index]');
    if (result) {
      openWord(Number(result.dataset.index), { fly: true, source: 'search' });
      closeSearch();
      return;
    }
    const hint = e.target.closest('[data-query]');
    if (hint) {
      els.searchInput.value = hint.dataset.query;
      els.searchInput.focus();
      renderSearch(hint.dataset.query);
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (!els.searchBox.contains(e.target)) closeSearch();
  });

  els.randomBtn.addEventListener('click', randomWord);
  els.helpBtn.addEventListener('click', openHelp);
  els.aboutLink.addEventListener('click', openHelp);
  els.helpClose.addEventListener('click', () => els.helpDialog.close());
  els.helpDialog.addEventListener('click', (e) => {
    if (e.target === els.helpDialog) els.helpDialog.close();
  });

  $$('.proj-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchProjection(btn.dataset.projection));
  });

  window.addEventListener('pointermove', (e) => {
    if (state.hover >= 0) positionTip(e.clientX, e.clientY);
  }, { passive: true });

  // Mobile placeholder
  if (window.innerWidth < 560) els.searchInput.placeholder = '搜索单词 / 释义';
}

function buildClusterList() {
  const html = state.meta.clusters.map((c) => `
    <button class="cluster-item" role="listitem" data-cluster="${c.id}" style="--c:${c.color}">
      <span class="cl-dot"></span>
      <span class="cl-name">${escapeHtml(c.name)}</span>
      <span class="cl-count">${c.count}</span>
    </button>
  `).join('');
  els.clusterList.innerHTML = html;
}

function updateClusterList() {
  $$('.cluster-item', els.clusterList).forEach((btn) => {
    btn.classList.toggle('is-active', Number(btn.dataset.cluster) === state.cluster);
  });
}

function updateProjectionUi(p) {
  state.projection = p;
  els.switchEl.classList.toggle('is-pca', p === 'pca');
  $$('.proj-btn').forEach((btn) => {
    const active = btn.dataset.projection === p;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  if (p === 'umap') {
    els.projectionMeta.textContent = `局部邻域保持 · 10-NN ${state.meta.projection.umapRecall10}%`;
  } else {
    els.projectionMeta.textContent = `线性主轴 · 方差解释 ${state.meta.projection.pcaVariance3D}%`;
  }
}

function switchProjection(p) {
  if (p === state.projection) return;
  state.atlas.setProjection(p, { animate: true });
  updateProjectionUi(p);
  showToast(p === 'umap' ? '已切换至 UMAP · 拓扑投影' : '已切换至 PCA · 线性投影');
}

function initAtlas() {
  state.atlas = new Atlas({
    canvas: els.canvas,
    labelsEl: els.labels,
    data: state.data,
    onHover: handleHover,
    onSelect: handleSelect,
    onHint: () => {}
  });
  window.cosmos = {
    atlas: state.atlas,
    state,
    openWord,
    focusCluster,
    resetFocus
  };
}

function handleHover(index) {
  if (index < 0) {
    state.hover = -1;
    els.hoverTip.classList.remove('is-visible');
    return;
  }
  state.hover = index;
  const w = state.words[index];
  if (!w) return;
  const c = clusterOf(w);
  els.hoverTip.innerHTML = `
    <div><span class="ht-word">${escapeHtml(w.w)}</span><span class="ht-ipa">${escapeHtml(w.p || '')}</span></div>
    <div class="ht-zh">${escapeHtml(shortZh(w.zh, 48))}</div>
    <div class="ht-hint" style="color:${c.color}">点击潜入 · ${escapeHtml(c.name)}</div>
  `;
  els.hoverTip.classList.add('is-visible');
  if (state.atlas?.pointer) positionTip(state.atlas.pointer.x, state.atlas.pointer.y);
}

function positionTip(x, y) {
  if (!els.hoverTip.classList.contains('is-visible')) return;
  const pad = 12;
  const w = els.hoverTip.offsetWidth || 220;
  const h = els.hoverTip.offsetHeight || 64;
  let left = x + 17;
  let top = y + 19;
  if (left + w > window.innerWidth - pad) left = x - w - 17;
  if (top + h > window.innerHeight - pad) top = y - h - 17;
  els.hoverTip.style.left = `${clamp(left, pad, window.innerWidth - w - pad)}px`;
  els.hoverTip.style.top = `${clamp(top, pad, window.innerHeight - h - pad)}px`;
}

function handleSelect(index, info = {}) {
  if (index < 0) {
    if (info.source === 'escape') closeDetail();
    return;
  }
  openWord(index, { fly: true, source: info.source || 'canvas' });
}

function openWord(index, { fly = true, source = '' } = {}) {
  const w = state.words[index];
  if (!w) return;
  state.selected = index;
  state.cluster = -1;
  updateClusterList();
  els.clusterPanel.classList.remove('is-open');
  els.detailPanel.classList.add('is-open');
  els.detailPanel.style.setProperty('--accent', clusterOf(w).color);
  state.atlas.selectWord(index, { fly });
  renderWordDetail(w);
  if (source === 'random') showToast(`随机漫游 · ${w.w}`, 1700);
}

function renderWordDetail(w) {
  const c = clusterOf(w);
  const currentFam = state.fam[w.w] ?? -1;
  const fam = [
    { level: -1, label: '未标记' },
    { level: 0, label: '陌生', color: '#fb7185' },
    { level: 1, label: '眼熟', color: '#fbbf24' },
    { level: 2, label: '掌握', color: '#34d399' }
  ];
  const famButtons = [
    { level: 0, label: '陌生', color: '#fb7185' },
    { level: 1, label: '眼熟', color: '#fbbf24' },
    { level: 2, label: '掌握', color: '#34d399' }
  ].map(f => `
    <button class="fam-btn" data-action="familiarity" data-level="${f.level}" style="--fam:${f.color}" aria-pressed="${currentFam === f.level}">
      ${f.label}
    </button>
  `).join('');

  const neighbors = (w.nb || []).slice(0, 6).map(([j, sim]) => {
    const n = state.words[j];
    if (!n) return '';
    const nc = clusterOf(n);
    return `
      <button class="neighbor-item" data-action="neighbor" data-index="${j}" style="--c:${nc.color}; --w:${Math.max(7, sim * 100).toFixed(0)}%">
        <span class="nb-top">
          <span class="nb-word">${escapeHtml(n.w)}</span>
          <span class="nb-zh">${escapeHtml(shortZh(n.zh, 18))}</span>
        </span>
        <span class="nb-sim"><span>${sim.toFixed(2)}</span><span class="nb-bar"><i></i></span></span>
      </button>
    `;
  }).join('');

  els.detailContent.innerHTML = `
    <div class="d-eyebrow">
      <span class="index">${String(w.i + 1).padStart(4, '0')} / ${state.meta.total}</span>
      <span>${w.pos?.length ? escapeHtml(w.pos.join(' · ')) : 'ENTRY'}</span>
    </div>
    <div class="d-word-line">
      <h2 class="d-word">${escapeHtml(w.w)}</h2>
      <button class="d-speak" data-action="speak" title="朗读单词" aria-label="朗读 ${escapeHtml(w.w)}">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M11 5.5L6.9 9H4v6h2.9l4.1 3.5V5.5z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/><path d="M15.2 9.1a4 4 0 010 5.8M17.6 6.8a7.3 7.3 0 010 10.4" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>
      </button>
    </div>
    <div class="d-phonetic">
      <span>${w.p ? `/ ${escapeHtml(w.p)} /` : '音标未收录'}</span>
      ${(w.pos || []).map(p => `<span class="pos-chip">${escapeHtml(p)}</span>`).join('')}
    </div>
    <div class="d-cluster" style="--c:${c.color}">
      <i></i>${escapeHtml(c.name)}<span>${escapeHtml(c.en)}</span>
    </div>
    <div class="d-translation">${posHtml(w.zh || '暂无释义')}</div>
    ${w.en ? `<p class="d-en">${escapeHtml(w.en)}</p>` : ''}
    <div class="d-stats">
      <div class="stat"><div class="s-label">BNC RANK</div><div class="s-value">${rank(w.bnc)}</div></div>
      <div class="stat"><div class="s-label">COCA RANK</div><div class="s-value">${rank(w.frq)}</div></div>
      <div class="stat"><div class="s-label">CLUSTER</div><div class="s-value" style="color:${c.color}">${escapeHtml(c.name)}</div></div>
    </div>
    <div class="d-familiarity">
      <div class="mini-eyebrow">MY FAMILIARITY <span>仅保存在本地</span></div>
      <div class="fam-btns">${famButtons}</div>
    </div>
    <div class="d-neighbors">
      <div class="nb-head"><b>语义近邻</b><span>COSINE · 100D</span></div>
      <div class="neighbor-list">${neighbors || '<div class="detail-empty">没有近邻数据</div>'}</div>
    </div>
  `;

  // small polish: keep scroll at top when switching entries
  els.detailPanel.scrollTop = 0;
}

function onDetailClick(e) {
  const target = e.target.closest('[data-action]');
  const sample = e.target.closest('[data-word]');
  if (sample && !target) {
    const idx = state.words.findIndex(w => w.w === sample.dataset.word);
    if (idx >= 0) openWord(idx);
    return;
  }
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'speak') {
    speak(state.words[state.selected]?.w);
  } else if (action === 'neighbor') {
    openWord(Number(target.dataset.index));
  } else if (action === 'familiarity') {
    toggleFamiliarity(Number(target.dataset.level));
  } else if (action === 'cluster-random') {
    const pool = state.words.filter(w => w.cl === state.cluster);
    if (pool.length) {
      const pick = pool[Math.floor(Math.random() * pool.length)];
      openWord(pick.i, { fly: true, source: 'random' });
    }
  } else if (action === 'reset-focus') {
    resetFocus();
  }
}

function toggleFamiliarity(level) {
  const w = state.words[state.selected];
  if (!w) return;
  if (state.fam[w.w] === level) delete state.fam[w.w];
  else state.fam[w.w] = level;
  saveFamiliarity();
  $$('.fam-btn', els.detailContent).forEach((btn) => {
    btn.setAttribute('aria-pressed', String(Number(btn.dataset.level) === (state.fam[w.w] ?? -1)));
  });
  const labels = ['陌生', '眼熟', '掌握'];
  if (state.fam[w.w] !== undefined) {
    showToast(`已标记 · ${w.w} → ${labels[state.fam[w.w]]}`, 1500);
  } else {
    showToast(`已清除标记 · ${w.w}`, 1500);
  }
}

function speak(word) {
  if (!word) return;
  if (!('speechSynthesis' in window)) {
    showToast('当前浏览器不支持语音朗读');
    return;
  }
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(word);
    u.lang = 'en-US';
    u.rate = 0.82;
    u.pitch = 1;
    window.speechSynthesis.speak(u);
  } catch {
    showToast('语音朗读暂不可用');
  }
}

function focusCluster(id, { fly = true } = {}) {
  const c = state.meta.clusters[id];
  if (!c) return;
  state.cluster = id;
  state.selected = -1;
  updateClusterList();
  state.atlas.focusOnCluster(id, { fly });
  els.detailPanel.classList.add('is-open');
  els.detailPanel.style.setProperty('--accent', c.color);
  renderClusterDetail(c);
  if (window.innerWidth <= 860) {
    setTimeout(() => els.clusterPanel.classList.remove('is-open'), 120);
  }
}

function renderClusterDetail(c) {
  const samples = c.samples.map((word) => {
    const idx = state.words.findIndex(w => w.w === word);
    return idx >= 0 ? `<button class="sample-chip" data-word="${escapeHtml(word)}">${escapeHtml(word)}</button>` : '';
  }).join('');
  els.detailContent.innerHTML = `
    <div class="cluster-detail">
      <div class="cd-eyebrow">CONSTELLATION ${String(c.id + 1).padStart(2, '0')} / 14</div>
      <h2 class="cd-title" style="--c:${c.color}">${escapeHtml(c.name)}</h2>
      <p class="cd-en">${escapeHtml(c.en)}</p>
      <p class="cd-desc">${escapeHtml(c.desc)}</p>
      <div class="cd-stat" style="--c:${c.color}"><b>${c.count}</b><span>WORDS IN THIS REGION</span></div>
      <div class="cd-samples">
        <div class="mini-eyebrow">REPRESENTATIVE WORDS <span>聚类质心近旁</span></div>
        <div class="sample-chips">${samples}</div>
      </div>
      <button class="cd-focus-btn" data-action="cluster-random" style="--c:${c.color}">从这个星群随机漫游 →</button>
      <div style="margin-top:9px"><button class="mini-link" data-action="reset-focus">取消聚焦 · 回到全景</button></div>
    </div>
  `;
  els.detailPanel.scrollTop = 0;
}

function resetFocus() {
  state.cluster = -1;
  state.selected = -1;
  updateClusterList();
  els.detailPanel.classList.remove('is-open');
  els.clusterPanel.classList.remove('is-open');
  state.atlas.clearFocus({ fly: true });
  closeSearch();
}

function closeDetail() {
  state.selected = -1;
  state.cluster = -1;
  updateClusterList();
  els.detailPanel.classList.remove('is-open');
  state.atlas.selectWord(-1);
  closeSearch();
}

function randomWord() {
  if (!state.words.length) return;
  let i = Math.floor(Math.random() * state.words.length);
  if (state.words.length > 1) {
    for (let tries = 0; tries < 8 && i === state.selected; tries++) i = Math.floor(Math.random() * state.words.length);
  }
  openWord(i, { fly: true, source: 'random' });
}

function openHelp() {
  if (!els.helpDialog.open) els.helpDialog.showModal();
  closeSearch();
}

function closeHelp() {
  if (els.helpDialog.open) els.helpDialog.close();
}

/* ---------------- search ---------------- */
function getSearchResults(rawQuery) {
  const q = String(rawQuery || '').trim().toLowerCase();
  if (!q) return [];
  const results = [];
  for (let i = 0; i < state.words.length; i++) {
    const w = state.words[i];
    let score = 0;
    const word = w.w.toLowerCase();
    if (word === q) score = 1000;
    else if (word.startsWith(q)) score = 650 - Math.min(80, (word.length - q.length) * 7);
    else if (word.includes(q)) score = 460 - Math.min(90, word.indexOf(q) * 9);
    if (w.zh && w.zh.toLowerCase().includes(q)) score = Math.max(score, 300 + Math.min(55, q.length * 3));
    if (w.en && w.en.toLowerCase().includes(q)) score = Math.max(score, 160);
    if (w.p && w.p.toLowerCase().includes(q)) score = Math.max(score, 100);
    if (score > 0) {
      score += (w.imp || 0) * 26 - Math.min(18, (w.bnc || 30000) / 6000);
      results.push({ i, score });
    }
  }
  results.sort((a, b) => b.score - a.score || (state.words[a.i].bnc || 9e9) - (state.words[b.i].bnc || 9e9));
  return results.slice(0, 10).map(r => r.i);
}

function renderSearch(query) {
  if (document.activeElement !== els.searchInput && !els.searchBox.classList.contains('is-open')) return;
  const q = String(query || '').trim();
  els.searchBox.classList.add('is-open');
  if (!q) {
    els.searchResults.innerHTML = `
      <div class="search-empty">
        搜索 <b>单词</b>、<b>中文释义</b> 或音标。也可以从一个词开始漫游：
        <div class="search-hints">
          <button data-query="abandon">abandon</button>
          <button data-query="经济">经济</button>
          <button data-query="情感">情感</button>
          <button data-query="环境">环境</button>
          <button data-query="sustain">sustain</button>
        </div>
      </div>`;
    state.searchItems = [];
    state.searchActive = 0;
    return;
  }
  const items = getSearchResults(q);
  state.searchItems = items;
  state.searchActive = 0;
  if (!items.length) {
    els.searchResults.innerHTML = `
      <div class="search-empty">
        没有找到 <b>${escapeHtml(q)}</b>。试试更短的词，或搜索中文释义。
        <div class="search-hints">
          <button data-query="abandon">abandon</button>
          <button data-query="经济">经济</button>
          <button data-query="情感">情感</button>
        </div>
      </div>`;
    return;
  }
  els.searchResults.innerHTML = items.map((i, k) => {
    const w = state.words[i];
    const c = clusterOf(w);
    return `
      <button class="search-result ${k === 0 ? 'is-selected' : ''}" role="option" data-index="${i}" style="--c:${c.color}">
        <span class="sr-main">
          <span class="sr-word">${highlight(w.w, q)}</span>
          <span class="sr-ipa">${escapeHtml(w.p || '')}</span>
        </span>
        <span class="sr-cl">${escapeHtml(c.name)}</span>
        <span class="sr-zh">${highlight(shortZh(w.zh, 54), q)}</span>
      </button>
    `;
  }).join('');
}

function onSearchKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeSearch();
    els.searchInput.blur();
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!state.searchItems.length) return;
    e.preventDefault();
    if (e.key === 'ArrowDown') state.searchActive = (state.searchActive + 1) % state.searchItems.length;
    else state.searchActive = (state.searchActive - 1 + state.searchItems.length) % state.searchItems.length;
    $$('.search-result', els.searchResults).forEach((el, k) => el.classList.toggle('is-selected', k === state.searchActive));
    return;
  }
  if (e.key === 'Enter') {
    if (!state.searchItems.length) return;
    e.preventDefault();
    const idx = state.searchItems[state.searchActive] ?? state.searchItems[0];
    openWord(idx, { fly: true, source: 'search' });
    closeSearch();
    els.searchInput.blur();
  }
}

function closeSearch() {
  els.searchBox.classList.remove('is-open');
  state.searchItems = [];
  state.searchActive = 0;
}

async function boot() {
  setProgress(6, '正在连接词义宇宙');
  try {
    const data = await fetchGraphWithProgress();
    state.data = data;
    state.words = data.words;
    state.meta = data.meta;
    setProgress(70, '正在校准 14 个语义星群');
    initUi();
    await sleep(180);
    setProgress(84, '正在展开 3D 词义空间');
    initAtlas();
    setProgress(96, '正在点亮 5,500 颗词义坐标');
    await sleep(260);
    setProgress(100, '坐标已就绪 · 进入词穹');
    await sleep(280);
    els.loader.classList.add('is-done');
    document.body.classList.remove('is-loading');
    setTimeout(() => { els.loader.style.display = 'none'; }, 1100);
    setTimeout(() => {
      state.atlas.start();
      state.atlas.beginIntro();
    }, 90);
    setTimeout(() => {
      showToast('拖动环视 · 滚轮潜入 · 点击任意词', 3000);
    }, 2600);
  } catch (err) {
    console.error(err);
    els.loader.classList.add('is-error');
    els.loaderStatus.innerHTML = `无法进入词穹。<br>${escapeHtml(err.message || '未知错误')}<br><br>请确认浏览器支持 WebGL，并通过本地服务器运行（npm run dev），而不是直接打开 index.html。`;
    setProgress(0, '');
  }
}

boot();

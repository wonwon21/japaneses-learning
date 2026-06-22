'use strict';

// ── UTF-8 safe base64 ──────────────────────────────────────────────────────
function decodeB64(str) {
  const bytes = Uint8Array.from(atob(str.replace(/\n/g, '')), c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function encodeB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach(b => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

// ── GitHub API ─────────────────────────────────────────────────────────────
class GitHub {
  constructor() {
    this.token  = localStorage.getItem('gh_token')  || '';
    this.owner  = localStorage.getItem('gh_owner')  || 'wonwon21';
    this.repo   = localStorage.getItem('gh_repo')   || 'japaneses-learning';
    this.branch = localStorage.getItem('gh_branch') || 'main';
  }

  persist() {
    localStorage.setItem('gh_token',  this.token);
    localStorage.setItem('gh_owner',  this.owner);
    localStorage.setItem('gh_repo',   this.repo);
    localStorage.setItem('gh_branch', this.branch);
  }

  get ok() { return !!(this.token && this.owner && this.repo); }

  async _req(url, opts = {}) {
    const r = await fetch(url, {
      ...opts,
      headers: {
        Authorization:  `token ${this.token}`,
        Accept:         'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
    if (!r.ok) {
      const msg = await r.text().catch(() => r.statusText);
      throw new Error(`GitHub ${r.status}: ${msg}`);
    }
    return r.json();
  }

  _base() { return `https://api.github.com/repos/${this.owner}/${this.repo}`; }

  async getFile(path) {
    const d = await this._req(`${this._base()}/contents/${path}?ref=${this.branch}`);
    return { text: decodeB64(d.content), sha: d.sha };
  }

  async getJSON(path) {
    const { text, sha } = await this.getFile(path);
    return { data: JSON.parse(text), sha };
  }

  async putFile(path, text, sha, msg) {
    return this._req(`${this._base()}/contents/${path}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: msg || `update ${path}`,
        content: encodeB64(text),
        sha,
        branch: this.branch,
      }),
    });
  }

  async putJSON(path, data, sha, msg) {
    return this.putFile(path, JSON.stringify(data, null, 2) + '\n', sha, msg);
  }

  async ls(dir) {
    return this._req(`${this._base()}/contents/${dir}?ref=${this.branch}`);
  }

  async ping() {
    try { await this._req(`${this._base()}`); return true; }
    catch { return false; }
  }
}

// ── SRS ───────────────────────────────────────────────────────────────────
const INTERVALS = [1, 3, 7, 14, 30, 60]; // by correct_streak index

function isDue(card) {
  return !card.next_review_date || card.next_review_date <= todayStr();
}

function applyAnswer(card, correct) {
  const c = Object.assign({}, card);
  delete c._type; // runtime-only field
  c.total_seen    = (c.total_seen || 0) + 1;
  if (correct) {
    c.total_correct  = (c.total_correct || 0) + 1;
    c.correct_streak = (c.correct_streak || 0) + 1;
    c.interval_days  = INTERVALS[Math.min(c.correct_streak - 1, INTERVALS.length - 1)];
  } else {
    c.correct_streak = 0;
    c.interval_days  = 1;
  }
  const d = new Date();
  d.setDate(d.getDate() + c.interval_days);
  c.next_review_date = d.toISOString().split('T')[0];
  return c;
}

// ── Hiragana data ─────────────────────────────────────────────────────────
const HIRAGANA = [
  {c:'ア',r:'a'},{c:'イ',r:'i'},{c:'ウ',r:'u'},{c:'エ',r:'e'},{c:'オ',r:'o'},
  {c:'カ',r:'ka'},{c:'キ',r:'ki'},{c:'ク',r:'ku'},{c:'ケ',r:'ke'},{c:'コ',r:'ko'},
  {c:'サ',r:'sa'},{c:'シ',r:'shi'},{c:'ス',r:'su'},{c:'セ',r:'se'},{c:'ソ',r:'so'},
  {c:'タ',r:'ta'},{c:'チ',r:'chi'},{c:'ツ',r:'tsu'},{c:'テ',r:'te'},{c:'ト',r:'to'},
  {c:'ナ',r:'na'},{c:'ニ',r:'ni'},{c:'ヌ',r:'nu'},{c:'ネ',r:'ne'},{c:'ノ',r:'no'},
  {c:'ハ',r:'ha'},{c:'ヒ',r:'hi'},{c:'フ',r:'fu'},{c:'ヘ',r:'he'},{c:'ホ',r:'ho'},
  {c:'マ',r:'ma'},{c:'ミ',r:'mi'},{c:'ム',r:'mu'},{c:'メ',r:'me'},{c:'モ',r:'mo'},
  {c:'ヤ',r:'ya'},{c:'ユ',r:'yu'},{c:'ヨ',r:'yo'},
  {c:'ラ',r:'ra'},{c:'リ',r:'ri'},{c:'ル',r:'ru'},{c:'レ',r:'re'},{c:'ロ',r:'ro'},
  {c:'ワ',r:'wa'},{c:'ヲ',r:'wo'},{c:'ン',r:'n'},
];

// ── State ─────────────────────────────────────────────────────────────────
const gh = new GitHub();

const S = {
  // cached repo data
  vocab: null, vocabSha: null,
  grammar: null, grammarSha: null,
  kana: null, kanaSha: null,
  lessonFiles: null,
  refFiles: null,
  // review session
  rq: [], ri: 0, rResults: [], rFlipped: false, rMode: 'all', rAll: false,
  // kana session
  kq: [], ki: 0, kFlipped: false,
  // detail views
  lessonName: null, lessonText: null,
  refName: null, refText: null,
};

// ── Router ────────────────────────────────────────────────────────────────
function route() {
  const h = window.location.hash.slice(1);
  return h || '/';
}

function go(path) { window.location.hash = path; }
window.go = go;

window.addEventListener('hashchange', render);

// ── Render ────────────────────────────────────────────────────────────────
async function render() {
  const r = route();
  setActiveNav(r);

  if (!gh.ok && r !== '/settings') {
    paint(settingsPage(true));
    bindSettings();
    return;
  }

  if (r === '/review') S.rAll = false; // nav-triggered reset; quiz buttons set rAll before calling reviewPage() directly

  paint('<div class="loading">로딩 중...</div>');

  try {
    let html;
    if      (r === '/')          html = await homePage();
    else if (r === '/review')    html = await reviewPage();
    else if (r === '/kana')      html = await kanaPage();
    else if (r === '/vocab')     html = await vocabPage();
    else if (r === '/grammar')   html = await grammarPage();
    else if (r === '/lessons')   html = await lessonsPage();
    else if (r === '/reference') html = await referencePage();
    else if (r === '/music')     html = await musicPage();
    else if (r === '/settings')  html = settingsPage(false);
    else                         html = '<p>페이지를 찾을 수 없습니다.</p>';
    paint(html);
    bind(r);
  } catch (e) {
    paint(`<div class="alert alert-error">오류: ${escHtml(e.message)}</div>`);
  }
}

function paint(html) { document.getElementById('content').innerHTML = html; }

function setActiveNav(r) {
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.route === r);
  });
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Data helpers ──────────────────────────────────────────────────────────
async function loadVocab(force) {
  if (!S.vocab || force) {
    const { data, sha } = await gh.getJSON('srs/vocab.json');
    S.vocab = data; S.vocabSha = sha;
  }
  return S.vocab;
}

async function loadGrammar(force) {
  if (!S.grammar || force) {
    const { data, sha } = await gh.getJSON('srs/grammar.json');
    S.grammar = data; S.grammarSha = sha;
  }
  return S.grammar;
}

async function loadKana(force) {
  if (!S.kana || force) {
    const { data, sha } = await gh.getJSON('srs/kana_weak.json');
    S.kana = data; S.kanaSha = sha;
  }
  return S.kana;
}

// ── Home ──────────────────────────────────────────────────────────────────
async function homePage() {
  const [vocab, grammar] = await Promise.all([loadVocab(), loadGrammar()]);
  const vDue = vocab.cards.filter(isDue).length;
  const gDue = grammar.cards.filter(isDue).length;
  const due  = vDue + gDue;

  const totalSeen    = vocab.cards.reduce((s,c) => s + (c.total_seen    || 0), 0);
  const totalCorrect = vocab.cards.reduce((s,c) => s + (c.total_correct || 0), 0);
  const acc = totalSeen ? Math.round(totalCorrect / totalSeen * 100) : 0;

  const dueColor = due > 0 ? 'var(--warning)' : 'var(--success)';

  return `
<h1 class="page-title">🏠 오늘의 학습</h1>

<div class="stats-grid">
  <div class="stat-card">
    <div class="stat-num" style="color:${dueColor}">${due}</div>
    <div class="stat-label">오늘 복습 카드</div>
  </div>
  <div class="stat-card">
    <div class="stat-num">${vocab.cards.length}</div>
    <div class="stat-label">총 단어</div>
  </div>
  <div class="stat-card">
    <div class="stat-num">${grammar.cards.length}</div>
    <div class="stat-label">총 문법</div>
  </div>
  <div class="stat-card">
    <div class="stat-num">${acc}%</div>
    <div class="stat-label">단어 정확도</div>
  </div>
</div>

${due > 0 ? `
<div style="background:var(--surface);border:1px solid var(--accent);border-radius:12px;padding:20px;margin-bottom:24px">
  <div style="font-weight:700;margin-bottom:6px">📬 복습 대기 중</div>
  <div style="color:var(--dim);font-size:14px;margin-bottom:16px">단어 ${vDue}개 · 문법 ${gDue}개</div>
  <button class="btn btn-primary" onclick="go('/review')">지금 복습하기 →</button>
</div>
` : `
<div style="background:var(--surface);border:1px solid var(--success);border-radius:12px;padding:20px;margin-bottom:24px">
  <div style="font-weight:700;color:var(--success)">✅ 오늘 복습 완료!</div>
  <div style="color:var(--dim);font-size:14px;margin-top:4px">다음 복습은 내일이에요.</div>
</div>
`}

<div style="color:var(--dim);font-size:13px;margin-bottom:10px">빠른 이동</div>
<div class="quick-grid">
  <button class="btn btn-secondary" onclick="go('/kana')">あ 가나 워밍업</button>
  <button class="btn btn-secondary" onclick="go('/vocab')">📖 단어장</button>
  <button class="btn btn-secondary" onclick="go('/lessons')">📅 레슨 로그</button>
  <button class="btn btn-secondary" onclick="go('/reference')">📚 레퍼런스</button>
</div>`;
}

// ── Review ────────────────────────────────────────────────────────────────
async function reviewPage() {
  const [vocab, grammar] = await Promise.all([loadVocab(), loadGrammar()]);

  // Always rebuild queue on page entry
  const filterFn = S.rAll ? () => true : isDue;
  const dv = vocab.cards.filter(filterFn).map(c => Object.assign({}, c, { _type: 'vocab' }));
  const dg = grammar.cards.filter(filterFn).map(c => Object.assign({}, c, { _type: 'grammar' }));
  const allCards = S.rMode === 'vocab'   ? dv
                 : S.rMode === 'grammar' ? dg
                 : [...dv, ...dg].sort(() => Math.random() - 0.5);
  S.rq = allCards;
  S.ri = 0; S.rResults = []; S.rFlipped = false;

  if (S.rq.length === 0) {
    const msg = S.rAll ? '카드가 없습니다.' : '오늘 복습할 카드 없어요!';
    const sub = S.rAll ? '' : '내일 또 만나요.';
    return `
<h1 class="page-title">🃏 SRS 복습</h1>
<div class="completion">
  <div class="completion-emoji">🎉</div>
  <div class="completion-title">${msg}</div>
  ${sub ? `<div class="completion-sub">${sub}</div>` : ''}
  <button class="btn btn-primary" onclick="go('/')">홈으로</button>
</div>`;
  }

  return reviewCardHtml();
}

function reviewCardHtml() {
  if (S.ri >= S.rq.length) return reviewDoneHtml();

  const card = S.rq[S.ri];
  const pct  = Math.round(S.ri / S.rq.length * 100);
  const isG  = card._type === 'grammar';

  const front = isG ? `
    <div class="card-hint">문법 패턴 — 한국어 뜻은?</div>
    <div class="card-meaning">${escHtml(card.meaning_ko)}</div>
    <div class="card-example" style="margin-top:10px">${escHtml(card.description || '')}</div>
  ` : `
    <div class="card-hint">뜻</div>
    <div class="card-meaning">${escHtml(card.meaning_ko)}</div>
  `;

  const back = isG ? `
    <div class="card-hint">패턴</div>
    <div class="card-word" style="font-size:32px">${escHtml(card.pattern)}</div>
    ${card.examples && card.examples[0] ? `
      <div class="card-example">
        ${escHtml(card.examples[0].jp)}<br>
        <span style="color:var(--dim)">${escHtml(card.examples[0].ko)}</span>
      </div>` : ''}
  ` : `
    <div class="card-hint">단어</div>
    <div class="card-word">${escHtml(card.kanji || card.kana)}</div>
    ${card.kanji ? `<div class="card-reading">${escHtml(card.kana)}</div>` : ''}
    <div class="card-example">${escHtml(card.example_jp || '')}<br>
      <span style="color:var(--dim)">${escHtml(card.example_ko || '')}</span></div>
  `;

  return `
<h1 class="page-title">🃏 SRS 복습</h1>
<div class="mode-tabs">
  <button class="mode-tab${S.rMode==='all'?' active':''}"     data-mode="all">전체</button>
  <button class="mode-tab${S.rMode==='vocab'?' active':''}"   data-mode="vocab">단어만</button>
  <button class="mode-tab${S.rMode==='grammar'?' active':''}" data-mode="grammar">문법만</button>
</div>
<div class="progress-text">${S.ri + 1} / ${S.rq.length}</div>
<div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>

<div class="flashcard-wrap">
  <div class="flashcard${S.rFlipped ? ' flipped' : ''}" id="fc">
    <div class="card-face">
      ${front}
      <div class="card-tap">카드를 클릭해서 뒤집기</div>
    </div>
    <div class="card-face card-back">
      ${back}
    </div>
  </div>
</div>

${S.rFlipped ? `
<div class="review-btns">
  <button class="btn btn-wrong"   id="r-wrong">✗ 몰랐어</button>
  <button class="btn btn-correct" id="r-right">✓ 알았어</button>
</div>` : `
<div style="text-align:center">
  <button class="btn btn-secondary" id="r-flip" style="min-width:160px">뒤집기 👆</button>
</div>`}`;
}

function reviewDoneHtml(saving, saveErr) {
  const correct = S.rResults.filter(Boolean).length;
  const total   = S.rResults.length;
  const pct     = total ? Math.round(correct / total * 100) : 0;
  const emoji   = saving ? '⏳' : pct >= 80 ? '🎊' : pct >= 60 ? '👍' : '💪';

  return `
<h1 class="page-title">🃏 SRS 복습</h1>
<div class="completion">
  <div class="completion-emoji">${emoji}</div>
  <div class="completion-title">${saving ? 'GitHub에 저장 중...' : '복습 완료!'}</div>
  <div class="completion-sub">${total}개 중 ${correct}개 정답 (${pct}%)</div>
  ${saveErr ? `<div class="alert alert-error" style="max-width:420px;margin:0 auto 20px">저장 실패: ${escHtml(saveErr)}<br><button class="btn btn-secondary" id="r-retrysave" style="margin-top:10px;font-size:13px">다시 저장</button></div>` : ''}
  ${!saving ? `
  <div class="completion-btns">
    <button class="btn btn-secondary" id="r-retrywrong">틀린 것만 다시</button>
    <button class="btn btn-primary"   onclick="go('/')">홈으로</button>
  </div>` : ''}
</div>`;
}

// ── Kana ──────────────────────────────────────────────────────────────────
async function kanaPage() {
  const kana = await loadKana();
  const weakSet = new Set((kana.weak_kana || []).map(k => k.char));

  // Build queue: weak first, then random sample
  const weak = HIRAGANA.filter(k => weakSet.has(k.c));
  const rest  = HIRAGANA.filter(k => !weakSet.has(k.c)).sort(() => Math.random() - 0.5);
  S.kq = [...weak, ...rest];
  S.ki = 0; S.kFlipped = false;

  return kanaCardHtml();
}

function kanaCardHtml() {
  if (S.ki >= S.kq.length) {
    return `
<h1 class="page-title">あ 가나 워밍업</h1>
<div class="completion">
  <div class="completion-emoji">✨</div>
  <div class="completion-title">워밍업 완료!</div>
  <div class="completion-sub">${S.kq.length}개 가나 연습했어요.</div>
  <div class="completion-btns">
    <button class="btn btn-secondary" id="k-restart">다시 하기</button>
    <button class="btn btn-primary"   onclick="go('/')">홈으로</button>
  </div>
</div>`;
  }

  const k   = S.kq[S.ki];
  const pct = Math.round(S.ki / S.kq.length * 100);

  return `
<h1 class="page-title">あ 가나 워밍업</h1>
<div class="progress-text">${S.ki + 1} / ${S.kq.length}</div>
<div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>

<div class="flashcard-wrap">
  <div class="flashcard${S.kFlipped ? ' flipped' : ''}" id="kfc">
    <div class="card-face">
      <div class="card-hint">이 가나의 발음은?</div>
      <div class="card-word" style="font-size:90px;line-height:1">${k.c}</div>
      <div class="card-tap">클릭해서 확인</div>
    </div>
    <div class="card-face card-back">
      <div class="card-word" style="font-size:90px;line-height:1">${k.c}</div>
      <div class="card-reading" style="font-size:30px;margin-top:12px">${k.r}</div>
    </div>
  </div>
</div>

${S.kFlipped ? `
<div class="review-btns">
  <button class="btn btn-wrong"   id="k-wrong">✗ 헷갈렸어</button>
  <button class="btn btn-correct" id="k-right">✓ 알았어</button>
</div>` : `
<div style="text-align:center">
  <button class="btn btn-secondary" id="k-flip" style="min-width:160px">확인 👆</button>
</div>`}`;
}

// ── Vocab ─────────────────────────────────────────────────────────────────
async function vocabPage() {
  await loadVocab();
  const due = S.vocab.cards.filter(isDue).length;
  return `
<h1 class="page-title">📖 단어장</h1>
<div style="display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap">
  <button class="btn btn-primary" id="vocab-quiz-all-btn">🃏 전체 단어 퀴즈 (${S.vocab.cards.length}개)</button>
  ${due > 0 ? `<button class="btn btn-secondary" id="vocab-quiz-due-btn">📬 복습 대기만 (${due}개)</button>` : ''}
</div>
<input class="search-bar" id="vsearch" placeholder="검색 (한국어, 일본어)…" autocomplete="off">
<div id="vtable">${vocabTableHtml(S.vocab.cards)}</div>`;
}

function vocabTableHtml(cards) {
  if (!cards.length) return '<div class="alert alert-info">단어가 없습니다.</div>';
  return `
<table class="vocab-table">
  <thead><tr>
    <th>한자</th><th>가나</th><th>뜻</th><th>예문</th><th>상태</th>
  </tr></thead>
  <tbody>
  ${cards.map(c => `
    <tr>
      <td class="kanji-cell">${escHtml(c.kanji || '–')}</td>
      <td class="kana-cell">${escHtml(c.kana)}</td>
      <td>${escHtml(c.meaning_ko)}</td>
      <td style="font-size:13px;color:var(--dim)">${escHtml(c.example_jp || '')}</td>
      <td><span class="badge ${isDue(c) ? 'badge-due' : 'badge-ok'}">${isDue(c) ? '복습' : '✓'}</span></td>
    </tr>`).join('')}
  </tbody>
</table>`;
}

// ── Grammar ───────────────────────────────────────────────────────────────
async function grammarPage() {
  const g = await loadGrammar();
  const due = g.cards.filter(isDue).length;
  return `
<h1 class="page-title">📝 문법</h1>
<div style="margin-bottom:24px;display:flex;align-items:center;gap:16px">
  <button class="btn btn-primary" id="grammar-quiz-btn">
    🃏 문법 퀴즈 시작${due > 0 ? ` (${due}개 복습 대기)` : ''}
  </button>
  <span style="color:var(--dim);font-size:13px">문법만 따로 퀴즈</span>
</div>
${g.cards.map(c => `
<div class="grammar-card">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px">
    <div class="grammar-pattern">${escHtml(c.pattern)}</div>
    <span class="badge ${isDue(c) ? 'badge-due' : 'badge-ok'}">${isDue(c) ? '복습' : '✓'}</span>
  </div>
  <div class="grammar-ko">${escHtml(c.meaning_ko)}</div>
  <div class="grammar-desc">${escHtml(c.description || '')}</div>
  ${c.notes ? `<div class="grammar-note">⚠️ ${escHtml(c.notes)}</div>` : ''}
  <div class="grammar-examples">
    ${(c.examples || []).map(ex => `
      <div class="ex-jp">${escHtml(ex.jp)}</div>
      <div class="ex-ko">${escHtml(ex.ko)}</div>
    `).join('')}
  </div>
</div>`).join('')}`;
}

// ── Lessons ───────────────────────────────────────────────────────────────
async function lessonsPage() {
  if (S.lessonName && S.lessonText !== null) {
    return `
<button class="back-btn" id="l-back">← 목록으로</button>
<h1 class="page-title">📅 ${escHtml(S.lessonName)}</h1>
<div class="md-body">${marked.parse(S.lessonText)}</div>`;
  }

  if (!S.lessonFiles) {
    const files = await gh.ls('lessons');
    S.lessonFiles = files
      .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f.name))
      .sort((a, b) => b.name.localeCompare(a.name));
  }

  if (!S.lessonFiles.length) {
    return '<h1 class="page-title">📅 레슨 로그</h1><div class="alert alert-info">레슨 파일이 없습니다.</div>';
  }

  return `
<h1 class="page-title">📅 레슨 로그</h1>
<ul class="file-list">
  ${S.lessonFiles.map(f => `
    <li class="file-item" data-lesson="${escHtml(f.name)}">
      <span class="file-name">${escHtml(f.name.replace('.md', ''))}</span>
      <span class="file-arrow">→</span>
    </li>`).join('')}
</ul>`;
}

// ── Reference ─────────────────────────────────────────────────────────────
const REF_LABELS = {
  'n5_grammar_list.md':      'N5 문법 학습 순서',
  'n5_vocab_topics.md':      'N5 단어 주제 순서',
  'sound_correspondence.md': '한국어↔일본어 음운 대응',
};

async function referencePage() {
  if (S.refName && S.refText !== null) {
    return `
<button class="back-btn" id="ref-back">← 목록으로</button>
<h1 class="page-title">📚 ${escHtml(REF_LABELS[S.refName] || S.refName)}</h1>
<div class="md-body">${marked.parse(S.refText)}</div>`;
  }

  if (!S.refFiles) {
    const files = await gh.ls('reference');
    S.refFiles = files.filter(f => f.name.endsWith('.md'));
  }

  return `
<h1 class="page-title">📚 레퍼런스</h1>
<ul class="file-list">
  ${S.refFiles.map(f => `
    <li class="file-item" data-ref="${escHtml(f.name)}">
      <span class="file-name">${escHtml(REF_LABELS[f.name] || f.name)}</span>
      <span class="file-arrow">→</span>
    </li>`).join('')}
</ul>`;
}

// ── Music ─────────────────────────────────────────────────────────────────
const SONGS = [
  {
    title: 'さんぽ',
    artist: '井上あずみ (となりのトトロ)',
    level: 'N5 완벽',
    youtube: 'さんぽ となりのトトロ',
    why: '짧은 문장, 반복 구조. 歩こう(걷자)、元気(건강함) 등 기초 어휘. 발음 명확.',
    vocab: ['私'],
  },
  {
    title: 'となりのトトロ',
    artist: '井上あずみ',
    level: 'N5',
    youtube: 'となりのトトロ 主題歌',
    why: '毎日、家 등 학습한 단어 등장. 반복 가사로 외우기 쉬움.',
    vocab: ['毎日', '家'],
  },
  {
    title: '犬のおまわりさん',
    artist: '童謡',
    level: 'N5 완벽',
    youtube: '犬のおまわりさん 童謡',
    why: '名前、泣く 등 N5 어휘. 매우 느리고 발음 명확.',
    vocab: ['名前'],
  },
  {
    title: 'アンパンマンのマーチ',
    artist: 'ドリーミング',
    level: 'N5',
    youtube: 'アンパンマンのマーチ 歌詞',
    why: '何のために生まれて — 何(뭐) 등장. 의미 있는 가사, 발음 쉬움.',
    vocab: [],
  },
  {
    title: 'ちょうちょ',
    artist: '童謡',
    level: 'N5 완벽',
    youtube: 'ちょうちょ 童謡',
    why: '가장 짧은 동요 중 하나. 小さい 등 N5 어휘.',
    vocab: ['小さい'],
  },
  {
    title: 'ぞうさん',
    artist: '童謡',
    level: 'N5 완벽',
    youtube: 'ぞうさん 童謡',
    why: '매우 단순한 구조. 誰(누구)、好き(좋아함) 반복.',
    vocab: [],
  },
  {
    title: '上を向いて歩こう (Sukiyaki)',
    artist: '坂本九',
    level: 'N4~N5',
    youtube: '上を向いて歩こう 坂本九',
    why: '세계적으로 유명. 歩く(걷다) 핵심 동사. 멜로디로 먼저 익숙해지기 좋음.',
    vocab: [],
  },
  {
    title: 'パプリカ',
    artist: 'Foorin',
    level: 'N4~N5',
    youtube: 'パプリカ Foorin 歌詞',
    why: '현대 어린이 노래. 花が咲く — 花(꽃)、咲く(피다). 발음 정확하고 느림.',
    vocab: [],
  },
];

async function musicPage() {
  const vocab = await loadVocab();
  const knownKanji = new Set(vocab.cards.map(c => c.kanji).filter(Boolean));

  return `
<h1 class="page-title">🎵 음악 추천</h1>
<div class="alert alert-info" style="margin-bottom:24px">
  현재 학습한 단어 <strong>${vocab.cards.length}개</strong> 기반 추천.<br>
  곡명 클릭 → YouTube 검색어 복사 → YouTube에서 검색하세요.
</div>
${SONGS.map(s => {
  const matched = s.vocab.filter(k => knownKanji.has(k));
  return `
<div class="grammar-card">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
    <div>
      <div class="grammar-pattern">${escHtml(s.title)}</div>
      <div class="grammar-ko">${escHtml(s.artist)}</div>
    </div>
    <span class="badge ${s.level.includes('완벽') ? 'badge-ok' : 'badge-due'}">${escHtml(s.level)}</span>
  </div>
  <div class="grammar-desc">${escHtml(s.why)}</div>
  ${matched.length ? `<div style="font-size:13px;color:var(--success);margin-bottom:10px">✓ 내가 배운 단어 포함: ${matched.map(escHtml).join('、')}</div>` : ''}
  <div style="display:flex;align-items:center;gap:10px">
    <span style="font-size:12px;color:var(--dim)">YouTube 검색어:</span>
    <code style="background:var(--surface2);padding:4px 10px;border-radius:6px;font-size:13px;cursor:pointer;user-select:all"
          onclick="navigator.clipboard.writeText(this.dataset.q).then(()=>{const o=this.textContent;this.textContent='✓ 복사됨';setTimeout(()=>this.textContent=o,1500)}).catch(()=>{})"
          data-q="${escHtml(s.youtube)}">${escHtml(s.youtube)}</code>
  </div>
</div>`;
}).join('')}`;
}

// ── Settings ──────────────────────────────────────────────────────────────
function settingsPage(needsSetup) {
  return `
<h1 class="page-title">⚙️ 설정</h1>
${needsSetup ? '<div class="alert alert-info">GitHub PAT 설정이 필요합니다.</div>' : ''}
<div class="settings-form">
  <div class="form-group">
    <label class="form-label">GitHub Personal Access Token</label>
    <input class="form-input" type="password" id="s-token" value="${escHtml(gh.token)}" placeholder="ghp_xxxxxxxxxxxx">
    <div class="form-hint">
      <a href="https://github.com/settings/tokens/new?scopes=repo&description=japanese-learning-site" target="_blank">
        토큰 발급 (repo 스코프 필요) ↗
      </a>
    </div>
  </div>
  <div class="form-group">
    <label class="form-label">GitHub 사용자명</label>
    <input class="form-input" type="text" id="s-owner" value="${escHtml(gh.owner)}" placeholder="wonwon21">
  </div>
  <div class="form-group">
    <label class="form-label">저장소 이름</label>
    <input class="form-input" type="text" id="s-repo" value="${escHtml(gh.repo)}" placeholder="japaneses-learning">
  </div>
  <div class="form-group">
    <label class="form-label">브랜치</label>
    <input class="form-input" type="text" id="s-branch" value="${escHtml(gh.branch)}" placeholder="main">
  </div>
  <div id="s-msg"></div>
  <button class="btn btn-primary" id="s-save" style="width:100%">저장 및 연결 테스트</button>
</div>`;
}

// ── Event binding ─────────────────────────────────────────────────────────
function bind(r) {
  if (r === '/settings' || !gh.ok) { bindSettings(); return; }
  if (r === '/review')   bindReview();
  if (r === '/kana')     bindKana();
  if (r === '/vocab')    bindVocab();
  if (r === '/grammar')  bindGrammar();
  if (r === '/lessons')  bindLessons();
  if (r === '/reference') bindRef();
}

function on(id, ev, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(ev, fn);
}

// Settings
function bindSettings() {
  on('s-save', 'click', async () => {
    gh.token  = document.getElementById('s-token').value.trim();
    gh.owner  = document.getElementById('s-owner').value.trim();
    gh.repo   = document.getElementById('s-repo').value.trim();
    gh.branch = document.getElementById('s-branch').value.trim();
    gh.persist();
    S.vocab = S.grammar = S.kana = null; // flush cache

    const msg = document.getElementById('s-msg');
    msg.innerHTML = '<div class="alert alert-info">연결 테스트 중...</div>';
    const ok = await gh.ping();
    if (ok) {
      msg.innerHTML = '<div class="alert alert-success">✅ 연결 성공! 홈으로 이동 중...</div>';
      setTimeout(() => go('/'), 1400);
    } else {
      msg.innerHTML = '<div class="alert alert-error">❌ 연결 실패. 토큰과 저장소명을 확인해주세요.</div>';
    }
  });
}

// Review
function bindReview() {
  const fc = document.getElementById('fc');

  const flip = () => {
    if (S.rFlipped) return;
    S.rFlipped = true;
    paint(reviewCardHtml());
    bindReview();
  };

  if (fc) fc.addEventListener('click', flip);
  on('r-flip', 'click', flip);

  document.querySelectorAll('.mode-tab').forEach(btn => {
    btn.addEventListener('click', async () => {
      S.rMode = btn.dataset.mode;
      paint('<div class="loading">로딩 중...</div>');
      paint(await reviewPage());
      bindReview();
    });
  });

  on('r-right', 'click', () => answerReview(true));
  on('r-wrong', 'click', () => answerReview(false));

  on('r-retrywrong', 'click', () => {
    const wrongs = S.rq.filter((_, i) => !S.rResults[i]);
    if (!wrongs.length) { go('/'); return; }
    S.rq = wrongs; S.ri = 0; S.rResults = []; S.rFlipped = false;
    paint(reviewCardHtml());
    bindReview();
  });

  on('r-retrysave', 'click', saveReview);
}

async function answerReview(correct) {
  const card = S.rq[S.ri];
  S.rResults.push(correct);

  const updated = applyAnswer(card, correct);

  if (card._type === 'vocab') {
    const idx = S.vocab.cards.findIndex(c => c.id === card.id);
    if (idx >= 0) S.vocab.cards[idx] = updated;
  } else {
    const idx = S.grammar.cards.findIndex(c => c.id === card.id);
    if (idx >= 0) S.grammar.cards[idx] = updated;
  }

  S.ri++;
  S.rFlipped = false;

  if (S.ri >= S.rq.length) {
    paint(reviewDoneHtml(true));
    await saveReview();
  } else {
    paint(reviewCardHtml());
    bindReview();
  }
}

async function saveReview() {
  const hadVocab   = S.rq.some(c => c._type === 'vocab');
  const hadGrammar = S.rq.some(c => c._type === 'grammar');
  const date       = todayStr();

  try {
    // Refresh SHAs before writing — prevents 409 when another device or
    // Claude Code session updated the file since we last loaded it
    const [freshV, freshG] = await Promise.all([
      hadVocab   ? gh.getFile('srs/vocab.json')   : Promise.resolve(null),
      hadGrammar ? gh.getFile('srs/grammar.json') : Promise.resolve(null),
    ]);
    if (freshV) S.vocabSha   = freshV.sha;
    if (freshG) S.grammarSha = freshG.sha;

    const saves = [];
    if (hadVocab)   saves.push(gh.putJSON('srs/vocab.json',   S.vocab,   S.vocabSha,   `SRS 복습 ${date}: 단어`));
    if (hadGrammar) saves.push(gh.putJSON('srs/grammar.json', S.grammar, S.grammarSha, `SRS 복습 ${date}: 문법`));
    const results = await Promise.all(saves);

    let ri = 0;
    if (hadVocab)   { S.vocabSha   = results[ri++].content.sha; }
    if (hadGrammar) { S.grammarSha = results[ri++].content.sha; }

    paint(reviewDoneHtml(false));
    bindReview();
  } catch (e) {
    paint(reviewDoneHtml(false, e.message));
    bindReview();
  }
}

// Kana
function bindKana() {
  const kfc = document.getElementById('kfc');

  const flip = () => {
    if (S.kFlipped) return;
    S.kFlipped = true;
    paint(kanaCardHtml());
    bindKana();
  };

  if (kfc) kfc.addEventListener('click', flip);
  on('k-flip',  'click', flip);
  on('k-right', 'click', () => answerKana(true));
  on('k-wrong', 'click', () => answerKana(false));

  on('k-restart', 'click', async () => {
    S.kana = null; // force reload to get latest weak_kana
    paint('<div class="loading">로딩 중...</div>');
    paint(await kanaPage());
    bindKana();
  });
}

async function answerKana(correct) {
  if (!correct) {
    const k = S.kq[S.ki];
    const weak = S.kana.weak_kana || [];
    const existing = weak.find(w => w.char === k.c);
    if (existing) {
      existing.miss_count = (existing.miss_count || 0) + 1;
      existing.last_missed = todayStr();
    } else {
      weak.push({ char: k.c, confused_with: [], miss_count: 1, last_missed: todayStr() });
    }
    S.kana.weak_kana = weak;
    try {
      const r = await gh.putJSON('srs/kana_weak.json', S.kana, S.kanaSha, `가나 오답 ${todayStr()}`);
      S.kanaSha = r.content.sha;
    } catch (e) {
      console.warn('kana save failed:', e);
    }
  }
  S.ki++;
  S.kFlipped = false;
  paint(kanaCardHtml());
  bindKana();
}

// Vocab search + quiz buttons
function bindVocab() {
  on('vocab-quiz-all-btn', 'click', async () => {
    S.rMode = 'vocab'; S.rAll = true;
    paint('<div class="loading">로딩 중...</div>');
    paint(await reviewPage());
    bindReview();
  });

  on('vocab-quiz-due-btn', 'click', async () => {
    S.rMode = 'vocab'; S.rAll = false;
    paint('<div class="loading">로딩 중...</div>');
    paint(await reviewPage());
    bindReview();
  });

  const inp = document.getElementById('vsearch');
  if (!inp) return;
  inp.addEventListener('input', () => {
    const q = inp.value.toLowerCase();
    const cards = q
      ? S.vocab.cards.filter(c =>
          (c.kanji || '').includes(q) ||
          c.kana.includes(q) ||
          c.meaning_ko.includes(q) ||
          (c.example_jp || '').includes(q))
      : S.vocab.cards;
    document.getElementById('vtable').innerHTML = vocabTableHtml(cards);
  });
}

// Lessons
function bindLessons() {
  on('l-back', 'click', () => {
    S.lessonName = null; S.lessonText = null;
    lessonsPage().then(html => { paint(html); bindLessons(); });
  });

  document.querySelectorAll('.file-item[data-lesson]').forEach(el => {
    el.addEventListener('click', async () => {
      const name = el.dataset.lesson;
      paint('<div class="loading">로딩 중...</div>');
      try {
        const { text } = await gh.getFile(`lessons/${name}`);
        S.lessonName = name.replace('.md', '');
        S.lessonText = text;
        paint(await lessonsPage());
        bindLessons();
      } catch (e) {
        paint(`<div class="alert alert-error">로드 실패: ${escHtml(e.message)}</div>`);
      }
    });
  });
}

// Grammar quiz button
function bindGrammar() {
  on('grammar-quiz-btn', 'click', async () => {
    S.rMode = 'grammar'; S.rAll = true;
    paint('<div class="loading">로딩 중...</div>');
    paint(await reviewPage());
    bindReview();
  });
}

// Reference
function bindRef() {
  on('ref-back', 'click', () => {
    S.refName = null; S.refText = null;
    referencePage().then(html => { paint(html); bindRef(); });
  });

  document.querySelectorAll('.file-item[data-ref]').forEach(el => {
    el.addEventListener('click', async () => {
      const name = el.dataset.ref;
      paint('<div class="loading">로딩 중...</div>');
      try {
        const { text } = await gh.getFile(`reference/${name}`);
        S.refName = name;
        S.refText = text;
        paint(await referencePage());
        bindRef();
      } catch (e) {
        paint(`<div class="alert alert-error">로드 실패: ${escHtml(e.message)}</div>`);
      }
    });
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (!window.location.hash) window.location.hash = '/';
  render();
});

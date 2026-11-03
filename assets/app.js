// 鶯歌工商AI輔助查詢系統 — 前端主程式
import { parseDoc, SearchIndex } from './search.js';

const CFG = window.APP_CONFIG;
const VERSION = '2026.11.03';
const STORE_KEY = 'ykvs-ask:conversations';
const SETTINGS_KEY = 'ykvs-ask:settings';
const MAX_CONVERSATIONS = 50;
const MAX_HISTORY_MESSAGES = 10; // AI 模式送出的上下文訊息數上限
const CONFIDENT_SCORE = 20; // 檢索分數低於這個值，視為「找不到明確結果」而改用 AI 延伸搜尋
const API = (CFG.apiUrl || '').replace(/\/+$/, '');

const ICONS = {
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  type: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4"/>',
  book: '<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/>',
  compass: '<circle cx="12" cy="12" r="10"/><path d="m16.2 7.8-2.1 6.3-6.3 2.1 2.1-6.3z"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
  quiz: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
  thumb: '<path d="M7 10v12M15 5.9 14 10h5.8a2 2 0 0 1 1.9 2.6l-2.3 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.8a2 2 0 0 0 1.8-1.1L12 2a3.1 3.1 0 0 1 3 3.9z"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
};

const $ = (sel, el = document) => el.querySelector(sel);
const els = {
  app: $('.app'), main: $('#main'), messages: $('#messages'), chat: $('#chat'),
  input: $('#input'), send: $('#sendBtn'), mic: $('#micBtn'), composer: $('#composer'),
  cards: $('#cards'), panel: $('#panel'), history: $('#historyList'), title: $('#topbarTitle'),
};

// localStorage 可能被封鎖（無痕模式、預覽環境），讀寫一律包 try/catch
const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 無法保存時照常運作 */ } },
};

let conversations = store.get(STORE_KEY, []);
let current = null;
let activeCard = null;
let busy = false;
const kb = { docs: [], index: null, error: '' };
let quizBank = [];

// ---------- 小工具 ----------

function icon(name) {
  return `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}
function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    if (!el.querySelector('svg')) el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
  });
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function save() {
  conversations = conversations.slice(0, MAX_CONVERSATIONS);
  store.set(STORE_KEY, conversations);
}

// ---------- 簡易 Markdown（先跳脫 HTML，再轉換少數語法） ----------

function inlineMarked(s, terms) {
  const html = esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[^"'>=])(https?:\/\/[^\s<，。、）)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  return terms && terms.length ? markTerms(html, terms) : html;
}

/** 把關鍵詞出現的位置合併成連續區段再加 <mark>。關鍵詞只有中文，不會碰到 HTML 標籤或網址。 */
function markTerms(html, terms) {
  const hit = new Uint8Array(html.length);
  for (const t of terms) {
    for (let i = html.indexOf(t); i >= 0; i = html.indexOf(t, i + 1)) hit.fill(1, i, i + t.length);
  }
  let out = '';
  for (let i = 0; i < html.length; i++) {
    if (hit[i] && !hit[i - 1]) out += '<mark>';
    out += html[i];
    if (hit[i] && !hit[i + 1]) out += '</mark>';
  }
  return out;
}

function renderMarkdown(src, terms) {
  const inline = s => inlineMarked(s, terms);
  let html = '';
  let list = null;
  let para = [];
  const flushPara = () => { if (para.length) { html += `<p>${para.map(inline).join('<br>')}</p>`; para = []; } };
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  const openList = tag => { if (list !== tag) { closeList(); html += `<${tag}>`; list = tag; } };

  for (const raw of String(src).replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flushPara(); closeList(); continue; }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      flushPara(); closeList();
      const tag = m[1].length <= 2 ? 'h3' : 'h4';
      html += `<${tag}>${inline(m[2])}</${tag}>`;
    } else if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      flushPara(); openList('ul'); html += `<li>${inline(m[1])}</li>`;
    } else if ((m = line.match(/^\s*\d+[.)、]\s*(.*)$/))) {
      flushPara(); openList('ol'); html += `<li>${inline(m[1])}</li>`;
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      flushPara(); closeList(); html += `<blockquote>${inline(m[1])}</blockquote>`;
    } else {
      closeList(); para.push(line);
    }
  }
  flushPara(); closeList();
  return html;
}

// ---------- 知識庫與題庫 ----------

async function loadKnowledge() {
  try {
    const { files } = await fetch('kb/index.json').then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
    kb.docs = await Promise.all(files.map(async f => {
      const res = await fetch('kb/' + encodeURIComponent(f));
      if (!res.ok) throw new Error(`${f} ${res.status}`);
      return parseDoc(f, await res.text());
    }));
    kb.index = new SearchIndex(kb.docs, CFG.synonyms);
  } catch (err) {
    kb.error = location.protocol === 'file:'
      ? '知識庫無法載入：請用「啟動預覽.bat」開啟，或把整個資料夾放到網站上（直接雙擊 index.html 時，瀏覽器會擋住讀取檔案）。'
      : `知識庫載入失敗（${err.message}），請稍後重新整理頁面。`;
    console.error(err);
  }
  try {
    quizBank = (await fetch('data/quiz.json').then(r => r.json())).questions;
  } catch { quizBank = []; }
  renderAbout();
}

function snapshot(c) {
  return { docTitle: c.docTitle, heading: c.heading, source: c.source, origin: c.origin, text: c.text };
}

/** 檢索結果是否夠明確：分數夠高；分數只是勉強及格時，問題裡的詞也要有一定比例出現在段落中。 */
function confident(question, results) {
  if (!results.length || results[0].score < CONFIDENT_SCORE) return false;
  return results[0].score >= CONFIDENT_SCORE * 1.5 || kb.index.coverage(question, results[0].chunk) >= 0.3;
}

// ---------- 對話 ----------

function ensureConversation(title) {
  if (!current) {
    current = { id: uid(), title: title.slice(0, 40), createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
    conversations.unshift(current);
  }
  current.updatedAt = Date.now();
  return current;
}

/** question 是顯示在對話中的問題；query 是實際拿去檢索的字串（延伸提問會帶上文件名稱，找得更準）。 */
async function ask(question, query) {
  question = question.trim();
  if (!question || busy) return;
  busy = true;
  setPanel(null);
  els.input.value = '';
  autosize();

  const conv = ensureConversation(question);
  conv.messages.push({ role: 'user', text: question });
  const msg = { role: 'assistant', kind: 'answer', text: '', pending: true, question, query: query || question };
  conv.messages.push(msg);
  render();
  scrollToBottom(true);

  await kbReady;
  const results = kb.index ? kb.index.search(msg.query, 3) : [];
  // 有 AI 後端時：關鍵字找不到或結果不明確，才交給 AI 延伸搜尋（aiMode 'always' 則每題都用 AI）
  if (API && (CFG.aiMode === 'always' || !confident(question, results))) await answerWithAI(conv, msg);
  else answerWithSearch(msg, results);

  finish(msg);
}

function finish(msg) {
  msg.pending = false;
  busy = false;
  save();
  render();
  updateSend();
}

/** 已經是檢索結果的回答，改用 AI 延伸搜尋重新回答。 */
async function retryWithAI(msg) {
  if (busy) return;
  busy = true;
  for (const k of ['text', 'sources', 'terms', 'followups', 'suggest', 'notice', 'trace', 'failed', 'feedback', 'comment']) delete msg[k];
  msg.text = '';
  msg.pending = true;
  render();
  await answerWithAI(current, msg);
  finish(msg);
}

function answerWithSearch(msg, results) {
  msg.mode = 'search';
  if (!kb.index) { msg.text = kb.error; return; }
  msg.sources = results.map(r => snapshot(r.chunk));
  msg.terms = kb.index.highlightTerms(msg.question);
  if (!results.length) {
    msg.text = `目前的資料裡找不到相關內容。可以換個說法再問一次，或聯絡學校總機 ${CFG.schoolPhone}、查看[學校網站](${CFG.schoolUrl})。`;
    msg.followups = CFG.cards.filter(c => c.prompts).map(c => ({ label: c.prompts[0], query: c.prompts[0] }));
    return;
  }
  const top = results[0].chunk;
  const key = kb.index.keyLines(msg.query || msg.question, top);
  msg.text = key.length
    ? `**重點**（出自〈${top.docTitle}・${top.heading}〉）\n${key.map(l => '- ' + l).join('\n')}`
    : '以下是學校資料中最相關的內容：';
  // 延伸提問：其他相關段落，不夠再補同一份文件的前後段
  const seen = new Set([top]);
  const pool = [...results.slice(1).map(r => r.chunk), ...kb.index.neighbors(top)];
  msg.followups = pool.filter(c => !seen.has(c) && seen.add(c)).slice(0, 3)
    .map(c => ({ label: c.heading, query: `${c.docTitle} ${c.heading}` }));
}

function historyForAI(conv) {
  // 只送文字（不含小測驗與失敗的回答），並確保 user / assistant 交替、以 user 開頭
  const out = [];
  for (const m of conv.messages) {
    if (m.pending || m.kind === 'quiz' || m.failed || !m.text) continue;
    const role = m.role === 'user' ? 'user' : 'assistant';
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += '\n\n' + m.text;
    else out.push({ role, content: m.text });
  }
  const recent = out.slice(-MAX_HISTORY_MESSAGES);
  while (recent.length && recent[0].role !== 'user') recent.shift();
  return recent;
}

async function answerWithAI(conv, msg) {
  msg.mode = 'ai';
  try {
    const res = await fetch(`${API}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: historyForAI(conv) }),
    });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('text/event-stream')) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    let raw = '';
    const stop = await readStream(res, {
      // AI 先回報它怎麼理解問題、延伸了哪些關鍵詞、找到哪些段落
      meta(m) {
        msg.trace = { intent: m.intent || '', keywords: m.keywords || [] };
        msg.sources = (m.sections || []).map(snapshot);
        updateStreaming(msg);
      },
      text(t) {
        raw += t;
        Object.assign(msg, splitFollowups(raw));
        updateStreaming(msg);
      },
    });
    if (stop === 'refusal') {
      msg.text = '這個問題我沒辦法回答。請換個方式詢問，或直接聯絡學校相關處室。';
      msg.followups = [];
    } else if (stop === 'max_tokens') {
      msg.text += '\n\n（回答過長，已截斷。）';
    }
  } catch (err) {
    console.error(err);
    delete msg.trace;
    msg.notice = `AI 服務暫時無法使用（${err.message}），先提供學校資料查詢結果。`;
    answerWithSearch(msg, kb.index ? kb.index.search(msg.query || msg.question, 3) : []);
    msg.failed = true;
  }
}

const FOLLOWUP_MARK = '【延伸提問】';

/** AI 回答最後一行是「【延伸提問】問題一｜問題二｜問題三」：拆成正文與延伸提問；串流中先藏起不完整的標記。 */
function splitFollowups(raw) {
  const at = raw.indexOf(FOLLOWUP_MARK);
  if (at >= 0) {
    const followups = raw.slice(at + FOLLOWUP_MARK.length).split(/[｜|\n]/)
      .map(s => s.replace(/^\s*[-*\d.、]+\s*/, '').trim()).filter(Boolean).slice(0, 3)
      .map(q => ({ label: q, query: q }));
    return { text: raw.slice(0, at).trimEnd(), followups };
  }
  for (let n = FOLLOWUP_MARK.length - 1; n > 0; n--) {
    if (raw.endsWith(FOLLOWUP_MARK.slice(0, n))) return { text: raw.slice(0, -n), followups: [] };
  }
  return { text: raw, followups: [] };
}

/** 讀取 Worker 回傳的 SSE（{meta}、{t: 文字}、{done, stop}），回傳結束原因（stop_reason）。 */
async function readStream(res, on) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let stop = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const event = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = JSON.parse(line.slice(5));
        if (data.error) throw new Error(data.error);
        if (data.meta) on.meta(data.meta);
        if (data.t) on.text(data.t);
        if (data.done) stop = data.stop;
      }
    }
  }
  if (stop === null) throw new Error('連線中斷');
  return stop;
}

// ---------- 小測驗 ----------

function startQuiz() {
  if (busy) return;
  setPanel(null);
  if (!quizBank.length) { flashNotice('題庫載入中，請稍候再試。'); return; }
  const conv = ensureConversation('校園小測驗');
  conv.quiz ||= { asked: [], correct: 0 };
  if (conv.quiz.asked.length >= quizBank.length) conv.quiz.asked = [];
  const left = quizBank.map((_, i) => i).filter(i => !conv.quiz.asked.includes(i));
  const qi = left[Math.floor(Math.random() * left.length)];
  conv.quiz.asked.push(qi);
  conv.messages.push({ role: 'assistant', kind: 'quiz', qi, n: conv.quiz.asked.length, chosen: null });
  save();
  render();
  scrollToBottom(true);
}

function answerQuiz(msg, choice) {
  if (msg.chosen !== null) return;
  msg.chosen = choice;
  if (choice === quizBank[msg.qi].answer) current.quiz.correct++;
  save();
  render();
}

function endQuiz() {
  const q = current.quiz;
  const answered = current.messages.filter(m => m.kind === 'quiz' && m.chosen !== null).length;
  current.messages.push({
    role: 'assistant', kind: 'answer', mode: 'quiz',
    text: `測驗結束！這次答了 **${answered}** 題，答對 **${q.correct}** 題。想再挑戰，隨時點「換我問你」。`,
  });
  current.quiz = { asked: [], correct: 0 };
  save();
  render();
  scrollToBottom(true);
}

// ---------- 回饋 ----------

function postFeedback(msg, extra = {}) {
  if (!API) return;
  fetch(`${API}/api/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rating: msg.feedback || null, question: msg.question || '', answer: msg.text.slice(0, 2000), ...extra }),
  }).catch(() => { /* 回饋失敗不影響使用 */ });
}

function openComment(msg) {
  const dlg = $('#dlgComment');
  const text = $('#commentText');
  text.value = '';
  dlg.onclose = () => {
    const comment = text.value.trim();
    if (dlg.returnValue === 'ok' && comment) {
      msg.comment = comment;
      postFeedback(msg, { comment });
      save();
      render();
    }
  };
  dlg.showModal();
}

// ---------- 畫面 ----------

function render() {
  const inChat = !!(current && current.messages.length);
  els.main.classList.toggle('is-chat', inChat);
  els.title.textContent = inChat ? current.title : '';
  els.messages.innerHTML = '';
  if (inChat) current.messages.forEach((m, i) => els.messages.append(messageEl(m, i)));
  renderHistory();
  renderCards();
}

function messageEl(msg, i) {
  const div = document.createElement('div');
  div.dataset.idx = i;
  if (msg.role === 'user') {
    div.className = 'msg-user';
    div.innerHTML = `<div class="bubble">${esc(msg.text)}</div>`;
    return div;
  }
  div.className = 'msg-bot';
  div.innerHTML = `<img class="avatar" src="assets/school-logo.gif" alt=""><div class="body"></div>`;
  const body = div.querySelector('.body');
  if (msg.kind === 'quiz') body.innerHTML = quizHtml(msg);
  else body.innerHTML = answerHtml(msg);
  return div;
}

function answerHtml(msg) {
  let html = '';
  if (msg.mode === 'ai') html += traceHtml(msg);
  if (msg.pending && !msg.text) return html + '<div class="typing" aria-label="回答中"><i></i><i></i><i></i></div>';
  if (msg.notice) html += `<div class="notice">${esc(msg.notice)}</div>`;
  html += `<div class="md">${renderMarkdown(msg.text, msg.terms)}</div>`;
  if (msg.pending) return html;

  // 舊版紀錄用 suggest 存建議問題
  const followups = msg.followups || (msg.suggest || []).map(p => ({ label: p, query: p }));
  if (followups.length) {
    html += '<div class="followups"><h4>延伸提問</h4>' + followups.map(f =>
      `<button data-prompt="${esc(f.label)}" data-query="${esc(f.query)}"><span aria-hidden="true">↵</span>${esc(f.label)}</button>`).join('') + '</div>';
  }

  if (msg.sources && msg.sources.length) {
    const primary = msg.mode === 'search';
    html += '<div class="sources">' + msg.sources.map((s, k) => {
      const open = primary && k === 0;
      return `<details class="src${open ? ' src-primary' : ''}"${open ? ' open' : ''}>
        <summary><span class="src-tag">【${open ? '原文' : '參考'}】</span>${esc(s.docTitle)}・${esc(s.heading)}</summary>
        <div class="md">${renderMarkdown(s.text, msg.terms)}</div>
        ${sourceLine(s)}
      </details>`;
    }).join('') + '</div>';
  }

  if (msg.mode === 'quiz') return html;
  html += '<div class="actions">';
  if (API && msg.mode === 'search' && !msg.failed && kb.index) {
    html += `<button class="text-btn ai-btn" data-act="ai">✨ 用 AI 延伸搜尋</button>`;
  }
  if (API) {
    html += `<button class="icon-btn" data-act="up" aria-label="有幫助" title="有幫助" aria-pressed="${msg.feedback === 'up'}">${icon('thumb')}</button>
      <button class="icon-btn down" data-act="down" aria-label="沒有幫助" title="沒有幫助" aria-pressed="${msg.feedback === 'down'}">${icon('thumb')}</button>
      <button class="text-btn" data-act="comment">補充意見</button>`;
  }
  html += `<button class="icon-btn" data-act="copy" aria-label="複製回答" title="複製回答">${icon('copy')}</button>`;
  if (msg.feedback || msg.comment) html += '<span class="thanks">謝謝您的回饋！</span>';
  return html + '</div>';
}

/** AI 延伸搜尋的過程：怎麼理解問題、延伸了哪些關鍵詞。 */
function traceHtml(msg) {
  if (!msg.trace) return msg.pending ? '<p class="trace">正在理解你的問題，並延伸搜尋學校資料…</p>' : '';
  const { intent, keywords } = msg.trace;
  let s = intent ? `我理解你想問：${esc(intent)}` : '';
  if (keywords.length) s += `${s ? '<br>' : ''}延伸搜尋：${keywords.map(esc).join('、')}`;
  return s ? `<p class="trace">${s}</p>` : '';
}

/** 參考資料的出處：學校網站連結，或紙本／PDF 文件名稱。 */
function sourceLine(s) {
  if (/^https?:\/\//.test(s.source || '')) {
    return `<a class="src-link" href="${esc(s.source)}" target="_blank" rel="noopener">查看學校網站原始頁面 ↗</a>`;
  }
  return s.origin ? `<p class="src-link muted">出處：${esc(s.origin)}</p>` : '';
}

function quizHtml(msg) {
  const q = quizBank[msg.qi];
  if (!q) return '<div class="md"><p>這一題已從題庫移除。</p></div>';
  const done = msg.chosen !== null;
  let html = `<div class="quiz-q">第 ${msg.n} 題｜${esc(q.q)}</div><div class="quiz-opts">`;
  html += q.options.map((o, k) => {
    let cls = '';
    if (done && k === q.answer) cls = 'correct';
    else if (done && k === msg.chosen) cls = 'wrong';
    return `<button data-act="pick" data-k="${k}" class="${cls}" ${done ? 'disabled' : ''}>${'ABCD'[k]}. ${esc(o)}</button>`;
  }).join('') + '</div>';
  if (done) {
    const ok = msg.chosen === q.answer;
    html += `<div class="quiz-result"><b class="${ok ? 'ok' : 'bad'}">${ok ? '答對了！' : `答案是 ${'ABCD'[q.answer]}。`}</b> ${esc(q.explain)}<br><small class="muted">出處：${esc(q.source)}</small></div>`;
    const isLast = current && current.messages[current.messages.length - 1] === msg;
    if (isLast) {
      html += `<div class="quiz-next"><button class="btn-primary" data-act="next">下一題</button><button class="btn-ghost" data-act="end">結束測驗</button></div>`;
    }
  }
  return html;
}

let streamFrame = 0;
function updateStreaming(msg) {
  if (streamFrame) return;
  streamFrame = requestAnimationFrame(() => {
    streamFrame = 0;
    const i = current.messages.indexOf(msg);
    const el = els.messages.querySelector(`[data-idx="${i}"] .body`);
    if (!el) return;
    const stick = nearBottom();
    el.innerHTML = answerHtml(msg);
    if (stick) scrollToBottom();
  });
}

function nearBottom() {
  const c = els.chat;
  return c.scrollHeight - c.scrollTop - c.clientHeight < 80;
}
function scrollToBottom(force) {
  if (force || nearBottom()) els.chat.scrollTop = els.chat.scrollHeight;
}

function renderHistory() {
  if (!conversations.length) {
    els.history.innerHTML = '<li class="empty">還沒有對話紀錄</li>';
    return;
  }
  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  els.history.innerHTML = sorted.map(c =>
    `<li><button data-conv="${c.id}" aria-current="${current && current.id === c.id}">${esc(c.title)}</button></li>`).join('');
}

function renderCards() {
  els.cards.innerHTML = CFG.cards.map(c =>
    `<button class="card" data-card="${c.id}" aria-pressed="${activeCard === c.id}">${icon(c.icon)}<b>${esc(c.label)}</b><small>${esc(c.sub)}</small></button>`).join('');
}

function setPanel(cardId) {
  activeCard = cardId;
  const card = CFG.cards.find(c => c.id === cardId);
  if (!card || !card.prompts) {
    els.panel.hidden = true;
    els.panel.innerHTML = '';
  } else {
    els.panel.innerHTML = card.prompts.map(p => `<button data-prompt="${esc(p)}">${esc(p)}</button>`).join('');
    els.panel.hidden = false;
  }
  renderCards();
}

let noticeTimer = 0;
function flashNotice(text) {
  const d = $('#disclaimer');
  d.textContent = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(renderDisclaimer, 4000);
}

function renderDisclaimer() {
  $('#disclaimer').textContent = kb.error || (API
    ? '回應由 AI 依學校公開資料生成，可能有疏漏或錯誤；重要事項請以學校正式公告為準。'
    : '回應摘錄自學校公開資料，可能未即時更新；重要事項請以學校正式公告為準。');
}

function renderAbout() {
  $('#aboutSources').innerHTML = kb.docs.map(d =>
    `<li>${/^https?:\/\//.test(d.source) ? `<a href="${esc(d.source)}" target="_blank" rel="noopener">${esc(d.title)}</a>` : esc(d.title)}${d.origin ? `<span class="muted">（${esc(d.origin)}）</span>` : ''}${d.updated ? `<span class="muted">（整理日期 ${esc(d.updated)}）</span>` : ''}</li>`).join('')
    || '<li class="muted">知識庫尚未載入</li>';
  $('#aboutMode').textContent = API
    ? '本系統先用關鍵字從上述資料中找出相關段落；找不到明確結果時，由 AI（Anthropic 公司的 Claude 模型）理解並延伸你的問題、挑選相關段落後彙整回答。AI 回答可能有疏漏或錯誤，僅供參考；正式內容請以學校公告為準。'
    : '本系統目前為「檢索模式」：回答是從上述資料中找出最相關的段落直接呈現，不經 AI 改寫；資料可能未即時更新，正式內容請以學校公告為準。';
  $('#aboutAiPrivacy').textContent = API
    ? '提問時，您輸入的問題會送到學校的 AI 伺服器並交由 Claude 模型產生回答；按 👍／👎 或「補充意見」時，該則問答會傳給系統管理者作為改善參考。請勿輸入身分證字號、密碼、電話等個人資料。'
    : '請勿在提問中輸入身分證字號、密碼、電話等個人資料。';
  $('#aboutVersion').textContent = `${CFG.name} 版本 ${VERSION}`;
  renderDisclaimer();
}

// ---------- 設定 ----------

const settings = { font: 'm', theme: 'auto', ...store.get(SETTINGS_KEY, {}) };
function applySettings() {
  document.documentElement.dataset.font = settings.font;
  document.documentElement.dataset.theme = settings.theme;
  document.querySelectorAll('.seg').forEach(seg => {
    seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', settings[seg.dataset.setting] === b.dataset.value));
  });
}

// ---------- 輸入 ----------

function autosize() {
  els.input.style.height = 'auto';
  if (els.input.value) els.input.style.height = Math.min(els.input.scrollHeight, 200) + 'px';
  updateSend();
}
function updateSend() {
  els.send.disabled = busy || !els.input.value.trim();
}

function setupVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  els.mic.hidden = false;
  let rec = null;
  els.mic.addEventListener('click', () => {
    if (rec) { rec.stop(); return; }
    rec = new SR();
    rec.lang = 'zh-TW';
    rec.interimResults = true;
    const base = els.input.value;
    rec.onresult = e => {
      els.input.value = base + Array.from(e.results).map(r => r[0].transcript).join('');
      autosize();
    };
    rec.onend = () => { rec = null; els.mic.classList.remove('listening'); els.input.focus(); };
    rec.onerror = () => rec && rec.stop();
    els.mic.classList.add('listening');
    rec.start();
  });
}

// ---------- 事件 ----------

function closeSidebar() { els.app.classList.remove('sb-open'); }

document.addEventListener('click', e => {
  const t = e.target.closest('[data-action],[data-card],[data-prompt],[data-conv],[data-act],.seg button');
  if (!t) return;

  if (t.matches('.seg button')) {
    settings[t.closest('.seg').dataset.setting] = t.dataset.value;
    store.set(SETTINGS_KEY, settings);
    applySettings();
    return;
  }
  if (t.dataset.card) {
    if (t.dataset.card === 'quiz') startQuiz();
    else setPanel(activeCard === t.dataset.card ? null : t.dataset.card);
    return;
  }
  if (t.dataset.prompt) { ask(t.dataset.prompt, t.dataset.query); return; }
  if (t.dataset.conv) {
    current = conversations.find(c => c.id === t.dataset.conv) || null;
    setPanel(null);
    render();
    scrollToBottom(true);
    if (window.matchMedia('(max-width: 760px)').matches) closeSidebar();
    return;
  }
  if (t.dataset.act) {
    const idx = Number(t.closest('[data-idx]').dataset.idx);
    const msg = current.messages[idx];
    switch (t.dataset.act) {
      case 'pick': answerQuiz(msg, Number(t.dataset.k)); break;
      case 'next': startQuiz(); break;
      case 'end': endQuiz(); break;
      case 'up':
      case 'down':
        msg.feedback = msg.feedback === t.dataset.act ? null : t.dataset.act;
        if (msg.feedback) postFeedback(msg);
        save(); render();
        break;
      case 'comment': openComment(msg); break;
      case 'ai': retryWithAI(msg); break;
      case 'copy':
        navigator.clipboard?.writeText(msg.text).then(() => {
          t.innerHTML = icon('check');
          setTimeout(() => { t.innerHTML = icon('copy'); }, 1500);
        });
        break;
    }
    return;
  }
  switch (t.dataset.action) {
    case 'toggle-sidebar': els.app.classList.toggle('sb-open'); break;
    case 'close-sidebar': closeSidebar(); break;
    case 'new-chat':
      current = null; setPanel(null); render(); els.input.focus();
      if (window.matchMedia('(max-width: 760px)').matches) closeSidebar();
      break;
    case 'clear-history':
      if (confirm('確定要清除這台裝置上的所有對話紀錄嗎？')) {
        conversations = []; current = null; save(); render();
      }
      break;
    case 'open-settings': $('#dlgSettings').showModal(); break;
    case 'open-help': $('#dlgHelp').showModal(); break;
    case 'open-about': $('#dlgAbout').showModal(); break;
  }
});

els.composer.addEventListener('submit', e => { e.preventDefault(); ask(els.input.value); });
els.input.addEventListener('input', autosize);
els.input.addEventListener('keydown', e => {
  // 注音／倉頡輸入法選字時按 Enter 不送出
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    ask(els.input.value);
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && els.app.classList.contains('sb-open')) closeSidebar();
});

// ---------- 啟動 ----------

document.title = CFG.name;
$('#appName').textContent = CFG.name;
$('#appBadge').textContent = CFG.badge || '';
$('#appBadge').hidden = !CFG.badge;
$('#appTagline').textContent = CFG.tagline;
$('#modeLabel').textContent = `${API ? '關鍵字＋AI 延伸搜尋' : '檢索模式'} · 對話紀錄僅存於此裝置`;
if (CFG.reportUrl) {
  $('#reportLink').href = CFG.reportUrl;
  $('#reportLink').hidden = false;
}
applySettings();
hydrateIcons();
setupVoice();
render();
renderDisclaimer();
const kbReady = loadKnowledge();

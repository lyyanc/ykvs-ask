// 鶯歌工商AI輔助查詢系統 — AI 後端（Cloudflare Worker）
//
// 「AI 延伸搜尋」分兩步：
//   1. 理解與延伸：把問題和知識庫「段落目錄」交給 Claude，請它理解真正想問什麼、延伸關鍵詞，並挑出相關段落。
//   2. 彙整回答：只把挑出的段落內容交給 Claude，串流寫出附出處的回答，最後附上三個「延伸提問」。
// 只送相關段落而不是整個知識庫，知識庫變大時費用也不會跟著暴增。
//
// 單一檔案、不需安裝套件，可直接貼到 Cloudflare 後台的 Worker 編輯器。
// （因為要能免安裝部署，這裡用 fetch 直接呼叫 Claude API，而不是官方 SDK。）
//
// 環境變數（Cloudflare 後台 → Worker → 設定 → 變數）：
//   ANTHROPIC_API_KEY  必填，請設為「秘密」(Secret)
//   KB_BASE_URL        必填，前端網站網址，例如 https://lyyanc.github.io/ykvs-ask/（系統會讀取 KB_BASE_URL/kb/index.json）
//   ALLOWED_ORIGINS    建議填，允許呼叫的前端網址，多個用逗號分隔；留空則不限制
//   MODEL              選填，預設 claude-opus-5-5
//   EFFORT             選填，回答步驟的 low / medium / high，預設 low（校園問答不需要深度推理）
//   RATE_LIMIT_PER_MIN 選填，每個 IP 每分鐘最多提問次數，預設 10
//   FEEDBACK           選填，綁定一個 KV 命名空間即可保存使用者回饋

const DEFAULT_MODEL = 'claude-opus-5-5';
const ANTHROPIC_VERSION = '2026-10-21';
const MAX_TOKENS = 16000;
const SELECT_MAX_TOKENS = 4000;
const MAX_SECTIONS = 6;
const KB_TTL_MS = 5 * 60 * 1000;
const MAX_MESSAGES = 10;
const MAX_USER_CHARS = 1000;
const MAX_ASSISTANT_CHARS = 4000;

const SELECT_INSTRUCTIONS = `你是「鶯歌工商AI輔助查詢系統」的檢索助理。使用者的問題可能很短、很口語或很模糊，例如「我的未來」「被當了」「好想轉科」。

<toc> 是學校知識庫的段落目錄，每行一個段落，格式為「編號｜文件・段落標題」。請：
- 先理解提問者真正想知道什麼；問題模糊時，延伸、改寫或聯想到最可能相關的校園主題（例如「我的未來」可能與升學進路、各科出路、生涯輔導有關）。
- 若有對話脈絡，把指代詞（那、這個、它）還原成具體主題。
- 從目錄挑出最能回答問題的段落編號，最多 ${MAX_SECTIONS} 個，最相關的放前面；目錄裡沒有相關段落就回傳空陣列，不要硬湊。
- intent：用一句話（25 字以內）說明你理解的問題。
- keywords：3 到 6 個延伸搜尋關鍵詞。`;

const SELECT_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string' },
    keywords: { type: 'array', items: { type: 'string' } },
    sections: { type: 'array', items: { type: 'string' } },
  },
  required: ['intent', 'keywords', 'sections'],
  additionalProperties: false,
};

const ANSWER_INSTRUCTIONS = `你是「鶯歌工商AI輔助查詢系統」，新北市立鶯歌高級工商職業學校的校園查詢助理，服務本校學生、家長與教職員。

回答原則：
- 只根據 <sections> 裡的學校資料回答。資料沒有寫到的，直接說「目前的資料裡沒有這項資訊」，並建議洽詢可能的承辦處室（附分機）或查看學校網站；不要自行推測日期、規定、金額或人名。
- 問題很短或模糊時，先依最可能的意思彙整相關資料回答，最後用一句話邀請對方說得更具體。
- 使用繁體中文與台灣用語，語氣親切、簡潔。先給答案，再補充步驟或注意事項；可使用條列，但不要使用表格。
- 引用規定或重要數字時，在句尾用〈文件・段落〉標出出處。
- 涉及找人辦事時，附上承辦單位與分機（學校總機 (02)2677-5040）。
- 畢業、學分、請假、獎懲等規定，依資料原文回答，並提醒以學校正式公告為準。
- 與學校無關的問題，簡短說明你只負責校園事務查詢。
- 若提問者提到霸凌、自我傷害、身心困擾或危險情境，溫和地建議立刻聯絡導師、輔導室或教官室；緊急時撥打 110、119，或安心專線 1925。
- 只在對方輸入了身分證字號、密碼等個人資料時，提醒不要在對話中輸入個資。
- 回答的最後另起一行，固定寫成「【延伸提問】問題一｜問題二｜問題三」：提出三個使用者接著可能想問、與本校相關、能從學校資料查到答案的問題，每題 25 字以內。`;

let kbCache = { at: 0, base: '', sections: [], byId: new Map(), toc: '' };
const hits = new Map(); // 簡易限流（每個 Worker 實例各自計算，屬於盡力而為）

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (!cors) return json({ error: '此網址不允許呼叫' }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      if (url.pathname === '/api/chat' && request.method === 'POST') return await handleChat(request, env, ctx, cors);
      if (url.pathname === '/api/feedback' && request.method === 'POST') return await handleFeedback(request, env, cors);
      if (url.pathname === '/api/health') {
        return json({ ok: true, model: env.MODEL || DEFAULT_MODEL, kbConfigured: !!env.KB_BASE_URL, keyConfigured: !!env.ANTHROPIC_API_KEY }, 200, cors);
      }
      return json({ error: 'not found' }, 404, cors);
    } catch (err) {
      console.error(err);
      return json({ error: '伺服器發生錯誤，請稍後再試' }, 500, cors);
    }
  },
};

// ---------- 對話 ----------

async function handleChat(request, env, ctx, cors) {
  if (!env.ANTHROPIC_API_KEY || !env.KB_BASE_URL) return json({ error: 'AI 服務尚未設定完成' }, 503, cors);

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (rateLimited(ip, Number(env.RATE_LIMIT_PER_MIN) || 10)) {
    return json({ error: '提問太頻繁了，請稍等一分鐘再試' }, 429, cors);
  }

  const body = await request.json().catch(() => null);
  const messages = cleanMessages(body && body.messages);
  if (!messages) return json({ error: '問題格式不正確' }, 400, cors);

  // 先回應串流標頭，兩個步驟都在串流裡進行，前端可以立刻顯示「正在理解問題」
  const { readable, writable } = new TransformStream();
  const pump = answer(env, messages, writable);
  if (ctx && ctx.waitUntil) ctx.waitUntil(pump);
  return new Response(readable, {
    headers: { ...cors, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
  });
}

/** 兩步驟回答，結果以精簡 SSE 送給前端：{meta} → {t: 文字}… → {done, stop}。 */
async function answer(env, messages, writable) {
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = obj => writer.write(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
  try {
    const kb = await loadKnowledge(env.KB_BASE_URL);
    const question = messages[messages.length - 1].content;

    // 步驟一：理解與延伸，挑選段落
    const picked = await selectSections(env, kb, messages);
    if (picked.refused) {
      await send({ done: true, stop: 'refusal' });
      return;
    }
    const sections = picked.sections.map(id => kb.byId.get(id)).filter(Boolean).slice(0, MAX_SECTIONS);
    await send({
      meta: {
        intent: picked.intent,
        keywords: picked.keywords.slice(0, 6),
        sections: sections.map(({ docTitle, heading, source, origin, text }) => ({ docTitle, heading, source, origin, text })),
      },
    });

    // 步驟二：只用挑出的段落彙整回答。日期與理解結果放在最後一則提問裡，不放進 system
    const context = sections.length
      ? sections.map(s => `<section doc="${attr(s.docTitle)}" heading="${attr(s.heading)}" origin="${attr(s.origin || s.source)}">\n${s.text}\n</section>`).join('\n')
      : '（知識庫中沒有找到相關段落）';
    const today = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', dateStyle: 'full' }).format(new Date());
    const history = messages.slice(0, -1);
    const upstream = await callClaude(env, {
      max_tokens: MAX_TOKENS,
      stream: true,
      system: [
        { type: 'text', text: ANSWER_INSTRUCTIONS },
        { type: 'text', text: `<sections>\n${context}\n</sections>` },
      ],
      messages: [
        ...history,
        { role: 'user', content: `（今天是 ${today}；系統理解的問題：${picked.intent}）\n${question}` },
      ],
      output_config: { effort: env.EFFORT || 'low' },
    });
    if (!upstream.ok) {
      console.error('Claude API error', upstream.status, await upstream.text());
      await send({ error: busyMessage(upstream.status) });
      return;
    }
    const stop = await relay(upstream.body, send);
    await send({ done: true, stop });
  } catch (err) {
    console.error(err);
    await send({ error: err.userMessage || 'AI 回答中斷' }).catch(() => {});
  } finally {
    await writer.close().catch(() => {});
  }
}

/** 步驟一：請 Claude 依段落目錄挑出相關段落（結構化 JSON 輸出）。 */
async function selectSections(env, kb, messages) {
  // 只帶最近幾則對話當脈絡，讓「那分機幾號？」這類追問也能找到段落
  const context = messages.slice(-5, -1).map(m => `${m.role === 'user' ? '使用者' : '助理'}：${m.content.slice(0, 300)}`).join('\n');
  const question = messages[messages.length - 1].content;
  const res = await callClaude(env, {
    max_tokens: SELECT_MAX_TOKENS,
    system: [
      { type: 'text', text: SELECT_INSTRUCTIONS },
      // 段落目錄每次都一樣，加上 cache_control 讓重複提問以快取價格計費
      { type: 'text', text: `<toc>\n${kb.toc}\n</toc>`, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: `${context ? `對話脈絡：\n${context}\n\n` : ''}目前的問題：${question}` }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SELECT_SCHEMA } },
  });
  if (!res.ok) {
    console.error('Claude API error (select)', res.status, await res.text());
    throw Object.assign(new Error('select failed'), { userMessage: busyMessage(res.status) });
  }
  const data = await res.json();
  if (data.stop_reason === 'refusal') return { refused: true };
  const block = (data.content || []).find(b => b.type === 'text');
  try {
    const out = JSON.parse(block.text);
    return { intent: String(out.intent || ''), keywords: (out.keywords || []).map(String), sections: (out.sections || []).map(String) };
  } catch {
    console.error('select: unexpected output', JSON.stringify(data.content));
    return { intent: '', keywords: [], sections: [] };
  }
}

async function callClaude(env, payload) {
  const model = env.MODEL || DEFAULT_MODEL;
  const headers = {
    'content-type': 'application/json',
    'x-api-key': env.ANTHROPIC_API_KEY,
    'anthropic-version': ANTHROPIC_VERSION,
  };
  const body = { model, ...payload };
  // 安全分類器拒答時，由 Anthropic 端自動改用建議的備援模型回答（Haiku 沒有備援，不送）
  if (/^claude-(opus-5|fable-5|sonnet-5-5)/.test(model)) {
    body.fallbacks = 'default';
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  }
  return fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) });
}

function busyMessage(status) {
  return status === 429 || status === 529 ? '目前使用人數較多，請稍後再試' : 'AI 服務暫時無法回應';
}

/** 把 Claude 的 SSE 文字片段轉送給前端，回傳 stop_reason。 */
async function relay(body, send) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buffer = '';
  let stop = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const event = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = JSON.parse(line.slice(5));
        if (data.type === 'content_block_delta' && data.delta.type === 'text_delta') {
          await send({ t: data.delta.text });
        } else if (data.type === 'message_delta' && data.delta.stop_reason) {
          stop = data.delta.stop_reason;
        } else if (data.type === 'error') {
          console.error('Claude stream error', JSON.stringify(data.error));
          await send({ error: data.error.type === 'overloaded_error' ? '目前使用人數較多，請稍後再試' : 'AI 回答中斷' });
        }
      }
    }
  }
  return stop;
}

function cleanMessages(input) {
  if (!Array.isArray(input) || !input.length) return null;
  const out = [];
  for (const m of input.slice(-MAX_MESSAGES)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') return null;
    const limit = m.role === 'user' ? MAX_USER_CHARS : MAX_ASSISTANT_CHARS;
    const content = m.content.trim().slice(0, limit);
    if (!content) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.content += '\n\n' + content;
    else out.push({ role: m.role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  if (!out.length || out[out.length - 1].role !== 'user') return null;
  return out;
}

// ---------- 知識庫 ----------

async function loadKnowledge(baseUrl) {
  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  if (kbCache.sections.length && kbCache.base === base && Date.now() - kbCache.at < KB_TTL_MS) return kbCache;

  const index = await fetch(new URL('kb/index.json', base)).then(r => {
    if (!r.ok) throw new Error(`kb/index.json ${r.status}`);
    return r.json();
  });
  const docs = await Promise.all(index.files.map(async file => {
    const res = await fetch(new URL('kb/' + file, base));
    if (!res.ok) throw new Error(`kb/${file} ${res.status}`);
    return toSections(file, await res.text());
  }));
  const sections = docs.flat().map((s, i) => ({ ...s, id: `S${i + 1}` }));
  kbCache = {
    at: Date.now(),
    base,
    sections,
    byId: new Map(sections.map(s => [s.id, s])),
    toc: sections.map(s => `${s.id}｜${s.docTitle}・${s.heading}`).join('\n'),
  };
  return kbCache;
}

/** 依 ## 標題切段（與前端 assets/search.js 的 parseDoc 規則相同，但不再切細）。 */
function toSections(file, raw) {
  let text = raw.replace(/\r\n/g, '\n');
  const meta = {};
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    text = text.slice(fm[0].length);
  }
  text = text.replace(/<!--[\s\S]*?-->/g, ''); // 管理者註解不給 AI
  const h1 = text.match(/^#\s+(.+)$/m);
  const doc = { docTitle: meta.title || (h1 ? h1[1].trim() : file), source: meta.source || '', origin: meta.origin || '' };
  const parts = text.split(/^##\s+/m);
  const out = [];
  const intro = parts.shift().replace(/^#\s+.+$/m, '').trim();
  if (intro) out.push({ ...doc, heading: '概述', text: intro });
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const heading = (nl < 0 ? part : part.slice(0, nl)).trim();
    const body = nl < 0 ? '' : part.slice(nl + 1).trim();
    if (body) out.push({ ...doc, heading, text: body });
  }
  return out;
}

function attr(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// ---------- 回饋 ----------

async function handleFeedback(request, env, cors) {
  const body = await request.json().catch(() => ({}));
  const record = {
    at: new Date().toISOString(),
    rating: body.rating === 'up' || body.rating === 'down' ? body.rating : null,
    comment: String(body.comment || '').slice(0, 500),
    question: String(body.question || '').slice(0, 500),
    answer: String(body.answer || '').slice(0, 2000),
  };
  if (env.FEEDBACK) {
    const key = `fb:${record.at}:${crypto.randomUUID().slice(0, 8)}`;
    await env.FEEDBACK.put(key, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 180 });
  } else {
    console.log('feedback', JSON.stringify(record));
  }
  return json({ ok: true }, 200, cors);
}

// ---------- 共用 ----------

function corsHeaders(request, env) {
  const origin = request.headers.get('origin');
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
  if (allowed.length && origin && !allowed.includes(origin)) return null;
  return {
    'access-control-allow-origin': allowed.length ? (origin || allowed[0]) : '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'vary': 'origin',
  };
}

function rateLimited(ip, perMinute) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > perMinute;
}

function json(obj, status = 200, cors = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
  });
}

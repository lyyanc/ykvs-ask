// 鶯歌工商AI輔助查詢系統 — AI 後端（Cloudflare Worker）
//
// 收到問題後，讀取網站上的知識庫（kb/*.md），連同問題交給 Claude 回答，並以串流方式回傳。
// 單一檔案、不需安裝套件，可直接貼到 Cloudflare 後台的 Worker 編輯器。
// （因為要能免安裝部署，這裡用 fetch 直接呼叫 Claude API，而不是官方 SDK。）
//
// 環境變數（Cloudflare 後台 → Worker → 設定 → 變數）：
//   ANTHROPIC_API_KEY  必填，請設為「秘密」(Secret)
//   KB_BASE_URL        必填，前端網站網址，例如 https://ask.example.edu.tw/（系統會讀取 KB_BASE_URL/kb/index.json）
//   ALLOWED_ORIGINS    建議填，允許呼叫的前端網址，多個用逗號分隔；留空則不限制
//   MODEL              選填，預設 claude-opus-5-5
//   EFFORT             選填，low / medium / high，預設 low（校園問答不需要深度推理）
//   RATE_LIMIT_PER_MIN 選填，每個 IP 每分鐘最多提問次數，預設 10
//   FEEDBACK           選填，綁定一個 KV 命名空間即可保存使用者回饋

const DEFAULT_MODEL = 'claude-opus-5-5';
const ANTHROPIC_VERSION = '2026-10-21';
const MAX_TOKENS = 16000;
const KB_TTL_MS = 5 * 60 * 1000;
const MAX_MESSAGES = 10;
const MAX_USER_CHARS = 1000;
const MAX_ASSISTANT_CHARS = 4000;

const INSTRUCTIONS = `你是「鶯歌工商AI輔助查詢系統」，新北市立鶯歌高級工商職業學校的校園查詢助理，服務本校學生、家長與教職員。

回答原則：
- 只根據 <knowledge_base> 裡的資料回答。資料沒有寫到的，直接說「目前的資料裡沒有這項資訊」，並建議洽詢可能的承辦處室（附分機）或查看學校網站；不要自行推測日期、規定、金額或人名。
- 使用繁體中文與台灣用語，語氣親切、簡潔。先給答案，再補充步驟或注意事項；可使用條列，但不要使用表格。
- 涉及找人辦事時，附上承辦單位與分機（學校總機 (02)2677-5040）。
- 畢業、學分、請假、獎懲等規定，依資料原文回答，並提醒以學校正式公告為準。
- 回答最後另起一行，以「資料來源：」列出引用的文件標題。
- 與學校無關的問題，簡短說明你只負責校園事務查詢，並提供一兩個可以問的例子。
- 若提問者提到霸凌、自我傷害、身心困擾或危險情境，溫和地建議立刻聯絡導師、輔導室或教官室；緊急時撥打 110、119，或安心專線 1925。
- 提醒提問者不要在對話中輸入身分證字號、密碼等個人資料（只在對方輸入了這類資料時提醒）。`;

let kbCache = { at: 0, text: '', base: '' };
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

  const kbText = await loadKnowledge(env.KB_BASE_URL);
  // 日期放在最後一則提問前面，不放進 system，才不會破壞 prompt cache
  const today = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', dateStyle: 'full' }).format(new Date());
  const last = messages[messages.length - 1];
  last.content = `（今天是 ${today}）\n${last.content}`;

  const model = env.MODEL || DEFAULT_MODEL;
  const payload = {
    model,
    max_tokens: MAX_TOKENS,
    stream: true,
    system: [
      { type: 'text', text: INSTRUCTIONS },
      // 知識庫是每次都相同的長內容，加上 cache_control 讓重複提問以快取價格計費
      { type: 'text', text: kbText, cache_control: { type: 'ephemeral' } },
    ],
    messages,
    output_config: { effort: env.EFFORT || 'low' },
  };
  const headers = {
    'content-type': 'application/json',
    'x-api-key': env.ANTHROPIC_API_KEY,
    'anthropic-version': ANTHROPIC_VERSION,
  };
  // 安全分類器拒答時，由 Anthropic 端自動改用建議的備援模型回答（Haiku 沒有備援，不送）
  if (/^claude-(opus-5|fable-5|sonnet-5-5)/.test(model)) {
    payload.fallbacks = 'default';
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  }

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!upstream.ok) {
    const detail = await upstream.text();
    console.error('Claude API error', upstream.status, detail);
    const msg = upstream.status === 429 || upstream.status === 529
      ? '目前使用人數較多，請稍後再試'
      : 'AI 服務暫時無法回應';
    return json({ error: msg }, 502, cors);
  }

  const { readable, writable } = new TransformStream();
  const pump = relay(upstream.body, writable);
  if (ctx && ctx.waitUntil) ctx.waitUntil(pump);
  return new Response(readable, {
    headers: { ...cors, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
  });
}

/** 把 Claude 的 SSE 轉成前端用的精簡格式：{t: 文字} … {done: true, stop: stop_reason}。 */
async function relay(body, writable) {
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = obj => writer.write(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buffer = '';
  let stop = null;
  try {
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
    await send({ done: true, stop });
  } catch (err) {
    console.error(err);
    await send({ error: 'AI 回答中斷' }).catch(() => {});
  } finally {
    await writer.close().catch(() => {});
  }
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
  if (kbCache.text && kbCache.base === base && Date.now() - kbCache.at < KB_TTL_MS) return kbCache.text;

  const index = await fetch(new URL('kb/index.json', base)).then(r => {
    if (!r.ok) throw new Error(`kb/index.json ${r.status}`);
    return r.json();
  });
  const docs = await Promise.all(index.files.map(async file => {
    const res = await fetch(new URL('kb/' + file, base));
    if (!res.ok) throw new Error(`kb/${file} ${res.status}`);
    return toDocument(file, await res.text());
  }));
  const text = `<knowledge_base>\n${docs.join('\n')}\n</knowledge_base>`;
  kbCache = { at: Date.now(), text, base };
  return text;
}

function toDocument(file, raw) {
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
  text = text.replace(/<!--[\s\S]*?-->/g, '').trim(); // 管理者註解不給 AI
  const attr = s => String(s || '').replace(/"/g, '&quot;');
  return `<document title="${attr(meta.title || file)}" source="${attr(meta.source)}" updated="${attr(meta.updated)}">\n${text}\n</document>`;
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

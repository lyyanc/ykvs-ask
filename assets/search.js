// 知識庫檢索：把 Markdown 依標題切段，用中文雙字詞（bigram）+ BM25 排序。
// 不需任何外部套件，瀏覽器直接執行。

const STOP = new Set('的了是我你他她它們要在有和與及或嗎呢吧啊喔哦請問什麼怎麼哪個這那就也都還會能可以一'.split(''));
// 問句常見的雙字詞，沒有鑑別力
const STOP2 = new Set(['如何', '怎麼', '什麼', '哪裡', '哪個', '哪些', '可以', '需要', '應該', '請問', '今天', '我要', '我想', '要去', '一下', '知道', '問題', '有沒', '沒有', '是不', '不是', '要怎', '麼辦', '找誰']);

/** 解析一份知識庫 Markdown，回傳 { title, source, chunks }。 */
export function parseDoc(file, raw) {
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
  // <!-- --> 是給管理者看的註解，不進入檢索也不給 AI
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  const h1 = text.match(/^#\s+(.+)$/m);
  const title = meta.title || (h1 ? h1[1].trim() : file.replace(/\.md$/, ''));
  // source：學校網站網址；origin：紙本或 PDF 文件的出處說明（例如「115親職手冊 p.11–28」）
  const doc = { file, title, source: meta.source || '', origin: meta.origin || '', updated: meta.updated || '', chunks: [] };

  // 依 ## 切段；# 標題之後、第一個 ## 之前的文字當作「概述」
  const parts = text.split(/^##\s+/m);
  const intro = parts.shift().replace(/^#\s+.+$/m, '').trim();
  if (intro) pushChunk(doc, '概述', intro);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const heading = (nl < 0 ? part : part.slice(0, nl)).trim();
    const body = nl < 0 ? '' : part.slice(nl + 1).trim();
    if (body) pushChunk(doc, heading, body);
  }
  return doc;
}

function pushChunk(doc, heading, body) {
  // 太長的段落依空行再切，避免一段吃掉所有分數
  const blocks = body.length > 900 ? splitBlocks(body, 700) : [body];
  blocks.forEach((b, i) => {
    doc.chunks.push({
      id: `${doc.file}#${heading}${blocks.length > 1 ? '-' + (i + 1) : ''}`,
      docTitle: doc.title,
      heading,
      source: doc.source,
      origin: doc.origin,
      text: b,
    });
  });
}

function splitBlocks(body, size) {
  const out = [];
  let cur = '';
  for (const para of body.split(/\n{2,}/)) {
    if (cur && cur.length + para.length > size) { out.push(cur); cur = ''; }
    cur = cur ? cur + '\n\n' + para : para;
  }
  if (cur) out.push(cur);
  return out;
}

/** 斷詞：中文取單字（去除虛字）與相鄰雙字，英數字取整個字。 */
export function tokenize(s) {
  const out = [];
  const re = /[㐀-鿿豈-﫿]+|[a-z0-9]+/g;
  let m;
  s = s.toLowerCase();
  while ((m = re.exec(s))) {
    const w = m[0];
    if (/^[a-z0-9]/.test(w)) { out.push(w); continue; }
    for (let i = 0; i < w.length; i++) {
      if (!STOP.has(w[i])) out.push(w[i]);
      if (i + 1 < w.length && !STOP2.has(w[i] + w[i + 1])) out.push(w[i] + w[i + 1]);
    }
  }
  return out;
}

export class SearchIndex {
  constructor(docs, synonyms = {}) {
    this.synonyms = synonyms;
    this.chunks = docs.flatMap(d => d.chunks);
    this.df = new Map();
    this.tf = this.chunks.map(c => {
      // 標題加權：標題詞重複計入
      const toks = tokenize(`${c.docTitle} ${c.heading} ${c.heading} ${c.text}`);
      const tf = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
      return { tf, len: toks.length };
    });
    this.avgLen = this.tf.reduce((s, x) => s + x.len, 0) / Math.max(1, this.tf.length);
  }

  expand(query) {
    let q = query;
    for (const [key, words] of Object.entries(this.synonyms)) {
      if (query.includes(key)) q += ' ' + words.join(' ');
    }
    return [...new Set(tokenize(q))];
  }

  /** 回傳 [{ chunk, score }]，已依分數排序並濾掉明顯不相關的段落。 */
  search(query, k = 3) {
    const terms = this.expand(query);
    const N = this.chunks.length;
    const k1 = 1.2, b = 0.75;
    const scored = this.tf.map(({ tf, len }, i) => {
      let score = 0;
      let words = 0;
      for (const t of terms) {
        const f = tf.get(t);
        if (!f) continue;
        if (t.length >= 2) words++;
        const df = this.df.get(t);
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        // 雙字詞比單字更有鑑別力
        const w = t.length >= 2 ? 1.6 : 1;
        score += w * idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * len / this.avgLen));
      }
      // 只有零散單字相符、沒有任何詞相符的段落視為不相關
      return { chunk: this.chunks[i], score: words ? score : 0 };
    }).filter(r => r.score > 0).sort((a, b) => b.score - a.score);

    if (!scored.length || scored[0].score < 2) return [];
    const top = scored[0].score;
    return scored.filter(r => r.score >= top * 0.4).slice(0, k);
  }

  /** 從段落中挑出與問題最相關的幾行，當作檢索模式的「重點」。 */
  keyLines(query, chunk, n = 2) {
    // 中文取雙字詞；英數字（如學號開頭的「4」）要整個字相符，避免 4 對到 114
    const tests = this.expand(query)
      .filter(t => t.length >= 2 || /^[a-z0-9]+$/.test(t))
      .map(t => ({
        t,
        hit: /^[a-z0-9]+$/.test(t)
          ? (re => s => re.test(s))(new RegExp(`(^|[^a-z0-9])${t}([^a-z0-9]|$)`))
          : s => s.includes(t),
      }));
    const N = this.chunks.length;
    const lines = chunk.text.split('\n').map(l => l.trim());
    const scored = lines.map((line, i) => {
      const lower = line.toLowerCase();
      let score = 0;
      for (const { t, hit } of tests) if (hit(lower)) score += Math.log(1 + N / (this.df.get(t) || 1));
      return { i, score };
    }).filter(r => r.score > 0 && !lines[r.i].startsWith('#'));
    if (!scored.length) return [];
    const best = Math.max(...scored.map(r => r.score));
    const picked = new Set(scored.filter(r => r.score >= best * 0.6)
      .sort((a, b) => b.score - a.score).slice(0, n).map(r => r.i));
    // 以「：」結尾的引言句，連同後面的條列一起帶出，答案才完整
    for (const i of [...picked]) {
      if (!/[：:]$/.test(lines[i])) continue;
      for (let j = i + 1; j < lines.length && j <= i + 8; j++) {
        if (!lines[j]) { if (j > i + 1) break; continue; }
        if (!/^([-*•]|\d+[.)、])/.test(lines[j])) break;
        picked.add(j);
      }
    }
    return [...picked].sort((a, b) => a - b)
      .map(i => lines[i].replace(/^([-*•]|\d+[.)、])\s*/, ''));
  }

  /** 問題本身的詞（不含同義詞）有多少比例出現在這個段落，用來判斷檢索結果夠不夠明確。 */
  coverage(query, chunk) {
    const terms = [...new Set(tokenize(query))].filter(t => t.length >= 2 || /^[a-z0-9]+$/.test(t));
    if (!terms.length) return 0;
    const text = `${chunk.docTitle} ${chunk.heading} ${chunk.text}`.toLowerCase();
    return terms.filter(t => text.includes(t)).length / terms.length;
  }

  /** 與某段落相關的其他段落：同一份文件的前後段，用來產生檢索模式的「延伸提問」。 */
  neighbors(chunk, n = 3) {
    const i = this.chunks.indexOf(chunk);
    const out = [];
    for (const j of [i + 1, i - 1, i + 2, i - 2, i + 3]) {
      const c = this.chunks[j];
      if (c && c.docTitle === chunk.docTitle && c.heading !== '概述' && c.heading !== chunk.heading) out.push(c);
      if (out.length >= n) break;
    }
    return out;
  }

  /** 問題中可以在資料裡標示出來的關鍵詞（中文雙字詞以上）。 */
  highlightTerms(query) {
    return this.expand(query).filter(t => t.length >= 2 && /[㐀-鿿]/.test(t) && this.df.has(t));
  }
}

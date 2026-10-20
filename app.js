// Crib: turns lecture materials into a revision sheet and slideshow.
// Runs entirely in the browser. The only network request it makes is to api.anthropic.com.
import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';

const $ = (s, r = document) => r.querySelector(s);
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), 3800); }

const asset = p => new URL(p, import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = asset('./vendor/pdfjs/pdf.worker.min.mjs');
const PDF_OPTS = {
  isEvalSupported: false, enableXfa: false,
  cMapUrl: asset('./vendor/pdfjs/cmaps/'), cMapPacked: true,
  standardFontDataUrl: asset('./vendor/pdfjs/standard_fonts/'),
  wasmUrl: asset('./vendor/pdfjs/wasm/'), iccUrl: asset('./vendor/pdfjs/iccs/'),
};

const MAX_CHARS = 170000;
const IMG = { maxCount: 20, maxEdge: 1600 };
const state = { files: [], result: null, slide: 0, revealed: new Set(), ctl: null, busy: false };

/* ---------- API key + model settings ---------- */
const KEY_STORE = 'crib.apiKey', MODEL_STORE = 'crib.model';
const store = {
  get(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};
let sessionKey = '';
const keyInput = $('#apiKey'), remember = $('#rememberKey'), modelSel = $('#model');
function currentKey() { return keyInput.value.trim() || sessionKey; }
function refreshKeyUi() {
  const k = currentKey();
  $('#keySummary').textContent = k ? 'Claude API key added' : 'Add your Claude API key';
  $('#forgetKey').hidden = !k;
}
(function initKey() {
  const saved = store.get(KEY_STORE);
  if (saved) { keyInput.value = saved; remember.checked = true; }
  const m = store.get(MODEL_STORE);
  if (m && [...modelSel.options].some(o => o.value === m)) modelSel.value = m;
  $('#keyBox').open = !saved;
  refreshKeyUi();
})();
keyInput.addEventListener('input', () => { sessionKey = keyInput.value.trim(); if (remember.checked) store.set(KEY_STORE, sessionKey); refreshKeyUi(); });
remember.addEventListener('change', () => { if (remember.checked && currentKey()) store.set(KEY_STORE, currentKey()); else store.del(KEY_STORE); });
modelSel.addEventListener('change', () => store.set(MODEL_STORE, modelSel.value));
$('#forgetKey').onclick = () => { store.del(KEY_STORE); keyInput.value = ''; sessionKey = ''; remember.checked = false; refreshKeyUi(); keyInput.focus(); };

/* ---------- files ---------- */
function kindOf(f) {
  const n = f.name.toLowerCase();
  if (n.endsWith('.pdf')) return 'pdf';
  if (n.endsWith('.pptx')) return 'pptx';
  if (n.endsWith('.docx')) return 'docx';
  if (/\.(txt|md|markdown|csv)$/.test(n)) return 'txt';
  if (/^image\//.test(f.type) || /\.(png|jpe?g|webp|gif)$/.test(n)) return 'image';
  if (/\.(ppt|doc|key|pages)$/.test(n)) return 'old';
  return 'unknown';
}
const KIND_LABEL = { pdf: 'PDF', pptx: 'Slides', docx: 'Word', txt: 'Text', image: 'Photo' };
function fmtSize(b) { return b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB'; }

function addFiles(list) {
  const rejected = [];
  for (const f of list) {
    const k = kindOf(f);
    if (k === 'old') { rejected.push(`${f.name}: save it as .pptx, .docx or PDF first`); continue; }
    if (k === 'unknown') { rejected.push(`${f.name}: this file type isn’t supported`); continue; }
    if (state.files.some(x => x.file.name === f.name && x.file.size === f.size)) continue;
    state.files.push({ file: f, kind: k });
  }
  renderFiles();
  if (rejected.length) toast(rejected.join('. '));
}
function renderFiles() {
  const ul = $('#fileList'); ul.replaceChildren();
  state.files.forEach((it, i) => {
    const li = el('li');
    li.append(el('span', 'kind', KIND_LABEL[it.kind]), el('span', 'name', it.file.name), el('span', 'size', fmtSize(it.file.size)));
    const rm = el('button', null, '×'); rm.setAttribute('aria-label', 'Remove ' + it.file.name);
    rm.onclick = () => { state.files.splice(i, 1); renderFiles(); };
    li.append(rm); ul.append(li);
  });
}
const drop = $('#drop'), fileInput = $('#fileInput');
$('#pick').onclick = e => { e.stopPropagation(); fileInput.click(); };
drop.onclick = () => fileInput.click();
drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } };
fileInput.onchange = () => { addFiles(fileInput.files); fileInput.value = ''; };
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => { if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); });

/* ---------- extraction ---------- */
async function canvasToBlob(canvas) { return new Promise(res => canvas.toBlob(b => res(b), 'image/jpeg', 0.82)); }

async function readPdf(file, step, imageBudget) {
  const task = pdfjsLib.getDocument({ ...PDF_OPTS, data: new Uint8Array(await file.arrayBuffer()) });
  const pdf = await task.promise;
  const pages = [];
  let chars = 0;
  for (let i = 1; i <= pdf.numPages; i++) {
    step(`Reading ${file.name} (page ${i} of ${pdf.numPages})`);
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    const txt = tc.items.map(it => (it.str || '') + (it.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+/g, ' ').trim();
    chars += txt.length;
    pages.push(txt);
  }
  const images = [];
  const scanned = chars / Math.max(1, pdf.numPages) < 40;
  if (scanned && imageBudget > 0) {
    const n = Math.min(pdf.numPages, imageBudget);
    for (let i = 1; i <= n; i++) {
      step(`Looking at scanned page ${i} of ${n} in ${file.name}`);
      const page = await pdf.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: Math.min(2, IMG.maxEdge / Math.max(base.width, base.height)) });
      const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
      await page.render({ canvas: c, canvasContext: c.getContext('2d'), viewport: vp }).promise;
      const b = await canvasToBlob(c); if (b) images.push(b);
    }
  }
  const text = pages.map((t, i) => t ? `[Page ${i + 1}]\n${t}` : '').filter(Boolean).join('\n\n');
  task.destroy();
  return { text, images, scanned, pageCount: pdf.numPages };
}

async function readPptx(file) {
  const zip = await JSZip.loadAsync(file);
  const num = n => +n.match(/(\d+)\.xml$/)[1];
  const slideNames = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => num(a) - num(b));
  const parse = async name => {
    const xml = new DOMParser().parseFromString(await zip.file(name).async('string'), 'application/xml');
    return [...xml.getElementsByTagName('a:p')].map(p => [...p.getElementsByTagName('a:t')].map(t => t.textContent).join('')).filter(s => s.trim()).join('\n');
  };
  const out = [];
  for (const n of slideNames) {
    const body = await parse(n);
    const noteName = `ppt/notesSlides/notesSlide${num(n)}.xml`;
    let notes = '';
    if (zip.file(noteName)) notes = (await parse(noteName)).split('\n').filter(l => !/^\d+$/.test(l.trim())).join('\n');
    out.push(`[Slide ${num(n)}]\n${body}${notes ? `\nSpeaker notes: ${notes}` : ''}`);
  }
  return out.join('\n\n');
}

async function readDocx(file) {
  const r = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return r.value;
}

// Every photo is re-encoded as a JPEG no larger than IMG.maxEdge, which keeps requests small
// and drops any metadata (such as GPS location) the original photo carried.
async function prepImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, IMG.maxEdge / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return canvasToBlob(c);
}

async function extractAll(step) {
  const blocks = [], images = [], notes = [];
  const cap = IMG.maxCount;
  for (const it of state.files) {
    const f = it.file;
    step(`Reading ${f.name}`);
    try {
      if (it.kind === 'pdf') {
        const r = await readPdf(f, step, cap - images.length);
        if (r.text) blocks.push(`=== FILE: ${f.name} (PDF, ${r.pageCount} pages) ===\n${r.text}`);
        images.push(...r.images);
        if (r.scanned && !r.images.length) notes.push(`${f.name} looks scanned, so little text could be read from it`);
      } else if (it.kind === 'pptx') {
        blocks.push(`=== FILE: ${f.name} (PowerPoint) ===\n${await readPptx(f)}`);
      } else if (it.kind === 'docx') {
        blocks.push(`=== FILE: ${f.name} (Word) ===\n${await readDocx(f)}`);
      } else if (it.kind === 'txt') {
        blocks.push(`=== FILE: ${f.name} (notes) ===\n${await f.text()}`);
      } else if (it.kind === 'image') {
        if (images.length < cap) { const b = await prepImage(f); if (b) images.push(b); }
        else notes.push(`${f.name} was left out (limit of ${cap} images per kit)`);
      }
    } catch (e) {
      console.warn('Could not read', f.name, e);
      notes.push(`${f.name} couldn’t be read`);
    }
  }
  const pasted = $('#pasted').value.trim();
  if (pasted) blocks.push(`=== STUDENT'S OWN NOTES ===\n${pasted}`);
  let text = blocks.join('\n\n');
  if (text.length > MAX_CHARS) { text = text.slice(0, MAX_CHARS); notes.push('the material was very long, so only the first part was used'); }
  return { text, images: images.slice(0, cap), notes };
}

/* ---------- prompt ---------- */
const RULES = `You turn a university student's lecture materials into exam revision material: a revision sheet that must fit on two A4 pages (about 700 to 900 words, not counting self-test answers) and a slide deck for revising.

How to work:
1. Read everything, including any attached images (scanned pages or photos of handwritten notes). Work out the module, the week and the topic if you can; use "" for anything that can't be worked out.
2. Pick the 3 to 7 core concepts. Everything else is supporting detail.
3. Mark anything the lecturer stressed ("important", "this will come up", "!!", underlining, repeated emphasis) with "stressed": true.
4. Find or build one small worked example that shows the main idea in use (code 10 lines or fewer, in the lecture's language, if code fits the topic).
5. Write gotchas (common mistakes, easily confused pairs), 3 likely exam questions each with a one-line pointer to the answer, and 5 self-test recall questions with answers.

Rules:
- Keep the lecturer's terms, notation and variable names. Explain them in plain words but don't rename them.
- Anything not in the materials (an example, a definition, a clarification) must be flagged with "added": true where the field exists, otherwise end that text with " (added)".
- Exam questions are predictions. Never claim the lecturer said something will be examined unless the materials say so.
- If a concept is unclear in the materials, put it in "gaps" instead of guessing. Leave arrays empty rather than padding them.
- Self-test questions test recall and understanding, not trivia like slide numbers.
- Include a diagram only when a process, pipeline, cycle or sequence is central to the topic: 3 to 8 nodes, each label 6 words or fewer. Otherwise set diagram.kind to "none" and nodes to [].
- Plain text everywhere: no Markdown, no LaTeX. Write maths inline like O(n log n) or x^2.
- UK English spelling.

Slides: 12 to 20 slides that help someone revise the night before an exam. Start with a title slide, give each core concept its own slide, include the diagram slide (if there is a diagram) and the worked example, add a mnemonic slide only where a memory aid genuinely helps, spread 4 to 6 quiz slides through the deck (not all at the end), and finish with a recap. At most 5 bullet points per slide, each 14 words or fewer.

Reply with ONLY one JSON object in exactly this shape:
{
  "module": "",
  "week": "",
  "topic": "",
  "bigIdea": "one sentence: what this lecture is really about",
  "concepts": [{"term": "", "definition": "25 words or fewer", "stressed": false, "added": false}],
  "howItWorks": {"kind": "steps", "items": ["step or formula line, explaining each variable"]},
  "diagram": {"title": "", "kind": "flow", "nodes": ["short label"]},
  "workedExample": {"prompt": "", "solution": "", "code": "", "added": false},
  "gotchas": [""],
  "examQuestions": [{"question": "", "pointer": ""}],
  "selfTest": [{"q": "", "a": ""}],
  "gaps": [""],
  "slides": [
    {"type": "title", "heading": "", "subheading": ""},
    {"type": "concept", "term": "", "definition": "", "example": "", "stressed": false},
    {"type": "points", "heading": "", "points": [""]},
    {"type": "diagram", "heading": ""},
    {"type": "example", "heading": "", "prompt": "", "solution": "", "code": ""},
    {"type": "quiz", "question": "", "answer": ""},
    {"type": "mnemonic", "heading": "", "device": "", "explanation": ""},
    {"type": "recap", "heading": "", "points": [""]}
  ]
}
howItWorks.kind is "steps" or "formula". diagram.kind is "flow", "cycle" or "none". A "diagram" slide shows the diagram above.`;

function buildPrompt(text, imgCount) {
  const hint = $('#hint').value.trim();
  return `${RULES}

${hint ? `The student says this is: ${hint}\n\n` : ''}${imgCount ? `${imgCount} image(s) are attached as part of the materials.\n\n` : ''}LECTURE MATERIALS:

${text || '(No text was extracted; use the attached images.)'}`;
}

/* ---------- normalise ---------- */
const S = v => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();
const A = v => (Array.isArray(v) ? v : []);
function normalise(r) {
  r = r && typeof r === 'object' ? r : {};
  const out = {
    module: S(r.module), week: S(r.week), topic: S(r.topic) || 'Lecture summary', bigIdea: S(r.bigIdea),
    concepts: A(r.concepts).map(c => ({ term: S(c?.term), definition: S(c?.definition), stressed: !!c?.stressed, added: !!c?.added })).filter(c => c.term),
    howItWorks: { kind: S(r.howItWorks?.kind) === 'formula' ? 'formula' : 'steps', items: A(r.howItWorks?.items).map(S).filter(Boolean) },
    diagram: { title: S(r.diagram?.title), kind: ['flow', 'cycle'].includes(S(r.diagram?.kind)) ? S(r.diagram.kind) : 'none', nodes: A(r.diagram?.nodes).map(S).filter(Boolean).slice(0, 8) },
    workedExample: { prompt: S(r.workedExample?.prompt), solution: S(r.workedExample?.solution), code: S(r.workedExample?.code), added: !!r.workedExample?.added },
    gotchas: A(r.gotchas).map(S).filter(Boolean),
    examQuestions: A(r.examQuestions).map(q => ({ question: S(q?.question), pointer: S(q?.pointer) })).filter(q => q.question),
    selfTest: A(r.selfTest).map(q => ({ q: S(q?.q), a: S(q?.a) })).filter(q => q.q),
    gaps: A(r.gaps).map(S).filter(Boolean),
  };
  if (out.diagram.nodes.length < 2) out.diagram.kind = 'none';
  const types = ['title', 'concept', 'points', 'diagram', 'example', 'quiz', 'mnemonic', 'recap'];
  out.slides = A(r.slides).map(s => {
    const t = types.includes(S(s?.type)) ? S(s.type) : 'points';
    return { type: t, heading: S(s?.heading), subheading: S(s?.subheading), term: S(s?.term), definition: S(s?.definition), example: S(s?.example), stressed: !!s?.stressed, points: A(s?.points).map(S).filter(Boolean).slice(0, 6), prompt: S(s?.prompt), solution: S(s?.solution), code: S(s?.code), question: S(s?.question), answer: S(s?.answer), device: S(s?.device), explanation: S(s?.explanation) };
  }).filter(s => !(s.type === 'diagram' && out.diagram.kind === 'none'));
  if (!out.slides.length || out.slides[0].type !== 'title') out.slides.unshift({ type: 'title', heading: out.topic, subheading: out.bigIdea, points: [] });
  return out;
}

/* ---------- generate ---------- */
const ERR = {
  no_key: 'Add your Claude API key first (under “Add your Claude API key”).',
  bad_key: 'That API key wasn’t accepted. Check it, or create a new one in the Anthropic Console.',
  forbidden: 'That API key isn’t allowed to use this model. Try another model, or check the key’s permissions.',
  rate_limited: 'Too many requests just now. Wait a minute, then try again.',
  overloaded: 'Claude is busy right now. Try again in a minute.',
  too_large: 'That’s too much material for one go. Remove a file or two and try again.',
  truncated: 'The kit was too long to finish. Try again with fewer files.',
  invalid_json: 'The kit came back incomplete. Try again, or use fewer files.',
  network: 'Couldn’t reach Anthropic. Check your connection and try again.',
  cancelled: 'Stopped. Nothing was generated.',
};
function setStatus(msg, kind) {
  const s = $('#status'); s.classList.add('on'); s.classList.toggle('err', kind === 'err'); s.classList.toggle('done', kind === 'done');
  s.querySelector('.msg').textContent = msg;
}
function clearStatus() { $('#status').classList.remove('on', 'err', 'done'); }
function fail(code, message) { const e = new Error(message || code); e.code = code; return e; }

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

// Calls the Anthropic Messages API directly from the browser and streams the reply.
async function askClaude(prompt, images, signal, onText) {
  const key = currentKey();
  if (!key) throw fail('no_key');
  const content = [];
  for (const b of images) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await blobToBase64(b) } });
  content.push({ type: 'text', text: prompt });
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal, referrerPolicy: 'no-referrer', credentials: 'omit',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model: modelSel.value, max_tokens: 16000, stream: true, messages: [{ role: 'user', content }] }),
    });
  } catch (e) {
    if (e.name === 'AbortError') throw fail('cancelled');
    throw fail('network');
  }
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json())?.error?.message || ''; } catch { /* no body */ }
    const code = { 401: 'bad_key', 403: 'forbidden', 413: 'too_large', 429: 'rate_limited', 529: 'overloaded' }[res.status];
    if (code) throw fail(code);
    throw fail('api', msg ? `Anthropic said: ${msg}` : `The request failed (HTTP ${res.status}).`);
  }
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '', text = '', stop = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = chunk.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
        if (!data) continue;
        let ev; try { ev = JSON.parse(data); } catch { continue; }
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') { text += ev.delta.text; onText(text); }
        else if (ev.type === 'message_delta' && ev.delta?.stop_reason) stop = ev.delta.stop_reason;
        else if (ev.type === 'error') {
          const t = ev.error?.type;
          throw t === 'overloaded_error' ? fail('overloaded') : t === 'rate_limit_error' ? fail('rate_limited') : fail('api', ev.error?.message ? `Anthropic said: ${ev.error.message}` : '');
        }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') throw fail('cancelled');
    throw e;
  }
  if (stop === 'max_tokens') throw fail('truncated');
  return text;
}

function parseJson(text) {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch { /* fall through */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* fall through */ } }
  throw fail('invalid_json');
}

$('#goBtn').onclick = async () => {
  if (state.busy) return;
  if (!state.files.length && !$('#pasted').value.trim()) { setStatus('Add at least one file or paste some notes first.', 'err'); return; }
  if (!currentKey()) { $('#keyBox').open = true; keyInput.focus(); setStatus(ERR.no_key, 'err'); return; }
  state.busy = true; $('#goBtn').disabled = true;
  try {
    setStatus('Getting ready');
    const { text, images, notes } = await extractAll(m => setStatus(m));
    if (!text.trim() && !images.length) { setStatus('No readable text was found in those files. Try a different file or paste the notes.', 'err'); return; }
    const prompt = buildPrompt(text, images.length);
    state.ctl = new AbortController();
    $('#stopBtn').hidden = false;
    setStatus('Claude is reading your lecture. This usually takes a minute or two.');
    const reply = await askClaude(prompt, images, state.ctl.signal, t => {
      const i = t.indexOf('"slides"');
      const n = i < 0 ? 0 : (t.slice(i).match(/"type"\s*:/g) || []).length;
      setStatus(i < 0 ? 'Writing your summary sheet' : `Writing slides (${n} so far)`);
    });
    const result = normalise(parseJson(reply));
    result.createdAt = Date.now();
    saveRecent(result);
    showResult(result);
    clearStatus();
    if (notes.length) toast('Note: ' + notes.join('; ') + '.');
  } catch (e) {
    const code = e && e.code;
    const msg = ERR[code] || (code === 'api' && e.message) || 'Something went wrong making your kit. Try again.';
    setStatus(msg, code === 'cancelled' ? 'done' : 'err');
  } finally {
    state.busy = false; $('#goBtn').disabled = false; $('#stopBtn').hidden = true; state.ctl = null;
  }
};
$('#stopBtn').onclick = () => state.ctl?.abort();

/* ---------- recent ---------- */
const RKEY = 'crib.recent.v1';
function loadRecent() { try { return JSON.parse(localStorage.getItem(RKEY) || '[]'); } catch { return []; } }
function saveRecent(r) {
  try {
    const list = loadRecent().filter(x => x.createdAt !== r.createdAt);
    list.unshift(r);
    localStorage.setItem(RKEY, JSON.stringify(list.slice(0, 6)));
  } catch { /* storage full or unavailable */ }
  renderRecent();
}
function renderRecent() {
  const list = loadRecent();
  $('#recent').hidden = !list.length;
  const ul = $('#recentList'); ul.replaceChildren();
  for (const r of list) {
    const b = el('button'); b.append(document.createTextNode(r.topic || 'Lecture'));
    b.append(el('small', null, [r.module, new Date(r.createdAt).toLocaleDateString()].filter(Boolean).join(', ')));
    b.onclick = () => showResult(normalise(r), r.createdAt);
    const li = el('li'); li.append(b); ul.append(li);
  }
}

/* ---------- views ---------- */
function weekLabel(w) { return w ? (/^\d+$/.test(w) ? 'Week ' + w : w) : ''; }
function showResult(r, createdAt) {
  if (createdAt) r.createdAt = createdAt;
  state.result = r; state.slide = 0; state.revealed = new Set();
  $('#input').hidden = true; $('#results').classList.add('on'); $('#newBtn').hidden = false;
  $('#resTitle').textContent = r.topic;
  $('#resMeta').textContent = [r.module, weekLabel(r.week)].filter(Boolean).join(', ') || `${r.slides.length} slides`;
  renderSheet(r); renderSlide(); selectTab('sheet');
  window.scrollTo({ top: 0 });
}
$('#newBtn').onclick = () => {
  exitFocus();
  state.result = null; $('#results').classList.remove('on'); $('#input').hidden = false; $('#newBtn').hidden = true;
  state.files = []; renderFiles(); $('#pasted').value = ''; $('#hint').value = ''; clearStatus(); renderRecent();
};
function selectTab(which) {
  $('#tabSheet').setAttribute('aria-selected', which === 'sheet'); $('#tabSlides').setAttribute('aria-selected', which === 'slides');
  $('#paneSheet').hidden = which !== 'sheet'; $('#paneSlides').hidden = which !== 'slides';
  if (which === 'slides') $('#stage').focus({ preventScroll: true });
}
$('#tabSheet').onclick = () => selectTab('sheet');
$('#tabSlides').onclick = () => selectTab('slides');

/* ---------- diagram (svg) ---------- */
const NS = 'http://www.w3.org/2000/svg';
function sv(tag, attrs, style) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (style) e.style.cssText = style; return e; }
function wrapWords(s, max, maxLines = 3) {
  const words = s.split(/\s+/); const lines = []; let cur = '';
  for (const w of words) { if ((cur + ' ' + w).trim().length > max && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) { const keep = lines.slice(0, maxLines); keep[maxLines - 1] += '…'; return keep; }
  return lines;
}
function layout(n) { const cols = n <= 4 ? n : Math.ceil(n / 2); return { cols, rows: Math.ceil(n / cols) }; }
function gridPos(i, cols) { const r = Math.floor(i / cols), k = i % cols; return { r, c: r % 2 ? cols - 1 - k : k }; }
diagramSvg.n = 0;
function diagramSvg(d) {
  const nodes = d.nodes, n = nodes.length, { cols, rows } = layout(n);
  const bw = 168, bh = 72, gx = 40, gy = 46, extra = d.kind === 'cycle' ? 34 : 0;
  const W = cols * bw + (cols - 1) * gx, H = rows * bh + (rows - 1) * gy + extra;
  const svg = sv('svg', { viewBox: `-2 -2 ${W + 4} ${H + 4}`, width: W, role: 'img', 'aria-label': (d.title || 'Diagram') + ': ' + nodes.join(', then ') });
  const defs = sv('defs'); const mid = 'ah' + (++diagramSvg.n); const m = sv('marker', { id: mid, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
  m.append(sv('path', { d: 'M0,0 L10,5 L0,10 z' }, 'fill:var(--blue)')); defs.append(m); svg.append(defs);
  const P = i => { const g = gridPos(i, cols); return { x: g.c * (bw + gx), y: g.r * (bh + gy) }; };
  for (let i = 0; i < n - 1; i++) {
    const a = P(i), b = P(i + 1); let x1, y1, x2, y2;
    if (a.y === b.y) { y1 = y2 = a.y + bh / 2; if (b.x > a.x) { x1 = a.x + bw; x2 = b.x - 2; } else { x1 = a.x; x2 = b.x + bw + 2; } }
    else { x1 = x2 = a.x + bw / 2; y1 = a.y + bh; y2 = b.y - 2; }
    svg.append(sv('line', { x1, y1, x2, y2, 'marker-end': `url(#${mid})` }, 'stroke:var(--blue);stroke-width:2'));
  }
  nodes.forEach((label, i) => {
    const p = P(i);
    svg.append(sv('rect', { x: p.x, y: p.y, width: bw, height: bh, rx: 10 }, 'fill:var(--surface);stroke:var(--blue);stroke-width:1.5'));
    const num = sv('text', { x: p.x + 10, y: p.y + 17 }, 'fill:var(--muted);font:600 11px var(--sans)'); num.textContent = i + 1; svg.append(num);
    const lines = wrapWords(label, 19);
    const t = sv('text', { x: p.x + bw / 2, y: p.y + bh / 2 + 5 - (lines.length - 1) * 9, 'text-anchor': 'middle' }, 'fill:var(--ink);font:600 15px var(--sans)');
    lines.forEach((ln, j) => { const ts = sv('tspan', { x: p.x + bw / 2, dy: j ? 18 : 0 }); ts.textContent = ln; t.append(ts); });
    svg.append(t);
  });
  if (d.kind === 'cycle') { const t = sv('text', { x: W / 2, y: H - 8, 'text-anchor': 'middle' }, 'fill:var(--muted);font:500 14px var(--sans)'); t.textContent = '↻ then repeats from step 1'; svg.append(t); }
  const wrap = el('div', 'diagram'); wrap.append(svg); return wrap;
}

/* ---------- summary sheet ---------- */
function withAdded(node, text, added) {
  node.append(document.createTextNode(text));
  if (added && !/\(added\)\s*$/.test(text)) node.append(document.createTextNode(' '), el('span', 'added', '(added)'));
  return node;
}
function renderSheet(r) {
  const s = $('#sheet'); s.replaceChildren();
  const meta = [r.module, weekLabel(r.week)].filter(Boolean).join(', ');
  if (meta) s.append(el('p', 'sheet-meta', meta));
  s.append(el('h2', 'sheet-title', r.topic));
  if (r.bigIdea) { const p = el('p', 'big-idea'); p.append(el('strong', null, 'Big idea: '), document.createTextNode(r.bigIdea)); s.append(p); }
  s.append(el('p', 'legend', 'Highlighted terms were stressed in the lecture. Anything marked (added) isn’t in your materials, so check it.'));
  const sec = t => { s.append(el('h3', null, t)); };
  if (r.concepts.length) {
    sec('Key concepts');
    const dl = el('dl');
    r.concepts.forEach(c => { const d = el('div', 'def'); const dt = el('dt'); dt.append(el('span', c.stressed ? 'hl' : null, c.term)); dt.append(document.createTextNode(': ')); d.append(dt, withAdded(el('dd'), c.definition, c.added)); dl.append(d); });
    s.append(dl);
  }
  if (r.howItWorks.items.length) {
    sec(r.howItWorks.kind === 'formula' ? 'Formula' : 'How it works');
    const ol = el(r.howItWorks.kind === 'formula' ? 'ul' : 'ol'); r.howItWorks.items.forEach(x => ol.append(el('li', null, x))); s.append(ol);
  }
  if (r.diagram.kind !== 'none') { sec(r.diagram.title || 'Diagram'); s.append(diagramSvg(r.diagram)); }
  const we = r.workedExample;
  if (we.prompt || we.solution || we.code) {
    sec('Worked example');
    if (we.prompt) s.append(withAdded(el('p', null), we.prompt, we.added));
    if (we.code) s.append(el('pre', 'code', we.code));
    if (we.solution) s.append(el('p', null, we.solution));
  }
  if (r.gotchas.length) { sec('Gotchas'); const ul = el('ul'); r.gotchas.forEach(g => ul.append(el('li', null, g))); s.append(ul); }
  if (r.examQuestions.length) {
    sec('Likely exam questions');
    const ol = el('ol'); r.examQuestions.forEach(q => { const li = el('li'); li.append(el('strong', null, q.question)); if (q.pointer) { li.append(el('br'), el('span', 'pointer', q.pointer)); } ol.append(li); }); s.append(ol);
  }
  if (r.selfTest.length) {
    sec('Self-test');
    const ol = el('ol'); r.selfTest.forEach(q => ol.append(el('li', null, q.q))); s.append(ol);
    const det = el('details', 'qa'); det.append(el('summary', null, 'Show answers'));
    const ol2 = el('ol'); r.selfTest.forEach(q => ol2.append(el('li', null, q.a))); det.append(ol2); s.append(det);
  }
  if (r.gaps.length) { sec('Gaps to fill'); const ul = el('ul'); r.gaps.forEach(g => ul.append(el('li', null, g))); s.append(ul); }
}

/* ---------- slides ---------- */
function slideNode(sl, i, r) {
  const d = el('div', 'slide ' + sl.type);
  const kick = t => d.append(el('p', 'kicker', t));
  const head = (t, hl) => { const h = el('h3'); h.append(hl ? el('span', 'hl', t) : document.createTextNode(t)); d.append(h); };
  const list = items => { const ul = el('ul'); items.forEach(x => ul.append(el('li', null, x))); d.append(ul); };
  switch (sl.type) {
    case 'title':
      kick([r.module, weekLabel(r.week)].filter(Boolean).join(', ') || 'Revision');
      head(sl.heading || r.topic, true);
      if (sl.subheading) d.append(el('p', 'serif muted', sl.subheading));
      break;
    case 'concept': {
      kick(sl.stressed ? 'Key concept, stressed in lecture' : 'Key concept');
      const h = el('h3', 'term'); h.append(sl.stressed ? el('span', 'hl', sl.term) : document.createTextNode(sl.term)); d.append(h);
      if (sl.definition) d.append(el('p', 'serif', sl.definition));
      if (sl.example) d.append(el('p', 'muted', 'e.g. ' + sl.example));
      break;
    }
    case 'diagram':
      head(sl.heading || r.diagram.title || 'How it fits together');
      d.append(diagramSvg(r.diagram));
      break;
    case 'example':
      kick('Worked example'); head(sl.heading || 'Example');
      if (sl.prompt) d.append(el('p', 'serif', sl.prompt));
      if (sl.code) d.append(el('pre', 'code', sl.code));
      if (sl.solution) d.append(el('p', 'serif muted', sl.solution));
      break;
    case 'quiz': {
      kick('Quick question'); head(sl.question || 'Question');
      if (state.revealed.has(i)) { const a = el('p', 'serif answer', sl.answer || '(no answer given)'); d.append(a); }
      else { const b = el('button', 'btn reveal', 'Show answer'); b.onclick = e => { e.stopPropagation(); state.revealed.add(i); renderSlide(); }; d.append(b); }
      break;
    }
    case 'mnemonic':
      kick('Memory aid'); head(sl.heading || 'Remember it');
      if (sl.device) d.append(el('p', 'device', sl.device));
      if (sl.explanation) d.append(el('p', 'serif', sl.explanation));
      break;
    case 'recap':
      kick('Recap'); head(sl.heading || 'What to remember'); list(sl.points);
      break;
    default:
      head(sl.heading || ''); list(sl.points);
  }
  return d;
}
function renderSlide() {
  const r = state.result; if (!r) return;
  const n = r.slides.length; state.slide = Math.max(0, Math.min(n - 1, state.slide));
  const stage = $('#stage'); stage.replaceChildren(slideNode(r.slides[state.slide], state.slide, r));
  const foot = el('div', 'slide-foot'); const bar = el('i'); bar.style.width = ((state.slide + 1) / n * 100) + '%'; foot.append(bar); stage.append(foot);
  $('#count').textContent = `${state.slide + 1} of ${n}`;
  $('#prev').disabled = state.slide === 0; $('#next').disabled = state.slide === n - 1;
}
function go(dx) { state.slide += dx; renderSlide(); }
$('#prev').onclick = () => go(-1);
$('#next').onclick = () => go(1);
document.addEventListener('keydown', e => {
  if ($('#paneSlides').hidden || !state.result || /INPUT|TEXTAREA/.test(document.activeElement?.tagName)) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); go(1); }
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(-1); }
  else if (e.key === ' ' && document.activeElement?.tagName !== 'BUTTON') {
    e.preventDefault();
    const sl = state.result.slides[state.slide];
    if (sl.type === 'quiz' && !state.revealed.has(state.slide)) { state.revealed.add(state.slide); renderSlide(); } else go(1);
  }
  else if (e.key === 'Escape') exitFocus();
});
let tx = null;
$('#stage').addEventListener('touchstart', e => { tx = e.touches[0].clientX; }, { passive: true });
$('#stage').addEventListener('touchend', e => { if (tx == null) return; const dx = e.changedTouches[0].clientX - tx; if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1); tx = null; });
function exitFocus() { $('#deck').classList.remove('focus'); $('#focusBtn').textContent = 'Present'; }
$('#focusBtn').onclick = () => { const on = $('#deck').classList.toggle('focus'); $('#focusBtn').textContent = on ? 'Exit' : 'Present'; $('#stage').focus({ preventScroll: true }); };

/* ---------- PDF helpers ---------- */
const MAP = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': ' - ', '…': '...', '•': '-', '★': '*', '→': '->', '←': '<-', '⇒': '=>', '⇔': '<=>', '↔': '<->', '≤': '<=', '≥': '>=', '≠': '!=', '≈': '~', '∞': 'infinity', '√': 'sqrt', '∈': ' in ', '∉': ' not in ', '∑': 'Sum', '∏': 'Product', '∀': 'for all ', '∃': 'there exists ', '∧': ' AND ', '∨': ' OR ', '¬': 'NOT ', '⊕': ' XOR ', 'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta', 'Δ': 'Delta', 'ε': 'epsilon', 'θ': 'theta', 'λ': 'lambda', 'μ': 'mu', 'π': 'pi', 'σ': 'sigma', 'Σ': 'Sigma', 'τ': 'tau', 'φ': 'phi', 'ω': 'omega', 'Ω': 'Omega', '↻': '', '\u00a0': ' ', '\u2011': '-' };
function pdfSafe(s) { return String(s || '').replace(/[^\x00-\xFF]/g, ch => MAP[ch] ?? '').replace(/\t/g, '  '); }
const C = { ink: [30, 36, 51], muted: [91, 100, 120], blue: [37, 70, 184], hl: [255, 225, 77], rule: [220, 225, 235], code: [243, 245, 249], white: [255, 255, 255] };
const PT = 0.3528;

function pdfArrow(doc, x1, y1, x2, y2) {
  doc.setDrawColor(...C.blue); doc.setFillColor(...C.blue); doc.setLineWidth(0.45);
  const a = Math.atan2(y2 - y1, x2 - x1), L = 2.2, Wd = 1.2;
  const bx = x2 - L * Math.cos(a), by = y2 - L * Math.sin(a);
  doc.line(x1, y1, bx, by);
  doc.triangle(x2, y2, bx + Wd * Math.sin(a), by - Wd * Math.cos(a), bx - Wd * Math.sin(a), by + Wd * Math.cos(a), 'F');
}
function pdfDiagram(doc, d, x, y, w, fs) {
  const n = d.nodes.length, { cols, rows } = layout(n);
  const gx = w * 0.045, gy = fs * 1.15;
  const bw = Math.min(w * 0.3, (w - (cols - 1) * gx) / cols), bh = fs * 1.55;
  const total = cols * bw + (cols - 1) * gx, x0 = x + (w - total) / 2;
  const P = i => { const g = gridPos(i, cols); return { x: x0 + g.c * (bw + gx), y: y + g.r * (bh + gy) }; };
  for (let i = 0; i < n - 1; i++) {
    const a = P(i), b = P(i + 1);
    if (a.y === b.y) { const yy = a.y + bh / 2; if (b.x > a.x) pdfArrow(doc, a.x + bw, yy, b.x - 0.4, yy); else pdfArrow(doc, a.x, yy, b.x + bw + 0.4, yy); }
    else pdfArrow(doc, a.x + bw / 2, a.y + bh, a.x + bw / 2, b.y - 0.4);
  }
  d.nodes.forEach((label, i) => {
    const p = P(i);
    doc.setDrawColor(...C.blue); doc.setFillColor(...C.white); doc.setLineWidth(0.35);
    doc.roundedRect(p.x, p.y, bw, bh, 1.6, 1.6, 'FD');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(fs * 0.55); doc.setTextColor(...C.muted);
    doc.text(String(i + 1), p.x + 1.4, p.y + fs * 0.55 * PT + 0.8);
    doc.setFontSize(fs); doc.setTextColor(...C.ink);
    let lines = doc.splitTextToSize(pdfSafe(label), bw - 5);
    if (lines.length > 3) { lines = lines.slice(0, 3); lines[2] += '...'; }
    const lh = fs * PT * 1.18, cy = p.y + bh / 2 - (lines.length - 1) * lh / 2 + fs * PT * 0.35;
    lines.forEach((ln, j) => doc.text(ln, p.x + bw / 2, cy + j * lh, { align: 'center' }));
  });
  let h = rows * bh + (rows - 1) * gy;
  if (d.kind === 'cycle') { doc.setFont('helvetica', 'normal'); doc.setFontSize(fs * 0.85); doc.setTextColor(...C.muted); doc.text('then repeats from step 1', x + w / 2, y + h + fs * PT + 1.5, { align: 'center' }); h += fs * PT + 3; }
  return h;
}

/* ---------- summary PDF ---------- */
function buildSummaryPdf(r, base) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const PW = 210, PH = 297, M = 14, W = PW - 2 * M, BOTTOM = PH - M - 5;
  const LH = s => s * PT * 1.34;
  let y = M;
  const need = h => { if (y + h > BOTTOM) { doc.addPage(); y = M; } };
  const font = (f, st, sz, col) => { doc.setFont(f, st); doc.setFontSize(sz); doc.setTextColor(...col); };

  function para(text, o = {}) {
    const { f = 'times', st = 'normal', sz = base, col = C.ink, indent = 0, after = 1.2 } = o;
    font(f, st, sz, col);
    for (const ln of doc.splitTextToSize(pdfSafe(text), W - indent)) { need(LH(sz)); doc.text(ln, M + indent, y + sz * PT); y += LH(sz); }
    y += after;
  }
  // bold lead + normal remainder, optional highlight on the lead, optional marker
  function rich(lead, rest, o = {}) {
    const { sz = base, indent = 0, hl = false, marker = null, after = 1, restCol = C.ink } = o;
    const x0 = M + indent, maxW = W - indent;
    const toks = [];
    pdfSafe(lead).split(/\s+/).filter(Boolean).forEach(w => toks.push({ w, b: true }));
    pdfSafe(rest).split(/\s+/).filter(Boolean).forEach(w => toks.push({ w, b: false }));
    doc.setFontSize(sz);
    doc.setFont('times', 'normal'); const sp = doc.getTextWidth(' ');
    const lines = [[]]; let lw = 0;
    for (const t of toks) {
      doc.setFont('times', t.b ? 'bold' : 'normal'); t.wd = doc.getTextWidth(t.w);
      let cur = lines[lines.length - 1];
      if (cur.length && lw + sp + t.wd > maxW) { lines.push([]); cur = lines[lines.length - 1]; lw = 0; }
      t.x = cur.length ? lw + sp : 0; lw = t.x + t.wd; cur.push(t);
    }
    lines.forEach((line, li) => {
      need(LH(sz));
      const by = y + sz * PT;
      if (li === 0 && marker) { doc.setFont('times', 'normal'); doc.setTextColor(...C.ink); doc.text(marker, x0 - 1.5, by, { align: 'right' }); }
      if (hl) { const bs = line.filter(t => t.b); if (bs.length) { const a = bs[0].x, b = bs[bs.length - 1].x + bs[bs.length - 1].wd; doc.setFillColor(...C.hl); doc.rect(x0 + a - 0.5, y + LH(sz) * 0.22, b - a + 1, LH(sz) * 0.72, 'F'); } }
      for (const t of line) { doc.setFont('times', t.b ? 'bold' : 'normal'); doc.setTextColor(...(t.b ? C.ink : restCol)); doc.text(t.w, x0 + t.x, by); }
      y += LH(sz);
    });
    y += after;
  }
  function heading(t) {
    need(LH(base + 1.5) + 4 + LH(base) * 2);
    y += 2.2; font('helvetica', 'bold', base + 1.2, C.blue); doc.text(pdfSafe(t), M, y + (base + 1.2) * PT); y += LH(base + 1.2);
    doc.setDrawColor(...C.rule); doc.setLineWidth(0.3); doc.line(M, y, M + W, y); y += 2;
  }
  function code(txt) {
    const sz = base - 1.2; font('courier', 'normal', sz, C.ink);
    const lines = pdfSafe(txt).split('\n').flatMap(l => doc.splitTextToSize(l || ' ', W - 6));
    y += 0.5;
    lines.forEach((ln, i) => { need(LH(sz)); doc.setFillColor(...C.code); doc.rect(M, y - (i === 0 ? 1 : 0), W, LH(sz) + (i === 0 ? 1 : 0) + (i === lines.length - 1 ? 1 : 0), 'F'); doc.text(ln, M + 3, y + sz * PT); y += LH(sz); });
    y += 2.5;
  }
  const added = (t, a) => (a && !/\(added\)\s*$/.test(t) ? t + ' (added)' : t);

  // header
  const meta = [r.module, weekLabel(r.week)].filter(Boolean).join(', ');
  if (meta) para(meta, { f: 'helvetica', sz: base - 0.5, col: C.muted, after: 0.4 });
  para(r.topic, { f: 'helvetica', st: 'bold', sz: base + 8, after: 1.5 });
  if (r.bigIdea) rich('Big idea:', r.bigIdea, { after: 1 });
  para('Highlighted terms were stressed in the lecture. (added) marks things not in your materials.', { f: 'helvetica', sz: base - 2, col: C.muted, after: 0.5 });

  if (r.concepts.length) { heading('Key concepts'); r.concepts.forEach(c => rich(c.term + ':', added(c.definition, c.added), { hl: c.stressed, after: 0.9 })); }
  if (r.howItWorks.items.length) {
    heading(r.howItWorks.kind === 'formula' ? 'Formula' : 'How it works');
    r.howItWorks.items.forEach((s, i) => rich('', s, { indent: 5, marker: r.howItWorks.kind === 'formula' ? '-' : (i + 1) + '.', after: 0.7 }));
  }
  if (r.diagram.kind !== 'none') {
    heading(r.diagram.title || 'Diagram');
    const fs = Math.max(7, base - 1.5);
    const { rows } = layout(r.diagram.nodes.length);
    need(rows * fs * 1.55 + (rows - 1) * fs * 1.15 + 8);
    y += pdfDiagram(doc, r.diagram, M, y + 1, W, fs) + 3;
  }
  const we = r.workedExample;
  if (we.prompt || we.solution || we.code) {
    heading('Worked example');
    if (we.prompt) para(added(we.prompt, we.added), { after: 0.8 });
    if (we.code) code(we.code);
    if (we.solution) para(we.solution, { after: 0.8 });
  }
  if (r.gotchas.length) { heading('Gotchas'); r.gotchas.forEach(g => rich('', g, { indent: 5, marker: '-', after: 0.7 })); }
  if (r.examQuestions.length) { heading('Likely exam questions'); r.examQuestions.forEach((q, i) => rich(q.question, q.pointer ? ' ' + q.pointer : '', { indent: 5, marker: (i + 1) + '.', restCol: C.muted, after: 0.9 })); }
  if (r.selfTest.length) { heading('Self-test'); r.selfTest.forEach((q, i) => rich('', q.q, { indent: 5, marker: (i + 1) + '.', after: 0.7 })); }
  if (r.gaps.length) { heading('Gaps to fill'); r.gaps.forEach(g => rich('', g, { indent: 5, marker: '-', after: 0.7 })); }
  if (r.selfTest.length) {
    y += 2; need(LH(base) * 3);
    para('Self-test answers', { f: 'helvetica', st: 'bold', sz: base - 1, col: C.muted, after: 0.6 });
    r.selfTest.forEach((q, i) => rich('', q.a, { sz: base - 1.5, indent: 5, marker: (i + 1) + '.', restCol: C.muted, after: 0.4 }));
  }
  const n = doc.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i); font('helvetica', 'normal', 7, C.muted);
    doc.text(pdfSafe(r.topic).slice(0, 80), M, PH - 8);
    doc.text(`Page ${i} of ${n}`, PW - M, PH - 8, { align: 'right' });
  }
  return doc;
}
function summaryPdf(r) {
  let doc;
  for (const size of [10, 9.5, 9, 8.5, 8]) { doc = buildSummaryPdf(r, size); if (doc.getNumberOfPages() <= 2) break; }
  return doc;
}

/* ---------- slides PDF ---------- */
function slidesPdf(r) {
  const { jsPDF } = window.jspdf;
  const SW = 254, SH = 142.875;
  const doc = new jsPDF({ unit: 'mm', format: [SH, SW], orientation: 'landscape' });
  const M = 18, W = SW - 2 * M;
  let first = true, page = 0;
  const total = r.slides.reduce((a, s) => a + (s.type === 'quiz' ? 2 : 1), 0);
  const font = (f, st, sz, col) => { doc.setFont(f, st); doc.setFontSize(sz); doc.setTextColor(...col); };
  function newSlide() {
    if (!first) doc.addPage([SH, SW], 'landscape'); first = false; page++;
    doc.setFillColor(...C.white); doc.rect(0, 0, SW, SH, 'F');
    doc.setFillColor(...C.rule); doc.rect(0, SH - 2, SW, 2, 'F');
    doc.setFillColor(...C.blue); doc.rect(0, SH - 2, SW * page / total, 2, 'F');
    font('helvetica', 'normal', 8, C.muted); doc.text(pdfSafe(r.topic).slice(0, 70), M, SH - 6); doc.text(`${page} of ${total}`, SW - M, SH - 6, { align: 'right' });
  }
  // measure + draw a block of text; returns height
  function block(text, f, st, sz, col, x, y, w, draw = true, lhMul = 1.25) {
    font(f, st, sz, col);
    const lines = doc.splitTextToSize(pdfSafe(text), w);
    const lh = sz * PT * lhMul;
    if (draw) lines.forEach((ln, i) => doc.text(ln, x, y + sz * PT + i * lh));
    return lines.length * lh;
  }
  function headingAt(text, y, sz = 26, hl = false) {
    font('helvetica', 'bold', sz, C.ink);
    const lines = doc.splitTextToSize(pdfSafe(text), W);
    const lh = sz * PT * 1.12;
    lines.forEach((ln, i) => {
      const by = y + sz * PT + i * lh;
      if (hl) { doc.setFillColor(...C.hl); doc.rect(M - 1, by - sz * PT * 0.42, doc.getTextWidth(ln) + 2, sz * PT * 0.55, 'F'); }
      doc.setTextColor(...C.ink); doc.text(ln, M, by);
    });
    return lines.length * lh;
  }
  const kicker = (t, y) => { font('helvetica', 'bold', 10, C.muted); doc.text(pdfSafe(t), M, y + 10 * PT); return 10 * PT + 4; };
  // body items: [{text, f, st, col, bullet}] auto-fit into available height
  function body(items, y, maxY, startSz = 18) {
    for (let sz = startSz; sz >= 10; sz -= 1) {
      let h = 0; for (const it of items) h += block(it.text, it.f || 'helvetica', it.st || 'normal', it.sz || sz, it.col || C.ink, M + (it.bullet ? 7 : 0), 0, W - (it.bullet ? 7 : 0), false) + sz * 0.22;
      if (y + h <= maxY || sz === 10) {
        let yy = y;
        for (const it of items) {
          if (it.bullet) { doc.setFillColor(...C.blue); doc.circle(M + 2, yy + (it.sz || sz) * PT * 0.68, 1, 'F'); }
          if (it.code) { const hh = block(it.text, 'courier', 'normal', (it.sz || sz), C.ink, M + 3, yy, W - 6, false, 1.2); doc.setFillColor(...C.code); doc.rect(M, yy - 1.5, W, hh + 3, 'F'); block(it.text, 'courier', 'normal', (it.sz || sz), C.ink, M + 3, yy, W - 6, true, 1.2); yy += hh + sz * 0.22 + 2; continue; }
          yy += block(it.text, it.f || 'helvetica', it.st || 'normal', it.sz || sz, it.col || C.ink, M + (it.bullet ? 7 : 0), yy, W - (it.bullet ? 7 : 0)) + sz * 0.22;
        }
        return;
      }
    }
  }
  const maxY = SH - 14;
  r.slides.forEach(sl => {
    newSlide();
    let y = 20;
    switch (sl.type) {
      case 'title': {
        const meta = [r.module, weekLabel(r.week)].filter(Boolean).join(', ');
        y = 40; if (meta) y += kicker(meta, y);
        y += headingAt(sl.heading || r.topic, y, 34, true) + 6;
        if (sl.subheading) body([{ text: sl.subheading, f: 'times', st: 'italic', col: C.muted }], y, maxY, 18);
        break;
      }
      case 'concept':
        y += kicker(sl.stressed ? 'Key concept, stressed in lecture' : 'Key concept', y);
        y += headingAt(sl.term, y, 32, sl.stressed) + 6;
        body([{ text: sl.definition, f: 'times' }, ...(sl.example ? [{ text: 'e.g. ' + sl.example, col: C.muted }] : [])], y, maxY, 20);
        break;
      case 'diagram': {
        y += headingAt(sl.heading || r.diagram.title || 'How it fits together', y, 24) + 8;
        const { rows } = layout(r.diagram.nodes.length);
        let fs = 13; while (fs > 8 && y + rows * fs * 1.55 + (rows - 1) * fs * 1.15 > maxY) fs -= 0.5;
        pdfDiagram(doc, r.diagram, M, y, W, fs);
        break;
      }
      case 'example':
        y += kicker('Worked example', y); y += headingAt(sl.heading || 'Example', y, 24) + 5;
        body([...(sl.prompt ? [{ text: sl.prompt, f: 'times' }] : []), ...(sl.code ? [{ text: sl.code, code: true }] : []), ...(sl.solution ? [{ text: sl.solution, f: 'times', col: C.muted }] : [])], y, maxY, 16);
        break;
      case 'quiz':
        y = 32; y += kicker('Quick question', y); y += headingAt(sl.question, y, 26) + 6;
        font('helvetica', 'normal', 11, C.muted); doc.text('Answer on the next page', M, y + 11 * PT);
        newSlide(); y = 22;
        y += kicker('Answer', y);
        y += block(sl.question, 'helvetica', 'normal', 13, C.muted, M, y, W) + 6;
        doc.setFillColor(...C.hl); doc.rect(M - 5, y - 1, 1.6, 22, "F");
        body([{ text: sl.answer || '(no answer given)', f: 'times' }], y, maxY, 22);
        break;
      case 'mnemonic':
        y += kicker('Memory aid', y); y += headingAt(sl.heading || 'Remember it', y, 24) + 6;
        body([...(sl.device ? [{ text: sl.device, st: 'bold', col: C.blue }] : []), ...(sl.explanation ? [{ text: sl.explanation, f: 'times' }] : [])], y, maxY, 22);
        break;
      case 'recap':
        y += kicker('Recap', y); // fall through to points layout
      default:
        y += headingAt(sl.heading || '', y, 26) + 6;
        body(sl.points.map(p => ({ text: p, bullet: true })), y, maxY, 18);
    }
  });
  return doc;
}

/* ---------- downloads ---------- */
function slug(s) { return (s || 'lecture').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'lecture'; }
function saveFile(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = el('a'); a.href = url; a.download = filename; a.rel = 'noopener';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function libsReady() {
  if (!window.jspdf || !window.JSZip) { toast('The PDF tools didn’t load. Reload the page and try again.'); return false; }
  return true;
}
function summaryMarkdown(r) {
  const L = [];
  const meta = [r.module, weekLabel(r.week)].filter(Boolean).join(', ');
  L.push(`# ${r.topic}`); if (meta) L.push(`_${meta}_`); L.push('');
  if (r.bigIdea) L.push(`**Big idea:** ${r.bigIdea}`, '');
  if (r.concepts.length) { L.push('## Key concepts'); r.concepts.forEach(c => L.push(`- ${c.stressed ? '★ ' : ''}**${c.term}:** ${c.definition}${c.added ? ' (added)' : ''}`)); L.push(''); }
  if (r.howItWorks.items.length) { L.push(r.howItWorks.kind === 'formula' ? '## Formula' : '## How it works'); r.howItWorks.items.forEach((s, i) => L.push(`${i + 1}. ${s}`)); L.push(''); }
  if (r.diagram.kind !== 'none') { L.push(`## ${r.diagram.title || 'Diagram'}`, r.diagram.nodes.join(' → ') + (r.diagram.kind === 'cycle' ? ' → (repeats)' : ''), ''); }
  const we = r.workedExample;
  if (we.prompt || we.code || we.solution) { L.push('## Worked example'); if (we.prompt) L.push(we.prompt + (we.added ? ' (added)' : ''), ''); if (we.code) L.push('```', we.code, '```', ''); if (we.solution) L.push(we.solution, ''); }
  if (r.gotchas.length) { L.push('## Gotchas'); r.gotchas.forEach(g => L.push(`- ${g}`)); L.push(''); }
  if (r.examQuestions.length) { L.push('## Likely exam questions'); r.examQuestions.forEach((q, i) => L.push(`${i + 1}. **${q.question}** ${q.pointer}`)); L.push(''); }
  if (r.selfTest.length) { L.push('## Self-test'); r.selfTest.forEach((q, i) => L.push(`${i + 1}. ${q.q}`)); L.push(''); }
  if (r.gaps.length) { L.push('## Gaps to fill'); r.gaps.forEach(g => L.push(`- ${g}`)); L.push(''); }
  if (r.selfTest.length) { L.push('## Self-test answers'); r.selfTest.forEach((q, i) => L.push(`${i + 1}. ${q.a}`)); L.push(''); }
  return L.join('\n');
}
$('#dlSheet').onclick = () => { if (!state.result || !libsReady()) return; saveFile(slug(state.result.topic) + '-summary.pdf', summaryPdf(state.result).output('blob')); };
$('#dlSlides').onclick = () => { if (!state.result || !libsReady()) return; saveFile(slug(state.result.topic) + '-slides.pdf', slidesPdf(state.result).output('blob')); };
async function downloadAll() {
  if (!state.result || !libsReady()) return;
  const r = state.result, s = slug(r.topic), zip = new JSZip();
  zip.file(`${s}-summary.pdf`, summaryPdf(r).output('arraybuffer'));
  zip.file(`${s}-slides.pdf`, slidesPdf(r).output('arraybuffer'));
  zip.file(`${s}-summary.md`, summaryMarkdown(r));
  zip.file(`${s}-kit.json`, JSON.stringify(r, null, 2));
  saveFile(`${s}-revision-kit.zip`, await zip.generateAsync({ type: 'blob' }));
}
$('#dlAll1').onclick = downloadAll;
$('#dlAll2').onclick = downloadAll;

renderRecent();

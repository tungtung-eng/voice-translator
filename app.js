'use strict';

// ---------- Languages ----------
const LANGS = {
  en: { name: '英文', native: 'English', flag: '🇺🇸', speech: 'en-US', ocr: 'eng', tap: 'Tap to speak' },
  ja: { name: '日文', native: '日本語', flag: '🇯🇵', speech: 'ja-JP', ocr: 'jpn', tap: '押して話してください' },
  ko: { name: '韓文', native: '한국어', flag: '🇰🇷', speech: 'ko-KR', ocr: 'kor', tap: '눌러서 말하세요' },
  vi: { name: '越南文', native: 'Tiếng Việt', flag: '🇻🇳', speech: 'vi-VN', ocr: 'vie', tap: 'Nhấn để nói' },
  th: { name: '泰文', native: 'ภาษาไทย', flag: '🇹🇭', speech: 'th-TH', ocr: 'tha', tap: 'แตะเพื่อพูด' },
  id: { name: '印尼文', native: 'Bahasa Indonesia', flag: '🇮🇩', speech: 'id-ID', ocr: 'ind', tap: 'Ketuk untuk bicara' },
};
const ZH = 'zh-TW';

const $ = (id) => document.getElementById(id);

// ---------- Storage (never let storage errors break the app) ----------
function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

const settings = Object.assign({ lang: 'en', autoSpeak: true, slow: false, big: false, accurate: false, pause: 'normal' }, load('settings', {}));
let history = load('history', []);

// ---------- Translation (free services) ----------
// 1st choice: Google Translate's free public endpoint. Fallback: MyMemory free API.
function chunks(text, max) {
  const out = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && (cur.length + line.length + 1) > max) { out.push(cur); cur = ''; }
    cur = cur ? cur + '\n' + line : line;
  }
  if (cur) out.push(cur);
  return out;
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { signal: ctrl.signal }); } finally { clearTimeout(timer); }
}

async function googleTranslate(text, from, to) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t'
    + '&sl=' + encodeURIComponent(from) + '&tl=' + encodeURIComponent(to) + '&q=' + encodeURIComponent(text);
  const res = await fetchWithTimeout(url, 2500);
  if (!res.ok) throw new Error('google ' + res.status);
  const data = await res.json();
  return data[0].map((seg) => seg[0]).join('');
}

async function myMemoryTranslate(text, from, to) {
  const src = from === 'auto' ? settings.lang : from;
  const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text)
    + '&langpair=' + encodeURIComponent(src + '|' + to);
  const res = await fetchWithTimeout(url, 8000);
  if (!res.ok) throw new Error('mymemory ' + res.status);
  const data = await res.json();
  if (data.responseStatus !== 200 && data.responseStatus !== '200') throw new Error(data.responseDetails || 'mymemory');
  return data.responseData.translatedText;
}

// After Google fails, go straight to the fallback for a while instead of waiting on Google each time.
let googleDownUntil = 0;

async function translateUncached(text, from, to) {
  const out = [];
  for (const part of chunks(text, 1500)) {
    try {
      if (Date.now() < googleDownUntil) throw new Error('google skipped');
      out.push(await googleTranslate(part, from, to));
    } catch (e) {
      if (e.message !== 'google skipped') googleDownUntil = Date.now() + 60 * 1000;
      const sub = [];
      for (const p of chunks(part, 450)) sub.push(await myMemoryTranslate(p, from, to));
      out.push(sub.join('\n'));
    }
  }
  return out.join('\n');
}

// Same text → same request, so a translation started early (while the speaker
// is pausing) is reused instead of fetched again.
const translateCache = new Map();
function translate(text, from, to) {
  const key = from + '|' + to + '|' + text;
  if (translateCache.has(key)) return translateCache.get(key);
  const p = translateUncached(text, from, to);
  translateCache.set(key, p);
  p.catch(() => translateCache.delete(key));
  if (translateCache.size > 200) translateCache.delete(translateCache.keys().next().value);
  return p;
}

// ---------- Text to speech ----------
let voices = [];
function refreshVoices() { voices = window.speechSynthesis ? speechSynthesis.getVoices() : []; }
if (window.speechSynthesis) {
  refreshVoices();
  speechSynthesis.onvoiceschanged = refreshVoices;
}

function pickVoice(lang) {
  const norm = (l) => l.replace('_', '-').toLowerCase();
  const want = lang.toLowerCase();
  const prefix = want.split('-')[0];
  let v = voices.find((x) => norm(x.lang) === want);
  if (!v && prefix === 'zh') {
    // Prefer Mandarin (Taiwan, then China) over Cantonese.
    v = voices.find((x) => /zh-(tw|hant)/.test(norm(x.lang))) || voices.find((x) => /zh-(cn|hans)/.test(norm(x.lang)));
  }
  return v || voices.find((x) => norm(x.lang).startsWith(prefix)) || null;
}

// Resolves when speaking finishes, so auto mode doesn't listen to its own voice.
function speak(text, lang) {
  if (!window.speechSynthesis || !text) return Promise.resolve();
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  const v = pickVoice(lang);
  if (v) u.voice = v;
  u.rate = settings.slow ? 0.75 : 1;
  return new Promise((resolve) => {
    let started = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(safety);
      clearInterval(poll);
      resolve();
    };
    // Some phones fire onend late or never, so also watch speechSynthesis.speaking.
    const poll = setInterval(() => {
      if (speechSynthesis.speaking) started = true;
      else if (started && !speechSynthesis.pending) finish();
    }, 150);
    const safety = setTimeout(finish, 2000 + text.length * (settings.slow ? 300 : 200));
    u.onstart = () => { started = true; };
    u.onend = u.onerror = finish;
    speechSynthesis.speak(u);
  });
}

// iOS only allows speech that started from a tap; speaking once inside a tap unlocks it.
let ttsUnlocked = false;
function unlockTts() {
  if (ttsUnlocked || !window.speechSynthesis) return;
  ttsUnlocked = true;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  speechSynthesis.speak(u);
}

// ---------- Language picker ----------
function renderLangs() {
  const grid = $('langGrid');
  grid.innerHTML = '';
  for (const [code, l] of Object.entries(LANGS)) {
    const b = document.createElement('button');
    b.className = 'lang-btn' + (code === settings.lang ? ' active' : '');
    b.innerHTML = '<span class="flag">' + l.flag + '</span>' + l.name;
    b.setAttribute('aria-pressed', code === settings.lang);
    b.onclick = () => {
      settings.lang = code;
      save('settings', settings);
      renderLangs();
      if (autoMode && rec) { dropRec(); scheduleAutoListen(150); } // restart in the new language
      prewarmOcr();
    };
    grid.appendChild(b);
  }
  const l = LANGS[settings.lang];
  $('themMain').textContent = '對方說' + l.name;
  $('themSub').textContent = l.tap;
  $('photoLang').textContent = l.name;
  $('typeThem').textContent = '對方說的（' + l.name + '）';
}

// ---------- Conversation ----------
function renderWelcome() {
  const chat = $('chat');
  if (history.length) return;
  chat.innerHTML = '<div class="welcome"><b>怎麼用：</b><ol>'
    + '<li>上面先選<b>對方說的語言</b></li>'
    + '<li>按<b style="color:var(--me)">綠色按鈕</b>，說中文</li>'
    + '<li>按<b style="color:var(--them)">藍色按鈕</b>，讓對方說話</li>'
    + '<li>翻譯會顯示在這裡，也會唸出來</li></ol></div>';
}

function addBubble(item) {
  const chat = $('chat');
  const w = chat.querySelector('.welcome');
  if (w) w.remove();

  const el = document.createElement('div');
  el.className = 'bubble ' + item.who;
  const l = LANGS[item.lang] || LANGS.en;
  const who = item.who === 'me' ? '我（中文 → ' + l.name + '）' : '對方（' + l.name + ' → 中文）';
  el.innerHTML = '<div class="who"></div><div class="orig"></div><div class="trans"></div><div class="acts"></div>';
  el.querySelector('.who').textContent = who;
  el._who = who;
  el.querySelector('.orig').textContent = item.text;
  chat.appendChild(el);
  updateBubble(el, item);
  el.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return el;
}

function targetLang(item) { return item.who === 'me' ? LANGS[item.lang].speech : ZH; }

function updateBubble(el, item) {
  const t = el.querySelector('.trans');
  const acts = el.querySelector('.acts');
  t.classList.remove('err');
  acts.innerHTML = '';
  if (item.error) {
    t.classList.add('err');
    t.textContent = '翻譯失敗，請確認有網路後再試一次';
    const retry = document.createElement('button');
    retry.textContent = '🔁 再試一次';
    retry.onclick = () => doTranslate(el, item);
    acts.appendChild(retry);
    return;
  }
  if (item.translated == null) { t.textContent = '翻譯中…'; return; }
  t.textContent = item.translated;
  if (item.ms != null) el.querySelector('.who').textContent = el._who + ' · ' + (item.ms / 1000).toFixed(1) + ' 秒';

  const play = document.createElement('button');
  play.textContent = '🔊 再唸一次';
  play.onclick = () => speak(item.translated, targetLang(item));
  const big = document.createElement('button');
  big.textContent = item.who === 'me' ? '🔍 放大給對方看' : '🔍 放大';
  big.onclick = () => openShow(item.translated, targetLang(item));
  acts.append(play, big);
}

async function doTranslate(el, item) {
  item.error = false;
  item.translated = null;
  updateBubble(el, item);
  try {
    const from = item.who === 'me' ? ZH : item.lang;
    const to = item.who === 'me' ? item.lang : ZH;
    item.translated = await translate(item.text, from, to);
    if (item.spokenAt) item.ms = Math.round(performance.now() - item.spokenAt);
    history.push({ who: item.who, lang: item.lang, text: item.text, translated: item.translated, time: item.time });
    history = history.slice(-60);
    save('history', history);
    updateBubble(el, item);
    el.scrollIntoView({ behavior: 'smooth', block: 'end' });
    if (settings.autoSpeak) await speak(item.translated, targetLang(item));
  } catch (e) {
    console.error(e);
    item.error = true;
    updateBubble(el, item);
  }
}

function handleText(who, text, spokenAt) {
  text = text.trim();
  if (!text) return;
  const item = { who, lang: settings.lang, text, translated: null, time: Date.now(), spokenAt };
  const el = addBubble(item);
  return doTranslate(el, item);
}

// ---------- Speech recognition ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let recAborted = false;

// Auto conversation: listen to each side in turn; a pause ends a turn,
// then the translation is spoken and it's the other side's turn.
let autoMode = false;
let autoTurn = 'me';
let autoBusy = false; // translating / speaking, not listening
let autoRestartTimer = null;
const other = (who) => (who === 'me' ? 'them' : 'me');

// How long a pause ends a sentence. 'slow' leaves it to the phone (usually 2–3 s).
const PAUSE_MS = { fast: 700, normal: 1100, slow: 0 };

function setListening(who) {
  for (const [id, w] of [['micMe', 'me'], ['micThem', 'them']]) {
    const b = $(id);
    const active = who === w;
    b.classList.toggle('listening', active);
    b.disabled = !autoMode && who != null && !active;
    b.classList.toggle('dim', autoMode && !active);
    let sub;
    if (active) sub = w === 'me' ? (autoMode ? '正在聽…停頓就翻譯' : '正在聽…說完再按一下') : 'Listening…';
    else if (autoMode) sub = w === 'me' ? '按這裡換我說' : LANGS[settings.lang].tap;
    else sub = w === 'me' ? '按一下開始說' : LANGS[settings.lang].tap;
    b.querySelector('.mic-sub').textContent = sub;
  }
}

function turnPrompt(who) {
  if (who === 'me') return autoMode ? '🎤 輪到你說中文（說完停一下就會翻譯）' : '🎤 請說中文…';
  const l = LANGS[settings.lang];
  return autoMode ? '🎤 輪到對方說' + l.name + '：' + l.tap : '🎤 ' + l.tap + '…';
}

function showLive(text) {
  const live = $('live');
  live.hidden = !text;
  live.textContent = text || '';
  if (text) live.scrollIntoView({ block: 'end' });
}

function listen(who) {
  unlockTts();
  if (window.speechSynthesis) speechSynthesis.cancel();
  if (!SR) {
    $('noSpeech').hidden = false;
    $('typeRow').hidden = false;
    return;
  }
  if (autoMode) {
    // In auto mode the buttons just hand the turn to that side.
    autoTurn = who;
    dropRec();
    if (!autoBusy) scheduleAutoListen(150);
    return;
  }
  if (rec) { stopRec(rec); return; }
  startRec(who);
}

// Phones can kill the recognizer (e.g. when the app goes to the background) without
// ever calling onend. Never let a dead recognizer block the buttons.
function dropRec() {
  const r = rec;
  if (!r) return;
  rec = null; // its onend, if it ever comes, is ignored
  recAborted = true;
  try { r.abort(); } catch (e) { /* already dead */ }
}

// Stop and use what was heard; if the phone never answers, finish anyway.
function stopRec(r) {
  r._stoppedAt = r._stoppedAt || performance.now();
  try { r.stop(); } catch (e) { /* already dead */ }
  setTimeout(() => { if (rec === r) r.onend(); }, 1500);
}

function scheduleAutoListen(delay) {
  clearTimeout(autoRestartTimer);
  autoRestartTimer = setTimeout(() => { if (autoMode && !rec && !autoBusy) startRec(autoTurn); }, delay);
}

function startRec(who) {
  recAborted = false;
  const r = new SR();
  rec = r;
  r.lang = who === 'me' ? ZH : LANGS[settings.lang].speech;
  r.interimResults = true;
  r.continuous = false; // the recognizer ends by itself when the speaker pauses
  r.maxAlternatives = 1;

  let finalText = '';
  let interim = '';
  let fatal = false;
  let pauseTimer = null;
  let prefetchTimer = null;
  let stoppedAt = null;
  // If the recognizer goes silent (no words, no end) for a long time, assume it died.
  let idleTimer = null;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (rec !== r) return;
      dropRec();
      showLive('');
      if (autoMode) scheduleAutoListen(150); else setListening(null);
    }, 15000);
  };
  armIdle();
  const lang = settings.lang;
  const from = who === 'me' ? ZH : lang;
  const to = who === 'me' ? lang : ZH;
  r.onresult = (e) => {
    interim = '';
    finalText = '';
    for (let i = 0; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
      else interim += e.results[i][0].transcript;
    }
    const text = (finalText + interim).trim();
    armIdle();
    showLive('🎤 ' + text);
    clearTimeout(pauseTimer);
    clearTimeout(prefetchTimer);
    if (!text) return;
    // Start translating during the pause so the result is ready when the turn ends.
    prefetchTimer = setTimeout(() => translate(text, from, to).catch(() => {}), 400);
    const pause = PAUSE_MS[settings.pause] || 0;
    if (pause) pauseTimer = setTimeout(() => { if (rec === r) { stoppedAt = performance.now(); stopRec(r); } }, pause);
  };
  r.onerror = (e) => {
    if (e.error === 'aborted') return;
    // Silence is normal while waiting for someone to talk in auto mode.
    if (autoMode && e.error === 'no-speech') return;
    fatal = ['not-allowed', 'service-not-allowed', 'audio-capture', 'network'].includes(e.error);
    const msg = {
      'not-allowed': '請允許使用麥克風（在瀏覽器網址列旁邊的設定打開）',
      'service-not-allowed': '請允許使用麥克風與語音辨識',
      'no-speech': '沒有聽到聲音，請靠近手機再說一次',
      'network': '語音辨識需要網路，請確認網路',
      'audio-capture': '找不到麥克風',
    }[e.error];
    if (fatal && autoMode) setAuto(false);
    if (msg) toast(msg);
  };
  r.onend = async () => {
    clearTimeout(pauseTimer);
    clearTimeout(prefetchTimer);
    clearTimeout(idleTimer);
    if (rec !== r) return;
    // finalText + interim: stopping early can leave the last words as interim.
    const text = recAborted ? '' : (finalText + interim).trim();
    const spokenAt = stoppedAt || r._stoppedAt || performance.now();
    rec = null;
    showLive('');
    if (!autoMode) {
      setListening(null);
      if (text) handleText(who, text, spokenAt);
      return;
    }
    if (!text) { scheduleAutoListen(fatal ? 1500 : 150); return; }
    autoBusy = true;
    autoTurn = other(who);
    setListening(null);
    try { await handleText(who, text, spokenAt); } finally { autoBusy = false; }
    scheduleAutoListen(100);
  };
  setListening(who);
  showLive(turnPrompt(who));
  try {
    r.start();
  } catch (e) {
    clearTimeout(idleTimer);
    rec = null;
    setListening(null);
    showLive('');
    if (autoMode) setAuto(false);
    toast('無法開始錄音，請再按一次');
  }
}

function setAuto(on) {
  autoMode = on;
  clearTimeout(autoRestartTimer);
  const btn = $('autoBtn');
  btn.classList.toggle('on', on);
  btn.textContent = on ? '⏹️ 自動對話中（按這裡停止）' : '🔁 自動對話（不用一直按）';
  if (on) {
    unlockTts();
    autoTurn = 'me';
    if (rec) { dropRec(); if (!autoBusy) scheduleAutoListen(150); } else if (!autoBusy) startRec('me');
  } else {
    dropRec();
    setListening(null);
    showLive('');
  }
}

let toastTimer;
function toast(msg) {
  const live = $('live');
  live.hidden = false;
  live.textContent = '⚠️ ' + msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if (!rec) live.hidden = true; }, 4000);
}

// ---------- Full screen "show to the other person" ----------
let showLangCode = ZH;
function openShow(text, lang) {
  showLangCode = lang;
  $('showText').textContent = text;
  $('showInner').classList.remove('flipped');
  $('show').hidden = false;
}

// ---------- Photo translation (OCR runs on the phone with Tesseract.js) ----------
let tesseractLoading = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  if (!tesseractLoading) {
    tesseractLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
      s.onload = resolve;
      s.onerror = () => { tesseractLoading = null; reject(new Error('tesseract load failed')); };
      document.head.appendChild(s);
    });
  }
  return tesseractLoading;
}

// "Fast" models are several times quicker than Tesseract.js's default "best" models
// on phones, with only slightly lower accuracy.
const OCR_FAST_MODELS = 'https://cdn.jsdelivr.net/gh/tesseract-ocr/tessdata_fast@4.1.0';

let ocrLang = null;
let ocrWorkerPromise = null;
let ocrProgress = () => {};
let photoBusy = false;

// One worker per language, created ahead of time and reused for every photo.
function getWorker(lang) {
  const key = lang + (settings.accurate ? ':best' : ':fast');
  if (ocrWorkerPromise && ocrLang === key) return ocrWorkerPromise;
  const old = ocrWorkerPromise;
  ocrLang = key;
  const p = (async () => {
    if (old) old.then((w) => w.terminate()).catch(() => {});
    await loadTesseract();
    const code = LANGS[lang].ocr;
    const logger = (m) => ocrProgress(m);
    if (settings.accurate) return Tesseract.createWorker(code, 1, { logger });
    try {
      return await Tesseract.createWorker(code, 1, { logger, langPath: OCR_FAST_MODELS, gzip: false, cachePath: 'fast' });
    } catch (e) {
      console.warn('fast OCR model unavailable, using default', e);
      return await Tesseract.createWorker(code, 1, { logger });
    }
  })();
  ocrWorkerPromise = p;
  p.catch(() => { if (ocrWorkerPromise === p) { ocrWorkerPromise = null; ocrLang = null; } });
  return p;
}

function resetOcrWorker() {
  const old = ocrWorkerPromise;
  ocrWorkerPromise = null;
  ocrLang = null;
  if (old) old.then((w) => w.terminate()).catch(() => {});
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Start downloading/loading while the user is still aiming the camera.
function prewarmOcr() {
  if (photoBusy || $('photo').hidden) return;
  getWorker(settings.lang).catch(() => {});
}

// ~1400px keeps menu text readable for OCR while being much quicker than full-size photos.
function downscale(file, max = 1400) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

// Words Tesseract is unsure about are usually smudges or background, not text.
const OCR_MIN_CONFIDENCE = 55;
const NO_SPACE_LANGS = ['ja', 'th'];

function cleanLine(text) {
  const cjk = /([぀-ヿ㐀-鿿])\s+(?=[぀-ヿ㐀-鿿])/g;
  return text.replace(cjk, '$1').replace(/\s+/g, ' ').trim()
    .replace(/^[^\p{L}\p{N}$€£¥(（「"']+/u, '')
    .replace(/[^\p{L}\p{N}.!?。！？)）」"'%$€£¥]+$/u, '');
}

function keepLine(text) {
  return (text.match(/\p{L}/gu) || []).length >= 2;
}

// Wrapped lines of the same sentence are joined back together so the sentence
// is translated as a whole; short stand-alone lines (menu items, signs) stay separate.
function joinLines(lines, lang) {
  const noSpace = NO_SPACE_LANGS.includes(lang);
  const units = [];
  for (const line of lines) {
    const prev = units[units.length - 1];
    const continues = prev && !/[.!?。！？:：;；]$/.test(prev) && (
      /[,，、\-]$/.test(prev)
      || prev.length >= (noSpace ? 12 : 25)
      || (!noSpace && /^\p{Ll}/u.test(line)));
    if (!continues) units.push(line);
    else if (/\p{L}-$/u.test(prev)) units[units.length - 1] = prev.slice(0, -1) + line;
    else units[units.length - 1] = prev + (noSpace ? '' : ' ') + line;
  }
  return units;
}

// Returns paragraphs, each a list of sentence-sized pieces to translate.
function ocrParagraphs(data, lang) {
  const paragraphs = [];
  let dropped = 0;
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      const lines = [];
      for (const line of para.lines || []) {
        const words = line.words || [];
        const good = words.filter((w) => w.confidence >= OCR_MIN_CONFIDENCE);
        const text = cleanLine(good.map((w) => w.text).join(' '));
        if (good.length * 2 >= words.length && keepLine(text)) lines.push(text);
        else if (words.length) dropped++;
      }
      const units = joinLines(lines, lang);
      if (units.length) paragraphs.push(units);
    }
  }
  if (!data.blocks) {
    // Older result format: plain text only.
    const lines = (data.text || '').split('\n').map(cleanLine).filter(keepLine);
    if (lines.length) paragraphs.push(joinLines(lines, lang));
  }
  return { paragraphs, dropped };
}

function photoStatus(msg) {
  const s = $('photoStatus');
  s.hidden = !msg;
  s.textContent = msg || '';
}

async function handlePhoto(file) {
  const result = $('photoResult');
  result.innerHTML = '';
  const preview = $('photoPreview');
  preview.src = URL.createObjectURL(file);
  preview.hidden = false;

  const lang = settings.lang;
  const started = performance.now();
  photoBusy = true;
  try {
    photoStatus('準備中…（第一次使用這個語言要下載資料，請稍等）');
    ocrProgress = (m) => {
      if (m.status === 'recognizing text') photoStatus('正在讀照片上的字… ' + Math.round(m.progress * 100) + '%');
      else if (/load/.test(m.status)) photoStatus('下載' + LANGS[lang].name + '辨識資料中…（只有第一次）');
    };
    const [canvas, worker] = await Promise.all([downscale(file), withTimeout(getWorker(lang), 90000)]);
    const { data } = await withTimeout(worker.recognize(canvas, {}, { text: true, blocks: true }), 60000);
    const { paragraphs, dropped } = ocrParagraphs(data, lang);
    if (!paragraphs.length) {
      photoStatus('找不到文字。請靠近一點、光線亮一點、拿穩再拍一次，也請確認上面選的語言正確。');
      return;
    }
    photoStatus('翻譯中…');
    const units = paragraphs.flat();
    let translated = (await translate(units.join('\n'), lang, ZH)).split('\n');
    if (translated.length !== units.length) {
      // The service merged or split lines; translate each piece on its own instead.
      translated = await Promise.all(units.map((u) => translate(u, lang, ZH)));
    }
    photoStatus('');

    const allZh = translated.join('\n');
    const playAll = document.createElement('button');
    playAll.className = 'small-btn';
    playAll.textContent = '🔊 全部唸中文';
    playAll.onclick = () => speak(allZh, ZH);
    result.appendChild(playAll);

    let i = 0;
    for (const para of paragraphs) {
      const orig = para.join('\n');
      const trans = translated.slice(i, i + para.length).join('\n');
      i += para.length;
      const p = document.createElement('div');
      p.className = 'pair';
      p.innerHTML = '<div class="trans"></div><div class="orig"></div><div class="acts"></div>';
      p.querySelector('.orig').textContent = orig;
      p.querySelector('.trans').textContent = trans;
      const play = document.createElement('button');
      play.textContent = '🔊 唸中文';
      play.onclick = () => speak(trans, ZH);
      const playOrig = document.createElement('button');
      playOrig.textContent = '🔊 唸原文';
      playOrig.onclick = () => speak(orig, LANGS[lang].speech);
      p.querySelector('.acts').append(play, playOrig);
      result.appendChild(p);
    }
    if (dropped) {
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent = '有 ' + dropped + ' 行看不清楚，已略過。想看到更多字，可以靠近一點再拍，或在「設定」打開精準模式。';
      result.appendChild(note);
    }
    const took = document.createElement('p');
    took.className = 'hint';
    took.textContent = '（用了 ' + ((performance.now() - started) / 1000).toFixed(1) + ' 秒）';
    result.appendChild(took);
  } catch (e) {
    console.error(e);
    if (e.message === 'timeout') {
      resetOcrWorker();
      photoStatus('等太久沒有反應，請再拍一次');
    } else {
      photoStatus('處理失敗，請確認有網路後再試一次');
    }
  } finally {
    photoBusy = false;
    ocrProgress = () => {};
  }
}

// ---------- Wiring ----------
function applySettings() {
  document.body.classList.toggle('big', settings.big);
  $('optAutoSpeak').checked = settings.autoSpeak;
  $('optSlow').checked = settings.slow;
  $('optBig').checked = settings.big;
  $('optAccurate').checked = settings.accurate;
  $('optPause').value = settings.pause;
}

function init() {
  applySettings();
  renderLangs();
  renderWelcome();
  for (const item of history) addBubble(item);
  if (!SR) $('noSpeech').hidden = false;

  $('micMe').onclick = () => listen('me');
  $('micThem').onclick = () => listen('them');
  $('autoBtn').onclick = () => { if (!SR) { listen('me'); return; } setAuto(!autoMode); };
  // Leaving the app: turn the microphone off and clear anything in progress.
  let hiddenAt = 0;
  const onHidden = () => {
    hiddenAt = Date.now();
    if (autoMode) setAuto(false);
    dropRec();
    setListening(null);
    showLive('');
    if (window.speechSynthesis) speechSynthesis.cancel();
  };
  // Coming back: phones may have broken speech and the photo reader in the meantime.
  const onVisible = () => {
    ttsUnlocked = false; // iPhone needs a fresh tap before it will speak again
    if (window.speechSynthesis) { speechSynthesis.cancel(); refreshVoices(); }
    setListening(null);
    if (hiddenAt && Date.now() - hiddenAt > 30000 && !photoBusy) resetOcrWorker();
    prewarmOcr();
  };
  document.addEventListener('visibilitychange', () => (document.hidden ? onHidden() : onVisible()));
  window.addEventListener('pagehide', onHidden);
  window.addEventListener('pageshow', (e) => { if (e.persisted) onVisible(); });

  $('typeBtn').onclick = () => { $('typeRow').hidden = !$('typeRow').hidden; if (!$('typeRow').hidden) $('typeInput').focus(); };
  const sendTyped = (who) => { unlockTts(); handleText(who, $('typeInput').value); $('typeInput').value = ''; };
  $('typeMe').onclick = () => sendTyped('me');
  $('typeThem').onclick = () => sendTyped('them');

  $('clearBtn').onclick = () => {
    if (!confirm('確定要清除所有對話嗎？')) return;
    history = [];
    save('history', history);
    $('chat').innerHTML = '';
    renderWelcome();
  };

  for (const tab of document.querySelectorAll('.tab')) {
    tab.onclick = () => {
      for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
      const name = tab.dataset.tab;
      $('talk').hidden = name !== 'talk';
      $('photo').hidden = name !== 'photo';
      $('talkBar').hidden = name !== 'talk';
      if (name !== 'talk' && autoMode) setAuto(false);
      if (name === 'photo') prewarmOcr();
    };
  }

  $('photoInput').onchange = (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) { unlockTts(); handlePhoto(f); }
  };

  $('flipBtn').onclick = () => $('showInner').classList.toggle('flipped');
  $('showSpeakBtn').onclick = () => speak($('showText').textContent, showLangCode);
  $('showClose').onclick = () => { $('show').hidden = true; };

  $('settingsBtn').onclick = () => $('settings').showModal();
  $('settingsClose').onclick = () => $('settings').close();
  $('optAutoSpeak').onchange = (e) => { settings.autoSpeak = e.target.checked; save('settings', settings); };
  $('optSlow').onchange = (e) => { settings.slow = e.target.checked; save('settings', settings); };
  $('optBig').onchange = (e) => { settings.big = e.target.checked; save('settings', settings); applySettings(); };
  $('optPause').onchange = (e) => { settings.pause = e.target.value; save('settings', settings); };
  $('optAccurate').onchange = (e) => { settings.accurate = e.target.checked; save('settings', settings); prewarmOcr(); };

  const net = () => { $('offline').hidden = navigator.onLine; };
  window.addEventListener('online', net);
  window.addEventListener('offline', net);
  net();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    // When a new version takes over, reload once so the new screen shows up right away.
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded || autoMode) return;
      reloaded = true;
      location.reload();
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then((reg) => reg.update())
      .catch(() => {});
  }
}

init();

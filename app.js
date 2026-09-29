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

const settings = Object.assign({ lang: 'en', autoSpeak: true, slow: false, big: false }, load('settings', {}));
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

async function googleTranslate(text, from, to) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t'
    + '&sl=' + encodeURIComponent(from) + '&tl=' + encodeURIComponent(to) + '&q=' + encodeURIComponent(text);
  const res = await fetch(url);
  if (!res.ok) throw new Error('google ' + res.status);
  const data = await res.json();
  return data[0].map((seg) => seg[0]).join('');
}

async function myMemoryTranslate(text, from, to) {
  const src = from === 'auto' ? settings.lang : from;
  const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text)
    + '&langpair=' + encodeURIComponent(src + '|' + to);
  const res = await fetch(url);
  if (!res.ok) throw new Error('mymemory ' + res.status);
  const data = await res.json();
  if (data.responseStatus !== 200 && data.responseStatus !== '200') throw new Error(data.responseDetails || 'mymemory');
  return data.responseData.translatedText;
}

async function translate(text, from, to) {
  const out = [];
  for (const part of chunks(text, 1500)) {
    try {
      out.push(await googleTranslate(part, from, to));
    } catch (e) {
      const sub = [];
      for (const p of chunks(part, 450)) sub.push(await myMemoryTranslate(p, from, to));
      out.push(sub.join('\n'));
    }
  }
  return out.join('\n');
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
  u.rate = settings.slow ? 0.75 : 0.95;
  return new Promise((resolve) => {
    // Some browsers never fire onend; don't wait forever.
    const safety = setTimeout(resolve, 3000 + text.length * 250);
    u.onend = u.onerror = () => { clearTimeout(safety); resolve(); };
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
      if (autoMode && rec) { recAborted = true; rec.abort(); } // restarts in the new language
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
    history.push(item);
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

function handleText(who, text) {
  text = text.trim();
  if (!text) return;
  const item = { who, lang: settings.lang, text, translated: null, time: Date.now() };
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
    if (rec) { recAborted = true; rec.abort(); } else if (!autoBusy) startRec(who);
    return;
  }
  if (rec) { rec.stop(); return; }
  startRec(who);
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
  r.onresult = (e) => {
    interim = '';
    finalText = '';
    for (let i = 0; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
      else interim += e.results[i][0].transcript;
    }
    showLive('🎤 ' + (finalText + interim));
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
    if (rec !== r) return;
    const text = recAborted ? '' : (finalText || interim).trim();
    rec = null;
    showLive('');
    if (!autoMode) {
      setListening(null);
      if (text) handleText(who, text);
      return;
    }
    if (!text) { scheduleAutoListen(fatal ? 1500 : 250); return; }
    autoBusy = true;
    autoTurn = other(who);
    setListening(null);
    try { await handleText(who, text); } finally { autoBusy = false; }
    scheduleAutoListen(300);
  };
  setListening(who);
  showLive(turnPrompt(who));
  try {
    r.start();
  } catch (e) {
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
    if (rec) { recAborted = true; rec.abort(); } else if (!autoBusy) startRec('me');
  } else {
    if (rec) { recAborted = true; rec.abort(); }
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

let ocrWorker = null;
let ocrWorkerLangs = null;
let ocrProgress = () => {};
async function getWorker(langs) {
  if (ocrWorker && ocrWorkerLangs === langs) return ocrWorker;
  if (ocrWorker) { await ocrWorker.terminate(); ocrWorker = null; }
  ocrWorker = await Tesseract.createWorker(langs, 1, { logger: (m) => ocrProgress(m) });
  ocrWorkerLangs = langs;
  return ocrWorker;
}

function downscale(file, max = 1800) {
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

function cleanOcr(text) {
  const cjk = /([぀-ヿ㐀-鿿])\s+(?=[぀-ヿ㐀-鿿])/g;
  return text.split('\n')
    .map((l) => l.replace(cjk, '$1').replace(/\s+/g, ' ').trim())
    .filter((l) => l.length >= 2 && /[\p{L}]/u.test(l));
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
  const langs = lang === 'en' ? 'eng' : LANGS[lang].ocr + '+eng';
  try {
    photoStatus('準備中…（第一次使用要下載資料，請稍等）');
    const [canvas] = await Promise.all([downscale(file), loadTesseract()]);
    ocrProgress = (m) => {
      if (m.status === 'recognizing text') photoStatus('正在讀照片上的字… ' + Math.round(m.progress * 100) + '%');
      else if (/load/.test(m.status)) photoStatus('下載' + LANGS[lang].name + '辨識資料中…');
    };
    const worker = await getWorker(langs);
    const { data } = await worker.recognize(canvas);
    const lines = cleanOcr(data.text);
    if (!lines.length) {
      photoStatus('找不到文字。請靠近一點、光線亮一點、拿穩再拍一次，也請確認上面選的語言正確。');
      return;
    }
    photoStatus('翻譯中…');
    const translated = (await translate(lines.join('\n'), lang, ZH)).split('\n');
    photoStatus('');
    const same = translated.length === lines.length;
    const pairs = same ? lines.map((l, i) => [l, translated[i]]) : [[lines.join('\n'), translated.join('\n')]];
    for (const [orig, trans] of pairs) {
      const p = document.createElement('div');
      p.className = 'pair';
      p.innerHTML = '<div class="orig"></div><div class="trans"></div><div class="acts"></div>';
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
  } catch (e) {
    console.error(e);
    photoStatus('處理失敗，請確認有網路後再試一次');
  }
}

// ---------- Wiring ----------
function applySettings() {
  document.body.classList.toggle('big', settings.big);
  $('optAutoSpeak').checked = settings.autoSpeak;
  $('optSlow').checked = settings.slow;
  $('optBig').checked = settings.big;
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
  // Never keep the microphone on in the background.
  document.addEventListener('visibilitychange', () => { if (document.hidden && autoMode) setAuto(false); });

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
      if (name === 'photo') loadTesseract().catch(() => {});
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

  const net = () => { $('offline').hidden = navigator.onLine; };
  window.addEventListener('online', net);
  window.addEventListener('offline', net);
  net();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();

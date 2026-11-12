import { PROVIDERS } from './shared.js';

const SR = 16000;              // Whisper работает на 16 кГц
const FRAME = SR / 10;         // кадр 100 мс
const MIN_SEC = 15, MAX_SEC = 28;
const CUT_PAUSE_FRAMES = 7;     // режем только на паузе ≥ 0,7 с, чтобы не рвать фразы
const SILENCE_RMS = 0.006;

let ctx = null, stream = null, settings = null, sessionId = null;
let resampler = null;
let chunk = [];                // массив кадров Float32Array(FRAME)
let chunkStartSample = 0, totalSamples = 0;
let frameBuf = new Float32Array(FRAME), frameN = 0;
let queue = [], busy = false, lastText = '';
let worker = null, workerReady = null, workerModel = null;

// ---------- ресемплинг до 16 кГц (усреднение по окну = простой антиалиасинг) ----------
function makeResampler(fromRate) {
  const ratio = fromRate / SR;
  let pend = new Float32Array(0), pos = 0;
  return (inp) => {
    const a = new Float32Array(pend.length + inp.length);
    a.set(pend); a.set(inp, pend.length);
    const out = [];
    while (pos + ratio <= a.length) {
      const i0 = Math.floor(pos), i1 = Math.max(i0 + 1, Math.floor(pos + ratio));
      let s = 0; for (let i = i0; i < i1; i++) s += a[i];
      out.push(s / (i1 - i0)); pos += ratio;
    }
    const keep = Math.floor(pos); pend = a.slice(keep); pos -= keep;
    return Float32Array.from(out);
  };
}

const rms = (f) => { let s = 0; for (let i = 0; i < f.length; i++) s += f[i] * f[i]; return Math.sqrt(s / f.length); };

function onPcm(data) {
  const pcm = resampler(data);
  for (let i = 0; i < pcm.length; i++) {
    frameBuf[frameN++] = pcm[i];
    if (frameN === FRAME) { pushFrame(frameBuf); frameBuf = new Float32Array(FRAME); frameN = 0; }
  }
}

function pushFrame(f) {
  f.rms = rms(f);
  chunk.push(f);
  totalSamples += FRAME;
  const sec = chunk.length / 10;
  if (sec >= MIN_SEC) {
    const tail = chunk.slice(-CUT_PAUSE_FRAMES);
    if (tail.every((x) => x.rms < SILENCE_RMS)) return cut(chunk.length);
  }
  if (sec >= MAX_SEC) {
    // режем в самом тихом месте последних 8 секунд, чтобы не рубить слова
    let best = chunk.length, bestR = Infinity;
    for (let i = chunk.length - 80; i < chunk.length; i++) if (chunk[i].rms < bestR) { bestR = chunk[i].rms; best = i + 1; }
    cut(best);
  }
}

function cut(n, final = false) {
  const frames = chunk.slice(0, n);
  chunk = chunk.slice(n);
  const t = chunkStartSample / SR;
  chunkStartSample += frames.length * FRAME;
  const voiced = frames.filter((x) => x.rms >= SILENCE_RMS).length;
  if (!frames.length || voiced < Math.max(5, frames.length * 0.1)) return; // тишина — пропускаем
  const audio = new Float32Array(frames.length * FRAME);
  frames.forEach((f, i) => audio.set(f, i * FRAME));
  queue.push({ t, audio, sessionId });
  report();
  pump();
}

function report() {
  chrome.runtime.sendMessage({ type: 'queue', queue: queue.length + (busy ? 1 : 0) }).catch(() => {});
}

// ---------- очередь распознавания ----------
async function pump() {
  if (busy || !queue.length) return;
  busy = true;
  const item = queue.shift();
  try {
    let text = settings.asrEngine === 'local'
      ? await transcribeLocal(item.audio)
      : await transcribeApi(item.audio);
    text = cleanText(text);
    if (text) {
      lastText = (lastText + ' ' + text).slice(-400);
      chrome.runtime.sendMessage({ type: 'segment', sessionId: item.sessionId, t: item.t, text }).catch(() => {});
    }
  } catch (e) {
    console.error(e);
    chrome.runtime.sendMessage({ type: 'asr-error', error: e.message }).catch(() => {});
  } finally {
    busy = false; report();
    if (queue.length) pump();
  }
}

// Whisper на тишине/музыке «галлюцинирует» типовыми фразами — выкидываем их
const JUNK = [
  /субтитр\S* (сделал|создавал|подогнал|делал)[^.!?]*[.!?]?/gi,
  /dimatorzok/gi,
  /редактор субтитров[^.!?]*[.!?]?/gi,
  /корректор [А-ЯA-Z]\.\s?[А-Яа-яA-Za-z]+[.!?]?/g,
  /^\s*продолжение следует\.{0,3}\s*$/gi,
  /^\s*(спасибо за просмотр|благодарю за внимание)[.!]?\s*$/gi,
  /^\s*\[?(музыка|аплодисменты|смех)\]?\s*$/gi
];
function cleanText(t) {
  t = (t || '').trim();
  for (const re of JUNK) t = t.replace(re, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return /[\p{L}\p{N}]/u.test(t) ? t : '';
}

// ---------- облачный Whisper (Groq / OpenAI) ----------
function toWav(f32) {
  const buf = new ArrayBuffer(44 + f32.length * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + f32.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, f32.length * 2, true);
  for (let i = 0; i < f32.length; i++) { const s = Math.max(-1, Math.min(1, f32[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Blob([buf], { type: 'audio/wav' });
}

const FALLBACK_ASR = { groq: 'whisper-large-v3-turbo', openai: 'whisper-1' };

async function transcribeApi(audio) {
  const engine = settings.asrEngine;
  const fd = new FormData();
  fd.append('file', toWav(audio), 'chunk.wav');
  fd.append('model', settings.models[engine].asr);
  if (settings.language && settings.language !== 'auto') fd.append('language', settings.language);
  fd.append('response_format', 'json');
  fd.append('temperature', '0');
  if (lastText) fd.append('prompt', lastText.slice(-200));
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(PROVIDERS[engine].baseUrl + '/audio/transcriptions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + settings.keys[engine] }, body: fd
    });
    if (r.status === 429) {
      const retry = parseFloat(r.headers.get('retry-after')) || 0;
      const body = await r.text();
      // дневной лимит модели исчерпан — переходим на запасную с отдельным лимитом
      if ((retry > 60 || /per day|RPD|TPD|ASD/i.test(body)) ) {
        if (fd.get('model') !== FALLBACK_ASR[engine]) {
          fd.set('model', FALLBACK_ASR[engine]); settings.models[engine].asr = FALLBACK_ASR[engine];
          chrome.runtime.sendMessage({ type: 'notice', text: `Дневной лимит основной модели распознавания исчерпан — переключился на ${FALLBACK_ASR[engine]}` }).catch(() => {});
          continue;
        }
        throw new Error('Дневной бесплатный лимит распознавания Groq исчерпан. Переключитесь на локальное распознавание в настройках или продолжите завтра.');
      }
      await new Promise((ok) => setTimeout(ok, Math.min(60, retry || 5 * (attempt + 1)) * 1000));
      continue;
    }
    if (r.status >= 500) {
      const wait = Math.min(60, parseFloat(r.headers.get('retry-after')) || 5 * (attempt + 1));
      await new Promise((ok) => setTimeout(ok, wait * 1000));
      continue;
    }
    if (r.status === 401) throw new Error('Неверный API-ключ — проверьте его в настройках');
    if (r.status === 404 && fd.get('model') !== FALLBACK_ASR[engine]) {
      // модель сняли — переходим на запасную
      fd.set('model', FALLBACK_ASR[engine]); settings.models[engine].asr = FALLBACK_ASR[engine];
      continue;
    }
    if (!r.ok) throw new Error(`Ошибка распознавания (${r.status}): ${(await r.text()).slice(0, 200)}`);
    return (await r.json()).text || '';
  }
  throw new Error('Лимит бесплатного тарифа исчерпан, попробуйте позже');
}

// ---------- локальный Whisper в Web Worker ----------
function ensureWorker(model) {
  if (worker && workerModel === model) return workerReady;
  worker?.terminate();
  worker = new Worker('local-asr-worker.js', { type: 'module' });
  workerModel = model;
  const pending = new Map(); let nextId = 1;
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') chrome.runtime.sendMessage({ type: 'local-progress', ...data }).catch(() => {});
    else if (pending.has(data.id)) { const p = pending.get(data.id); pending.delete(data.id); data.error ? p.reject(new Error(data.error)) : p.resolve(data); }
  };
  worker.call = (msg, transfer) => new Promise((resolve, reject) => {
    const id = nextId++; pending.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }, transfer || []);
  });
  workerReady = worker.call({ type: 'load', model });
  workerReady.catch((e) => { worker?.terminate(); worker = null; chrome.runtime.sendMessage({ type: 'local-progress', status: 'error', error: e.message }).catch(() => {}); });
  return workerReady;
}

async function transcribeLocal(audio) {
  await ensureWorker(settings.localModel);
  const r = await worker.call({ type: 'transcribe', audio, language: settings.language }, [audio.buffer]);
  return r.text;
}

// ---------- встроенный ИИ Chrome (Gemini Nano, Prompt API) ----------
async function chromeLLM(system, user) {
  if (!('LanguageModel' in self)) throw new Error('В этой версии Chrome нет встроенного ИИ (нужен Chrome 138+ и поддерживаемое железо)');
  const variants = [
    { initialPrompts: [{ role: 'system', content: system }], expectedInputs: [{ type: 'text', languages: ['ru'] }], expectedOutputs: [{ type: 'text', languages: ['ru'] }] },
    { initialPrompts: [{ role: 'system', content: system }] }
  ];
  for (const opts of variants) {
    let a; try { a = await LanguageModel.availability(opts); } catch { continue; }
    if (a === 'available') {
      const s = await LanguageModel.create(opts);
      try { return await s.prompt(user); } finally { s.destroy(); }
    }
    if (a === 'downloadable' || a === 'downloading') throw new Error('Модель встроенного ИИ ещё не скачана — нажмите «Скачать встроенный ИИ» в настройках');
  }
  throw new Error('Встроенный ИИ Chrome недоступен на этом устройстве');
}

// ---------- старт / стоп ----------
async function start(msg) {
  await stop();
  settings = msg.settings; sessionId = msg.sessionId;
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: msg.streamId } },
    video: false
  });
  ctx = new AudioContext();
  await ctx.audioWorklet.addModule('pcm-worklet.js');
  const src = ctx.createMediaStreamSource(stream);
  if (!settings.muteTab) src.connect(ctx.destination); // захват глушит вкладку — возвращаем звук
  const node = new AudioWorkletNode(ctx, 'pcm-collector');
  node.port.onmessage = (e) => onPcm(e.data);
  src.connect(node);
  const sink = ctx.createGain(); sink.gain.value = 0; node.connect(sink).connect(ctx.destination);
  resampler = makeResampler(ctx.sampleRate);
  chunk = []; chunkStartSample = 0; totalSamples = 0; frameN = 0; lastText = '';
  stream.getAudioTracks()[0].addEventListener('ended', () => chrome.runtime.sendMessage({ type: 'capture-ended' }));
  if (settings.asrEngine === 'local') ensureWorker(settings.localModel).catch(() => {});
}

async function stop() {
  if (!stream) return;
  if (chunk.length) cut(chunk.length, true);   // дослать хвост
  stream.getTracks().forEach((t) => t.stop());
  await ctx?.close().catch(() => {});
  stream = null; ctx = null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const reply = (p) => { p.then((v) => sendResponse({ ok: true, ...(v || {}) }), (e) => sendResponse({ ok: false, error: e.message })); return true; };
  switch (msg.type) {
    case 'offscreen-start': return reply(start(msg));
    case 'offscreen-stop': return reply(stop());
    case 'offscreen-flush': if (stream && chunk.length) cut(chunk.length); return reply(Promise.resolve());
    case 'offscreen-llm': return reply(chromeLLM(msg.system, msg.user).then((text) => ({ text })));
    case 'offscreen-preload': return reply(ensureWorker(msg.model).then(() => ({})));
  }
  return false;
});

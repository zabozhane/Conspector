import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;
env.useBrowserCache = true;
// wasm-файлы ONNX Runtime лежат внутри расширения (загружать код с CDN в MV3 нельзя)
env.backends.onnx.wasm.wasmPaths = new URL('./lib/', self.location.href).href;

const LANG = { ru: 'russian', en: 'english', uk: 'ukrainian', de: 'german', fr: 'french', es: 'spanish' };
let asr = null;

async function load(model) {
  const files = new Map();
  const progress_callback = (p) => {
    if (p.status === 'progress' && p.total) {
      files.set(p.file, { loaded: p.loaded, total: p.total });
      let l = 0, t = 0; for (const f of files.values()) { l += f.loaded; t += f.total; }
      postMessage({ type: 'progress', status: 'downloading', loaded: l, total: t });
    }
  };
  const turbo = /large|turbo|medium/.test(model);
  const tries = [];
  if (self.navigator?.gpu) tries.push({ device: 'webgpu', dtype: { encoder_model: turbo ? 'fp16' : 'fp32', decoder_model_merged: 'q4' } });
  tries.push({ device: 'wasm', dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' } });
  let lastErr;
  for (const opt of tries) {
    try {
      asr = await pipeline('automatic-speech-recognition', model, { ...opt, progress_callback });
      // прогрев, чтобы первый реальный фрагмент не ждал компиляции шейдеров
      await asr(new Float32Array(16000), { language: 'russian', task: 'transcribe' });
      postMessage({ type: 'progress', status: 'ready', device: opt.device });
      return;
    } catch (e) { lastErr = e; console.warn('ASR backend failed', opt.device, e); }
  }
  throw lastErr;
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') { await load(data.model); postMessage({ id: data.id }); }
    else if (data.type === 'transcribe') {
      const opts = { task: 'transcribe', chunk_length_s: 30 };
      if (data.language && data.language !== 'auto') opts.language = LANG[data.language] || data.language;
      const out = await asr(data.audio, opts);
      postMessage({ id: data.id, text: out.text });
    }
  } catch (e) {
    postMessage({ id: data.id, error: String(e?.message || e) });
  }
};

// Собирает моно-PCM из потока вкладки и отдаёт пачками в offscreen.js
class PcmCollector extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const ch = input.length, len = input[0].length;
      for (let i = 0; i < len; i++) {
        let v = 0;
        for (let c = 0; c < ch; c++) v += input[c][i];
        this.buf[this.n++] = v / ch;
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('pcm-collector', PcmCollector);

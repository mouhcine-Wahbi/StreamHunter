// AudioWorklet for live sound detection (opt-in): forwards the tab's audio, mixed to mono, to the
// offscreen document in blocks of 4096 samples. Nothing is stored here.
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(4096);
    this.n = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (channels && channels.length > 0) {
      const len = channels[0].length;
      for (let i = 0; i < len; i++) {
        let v = 0;
        for (let c = 0; c < channels.length; c++) v += channels[c][i];
        this.buf[this.n++] = v / channels.length;
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf.slice(0));
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("pcm-tap", PcmTap);

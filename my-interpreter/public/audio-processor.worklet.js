// AudioWorklet processor: sends small frames (~85ms) to the main thread.
// Pause detection and utterance assembly happen on the main thread so
// the worklet stays as simple as possible.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.buffer = [];
    this.frameSize = (options && options.processorOptions && options.processorOptions.frameSize) || 4096;
  }

  process(inputs) {
    if (!inputs || !inputs.length) return true;
    const ch0 = inputs[0];
    const input = ch0 && ch0[0];
    if (!input || typeof input.length !== 'number') return true;
    for (let i = 0; i < input.length; i++) this.buffer.push(input[i]);
    while (this.buffer.length >= this.frameSize) {
      const frame = this.buffer.splice(0, this.frameSize);
      this.port.postMessage({ frame: new Float32Array(frame) });
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);

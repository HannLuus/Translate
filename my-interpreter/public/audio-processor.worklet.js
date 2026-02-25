// AudioWorklet processor: sends small frames (~85ms) to the main thread.
// Pause detection and utterance assembly happen on the main thread so
// the worklet stays as simple as possible.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.buffer = [];
    this.frameSize = options.processorOptions?.frameSize ?? 4096;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) this.buffer.push(input[i]);
    while (this.buffer.length >= this.frameSize) {
      const frame = this.buffer.splice(0, this.frameSize);
      this.port.postMessage({ frame: new Float32Array(frame) });
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);

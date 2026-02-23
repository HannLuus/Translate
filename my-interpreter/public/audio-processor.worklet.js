// AudioWorklet processor: collects samples and posts chunks to main thread (replaces deprecated ScriptProcessorNode)
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.buffer = [];
    this.chunkSize = options.processorOptions?.chunkSize ?? 4096;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) this.buffer.push(input[i]);
    while (this.buffer.length >= this.chunkSize) {
      const chunk = this.buffer.splice(0, this.chunkSize);
      this.port.postMessage({ chunk: new Float32Array(chunk) });
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);

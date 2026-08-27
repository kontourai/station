class VoiceProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(4096);
    this._pos = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    let offset = 0;
    while (offset < input.length) {
      const remaining = this._buffer.length - this._pos;
      const toCopy = Math.min(remaining, input.length - offset);
      this._buffer.set(input.subarray(offset, offset + toCopy), this._pos);
      this._pos += toCopy;
      offset += toCopy;

      if (this._pos >= this._buffer.length) {
        this.port.postMessage(this._buffer.slice());
        this._pos = 0;
      }
    }
    return true;
  }
}

registerProcessor('voice-processor', VoiceProcessor);

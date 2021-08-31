import {Buffer} from 'node:buffer';
import {Transform} from 'node:stream';
import promisifyAll from 'util-promisifyall';
import bindings from 'bindings';

const binding = promisifyAll(bindings('vad'));

class VAD {
  constructor(mode) {
    const size = binding.vad_alloc(null);
    if (size.error) {
      throw new Error('Failed to get VAD size');
    }

    this._vad = Buffer.alloc(size.size);
    if (!binding.vad_alloc(this._vad)) {
      throw new Error('Failed to allocate VAD');
    }

    if (!binding.vad_init(this._vad)) {
      throw new Error('Failed to initialise VAD');
    }

    if (
      typeof mode !== 'number' ||
      !(mode >= VAD.Mode.NORMAL && mode <= VAD.Mode.VERY_AGGRESSIVE)
    ) {
      throw new Error('Invalid mode');
    }

    binding.vad_setmode(this._vad, mode);
  }

  // Expects 16 bit signed audio
  processAudio(buffer, rate, bits = 16) {
    if (bits === 32) {
      return binding.vad_processAudioAsync(
        this._vad,
        VAD.from32toFloatBuffer(buffer),
        rate
      );
    }

    return binding.vad_processAudioAsync(
      this._vad,
      VAD.from16toFloatBuffer(buffer),
      rate
    );
  }

  processAudioFloat(buffer, rate) {
    return binding.vad_processAudioAsync(this._vad, buffer, rate);
  }

  static createStream(options) {
    return new VADStream(options);
  }

  static from16toFloatBuffer(buffer) {
    const floatData = Buffer.alloc(buffer.length * 2);
    for (let i = 0; i < buffer.length; i += 2) {
      const intValue = buffer.readInt16LE(i);
      const floatValue = intValue / 32_768;
      floatData.writeFloatLE(floatValue, i * 2);
    }

    return floatData;
  }

  static from32toFloatBuffer(buffer) {
    const floatData = Buffer.alloc(buffer.length * 4);
    for (let i = 0; i < buffer.length; i += 4) {
      const floatValue = buffer.readFloatLE(i);
      floatData.writeFloatLE(floatValue, i * 4);
    }

    return floatData;
  }
}

class VADStream extends Transform {
  constructor({
    mode = VAD.Mode.NORMAL,
    audioFrequency = 16_000,
    debounceTime = 1000
  } = {}) {
    super({
      writableObjectMode: false,
      readableObjectMode: true
    });
    this.vad = new VAD(mode);

    if (typeof audioFrequency !== 'number') {
      throw new TypeError('audioFrequency must be a number');
    }

    if (
      !(
        audioFrequency === 8000 ||
        audioFrequency === 16_000 ||
        audioFrequency === 32_000 ||
        audioFrequency === 48_000
      )
    ) {
      throw new Error('audioFrequency must be 8000, 16000, 32000 or 48000');
    }

    this.audioFrequency = audioFrequency;

    if (typeof debounceTime !== 'number') {
      throw new TypeError('debounceTime must be a number');
    }

    if (debounceTime < 0) {
      throw new Error('debounceTime must be greater than 0');
    }

    this.debounceTime = debounceTime;

    this.timeMultiplier = 1000 / this.audioFrequency / 2;
    this.chunkLength = 60 / this.timeMultiplier;
    this.byteCount = 0;
    this.state = false;
    this.startTime = 0;
    this.lastSpeech = 0;

    this.buffer = Buffer.alloc(0);
  }

  _transform(chunk, encoding, callback) {
    return this._chunkTransform(Buffer.concat([this.buffer, chunk]), 0)
      .then((remaining) => {
        this.buffer = remaining;
        callback();
      })
      .catch((error) => {
        this.buffer = null;
        callback(error);
      });
  }

  _chunkTransform(chunk, start) {
    const end = start + this.chunkLength;
    if (end < chunk.length) {
      return this._processAudio(chunk.slice(start, end)).then(() =>
        this._chunkTransform(chunk, end)
      );
    }

    return Promise.resolve(chunk.slice(start));
  }

  _processAudio(chunk) {
    const time = this.timeMultiplier * this.byteCount;
    this.byteCount += chunk.length;

    return this.vad.processAudio(chunk, this.audioFrequency).then((event) => {
      if (event === VAD.Event.ERROR) {
        throw new Error('Error in VAD');
      }

      let start = false;
      let end = false;
      let {startTime} = this;
      const duration = this.state ? time - this.startTime : 0;

      if (event === VAD.Event.VOICE) {
        if (!this.state) {
          start = true;
          startTime = time;
          end = false;
          this.state = true;
          this.startTime = time;
        }

        this.lastSpeech = time;
      } else if (this.state && time - this.lastSpeech > this.debounceTime) {
        start = false;
        end = true;
        this.state = false;
        this.startTime = 0;
      }

      this.push({
        time,
        audioData: chunk,
        speech: {
          state: this.state,
          start,
          end,
          startTime,
          duration
        }
      });
    });
  }
}

VAD.Event = Object.freeze({
  ERROR: -1,
  SILENCE: 0,
  VOICE: 1,
  NOISE: 2
});

VAD.Mode = Object.freeze({
  NORMAL: 0,
  LOW_BITRATE: 1,
  AGGRESSIVE: 2,
  VERY_AGGRESSIVE: 3
});

export {VAD};

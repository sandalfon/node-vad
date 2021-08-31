import {fs} from 'node:fs';
import {VAD} from '../index.js';

const inputStream = fs.createReadStream('demo_pcm_s16_16000.raw');
const vadStream = VAD.createStream({
  mode: VAD.Mode.NORMAL,
  audioFrequency: 16_000,
  debounceTime: 1000
});

inputStream.pipe(vadStream).on('data', console.log);

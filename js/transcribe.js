/**
 * transcribe.js — runs Whisper entirely in the browser (via
 * transformers.js / ONNX Runtime Web) to get word-level timestamps
 * for what was actually said in the recording.
 *
 * The model downloads once from the Hugging Face CDN and is cached
 * by the browser after that — no server of ours involved, no per-use
 * cost, and the audio itself never leaves the browser.
 *
 * Model choice: whisper-base.en (English-only). English-only Whisper
 * variants are generally more accurate on English speech than the
 * same-size multilingual model, which matters more than usual here
 * since these are English-practice recordings, possibly with an
 * accent. Swap MODEL_ID below to trade accuracy for speed/download
 * size (e.g. 'Xenova/whisper-tiny.en' is faster/smaller but less
 * accurate; 'Xenova/whisper-small.en' is slower/bigger but more
 * accurate).
 */
// Explicit path to the browser ESM build (not the bare package URL):
// this package's default npm "main" points at a Node-only CJS bundle
// that imports node:fs/node:path, which would break in a browser.
import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/dist/transformers.web.min.js';

const MODEL_ID = 'Xenova/whisper-base.en';

let transcriberPromise = null;

/**
 * @param {(info: {status: string, progress?: number, file?: string}) => void} [onProgress]
 */
function getTranscriber(onProgress) {
  if (!transcriberPromise) {
    transcriberPromise = pipeline('automatic-speech-recognition', MODEL_ID, {
      progress_callback: onProgress,
    }).catch((err) => {
      // Let the next call retry instead of permanently caching a failure.
      transcriberPromise = null;
      throw err;
    });
  }
  return transcriberPromise;
}

/**
 * @param {Float32Array} pcm16k — mono 16kHz PCM, from audio.js
 * @param {(info: any) => void} [onProgress]
 * @returns {Promise<{text: string, start: number, end: number}[]>} words in order
 */
export async function transcribeWords(pcm16k, onProgress) {
  const transcriber = await getTranscriber(onProgress);

  const output = await transcriber(pcm16k, {
    return_timestamps: 'word',
    chunk_length_s: 30,
    stride_length_s: 5,
  });

  const chunks = output?.chunks ?? [];
  return chunks
    .map((c) => ({
      text: (c.text ?? '').trim(),
      start: c.timestamp[0],
      // Whisper occasionally reports a null end timestamp for the very
      // last word of a chunk boundary — fall back to start + a hair
      // rather than propagate NaN into downstream timing math.
      end: c.timestamp[1] != null ? c.timestamp[1] : c.timestamp[0] + 0.05,
    }))
    .filter((w) => w.text.length > 0);
}

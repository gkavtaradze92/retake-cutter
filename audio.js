/**
 * audio.js — pulls the audio track out of an uploaded video file and
 * resamples it to mono 16kHz Float32 PCM, which is exactly what the
 * Whisper model in transcribe.js expects as input.
 *
 * Uses only the browser's built-in Web Audio API — no ffmpeg needed
 * for this step, no network call, no upload anywhere.
 */

/**
 * @param {File} file
 * @returns {Promise<{ pcm: Float32Array, durationSec: number }>}
 */
export async function extractPCM16k(file) {
  const arrayBuffer = await file.arrayBuffer();

  // Some browsers detach/consume the buffer passed to decodeAudioData,
  // so this must be the only thing that touches this particular copy.
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) {
    throw new Error('This browser does not support the Web Audio API (needed to read the video\'s audio track).');
  }

  const decodeCtx = new AudioCtx();
  let decoded;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer);
  } finally {
    decodeCtx.close();
  }

  const targetRate = 16000;
  const targetLength = Math.max(1, Math.ceil(decoded.duration * targetRate));

  // Rendering through an OfflineAudioContext with 1 output channel and
  // a different sample rate does both the mono downmix AND the
  // resample in one step — the browser handles both per the Web Audio
  // spec's standard channel-mixing and resampling rules.
  const offlineCtx = new OfflineAudioContext(1, targetLength, targetRate);
  const source = offlineCtx.createBufferSource();
  source.buffer = decoded;
  source.connect(offlineCtx.destination);
  source.start(0);

  const rendered = await offlineCtx.startRendering();

  return {
    pcm: rendered.getChannelData(0),
    durationSec: decoded.duration,
  };
}

/** Reads just the duration of a video file, for UI display before processing starts. */
export function readVideoDuration(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    // Some browsers only reliably fire loadedmetadata for elements
    // that are actually in the document — keep it present but invisible
    // rather than risk flaky behavior with a fully detached element.
    video.style.position = 'fixed';
    video.style.width = '1px';
    video.style.height = '1px';
    video.style.opacity = '0';
    video.style.pointerEvents = 'none';
    document.body.appendChild(video);

    const cleanup = () => {
      URL.revokeObjectURL(video.src);
      video.remove();
    };

    video.onloadedmetadata = () => {
      const duration = video.duration;
      cleanup();
      resolve(duration);
    };
    video.onerror = () => {
      const code = video.error ? video.error.code : 'unknown';
      const message = video.error ? video.error.message : '';
      cleanup();
      reject(new Error(`Could not read video metadata (code ${code}${message ? `: ${message}` : ''}) — is this a valid video file?`));
    };
    video.src = URL.createObjectURL(file);
  });
}

/**
 * export.js — takes the original video file plus a list of
 * {start, end} segments to keep (from planCuts.js) and produces the
 * final edited video, using ffmpeg compiled to WebAssembly. Runs
 * entirely in the browser; nothing is uploaded anywhere.
 */
import { FFmpeg } from 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/index.js';
import { fetchFile, toBlobURL } from 'https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/esm/index.js';

const CORE_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';

let ffmpegPromise = null;

/** @param {(msg: {ratio: number}) => void} [onProgress] */
function getFFmpeg(onProgress) {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const ffmpeg = new FFmpeg();
      if (onProgress) {
        ffmpeg.on('progress', onProgress);
      }
      await ffmpeg.load({
        coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
      });
      return ffmpeg;
    })().catch((err) => {
      ffmpegPromise = null;
      throw err;
    });
  }
  return ffmpegPromise;
}

/**
 * Builds the -filter_complex string that trims each keep segment from
 * the input and concatenates them back into one continuous stream,
 * for both video and audio.
 *
 * @param {{start:number end:number}[]} segments
 */
export function buildFilterComplex(segments) {
  const parts = [];
  const labels = [];
  segments.forEach((seg, i) => {
    parts.push(
      `[0:v]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS[v${i}]`,
      `[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${i}]`
    );
    labels.push(`[v${i}][a${i}]`);
  });
  parts.push(`${labels.join('')}concat=n=${segments.length}:v=1:a=1[outv][outa]`);
  return parts.join(';');
}

/**
 * @param {File} videoFile
 * @param {{start:number, end:number}[]} keepSegments
 * @param {(info: {ratio: number}) => void} [onProgress] — ratio is 0..1 (ffmpeg's own estimate, occasionally exceeds 1 near the end — clamp in the UI)
 * @returns {Promise<Blob>} the exported video as an mp4 Blob
 */
export async function exportEditedVideo(videoFile, keepSegments, onProgress) {
  if (!keepSegments || keepSegments.length === 0) {
    throw new Error('No segments to keep — refusing to export an empty video.');
  }

  const ffmpeg = await getFFmpeg(onProgress);

  const inputName = 'input' + extensionOf(videoFile.name || 'input.mp4');
  const outputName = 'output.mp4';

  await ffmpeg.writeFile(inputName, await fetchFile(videoFile));

  const filterComplex = buildFilterComplex(keepSegments);

  await ffmpeg.exec([
    '-i', inputName,
    '-filter_complex', filterComplex,
    '-map', '[outv]',
    '-map', '[outa]',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    outputName,
  ]);

  const data = await ffmpeg.readFile(outputName);

  // Clean up ffmpeg's virtual filesystem so repeated exports in the
  // same session don't slowly leak memory.
  await ffmpeg.deleteFile(inputName).catch(() => {});
  await ffmpeg.deleteFile(outputName).catch(() => {});

  return new Blob([data.buffer], { type: 'video/mp4' });
}

function extensionOf(filename) {
  const match = /\.[a-zA-Z0-9]+$/.exec(filename);
  return match ? match[0] : '.mp4';
}

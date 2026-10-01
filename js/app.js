import { tokenizeScript, alignLCS } from './align.js';
import { planKeepSegments, totalCutSeconds } from './planCuts.js';
import { planKeepSegmentsAuto } from './autoDetect.js';
import { extractPCM16k, readVideoDuration } from './audio.js';
import { transcribeWords } from './transcribe.js';
import { exportEditedVideo } from './export.js';

const $ = (id) => document.getElementById(id);

const dropZone = $('drop-zone');
const fileInput = $('file-input');
const scriptInput = $('script-input');
const processBtn = $('process-btn');
const statusLine = $('status-line');
const progressBar = $('progress-bar');
const originalVideo = $('original-video');
const editedVideo = $('edited-video');
const downloadBtn = $('download-btn');
const statsLine = $('stats-line');
const editedPanel = $('edited-panel');

let selectedFile = null;
let editedBlobUrl = null;

// ---- File selection (click or drag/drop) ----

dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files?.[0];
  if (file) handleFileSelected(file);
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) handleFileSelected(file);
});

async function handleFileSelected(file) {
  selectedFile = file;
  const url = URL.createObjectURL(file);
  originalVideo.src = url;
  dropZone.querySelector('.drop-zone-label').textContent = file.name;
  updateProcessAvailability();
}

scriptInput.addEventListener('input', updateProcessAvailability);

downloadBtn.addEventListener('click', (e) => {
  if (downloadBtn.classList.contains('disabled')) e.preventDefault();
});

function updateProcessAvailability() {
  // Script is optional — without one, auto-detect mode kicks in (see runPipeline).
  processBtn.disabled = !selectedFile;
}

// ---- Processing pipeline ----

processBtn.addEventListener('click', runPipeline);

function setStatus(text, ratio /* 0..1 or null to hide bar */) {
  statusLine.textContent = text;
  if (ratio == null) {
    progressBar.style.display = 'none';
  } else {
    progressBar.style.display = 'block';
    progressBar.style.setProperty('--progress', `${Math.max(0, Math.min(1, ratio)) * 100}%`);
  }
}

function setBusy(busy) {
  processBtn.disabled = busy;
  fileInput.disabled = busy;
  scriptInput.disabled = busy;
}

async function runPipeline() {
  if (!selectedFile) return;

  setBusy(true);
  editedPanel.classList.remove('visible');
  downloadBtn.classList.add('disabled');

  try {
    setStatus('Reading video length…', null);
    const durationSec = await readVideoDuration(selectedFile);

    setStatus('Extracting audio from the video…', null);
    const { pcm } = await extractPCM16k(selectedFile);

    setStatus('Loading speech model (first run downloads ~150MB, then it\'s cached)…', 0);
    const words = await transcribeWords(pcm, (info) => {
      if (info?.status === 'progress' && typeof info.progress === 'number') {
        setStatus(`Loading speech model… (${info.file || ''})`, info.progress / 100);
      } else if (info?.status === 'ready' || info?.status === 'done') {
        setStatus('Speech model ready. Transcribing your recording…', null);
      }
    });

    if (words.length === 0) {
      throw new Error(
        "Whisper didn't detect any speech in this recording. Check that the video actually has audio, or try a clearer take."
      );
    }

    const hasScript = scriptInput.value.trim().length > 0;
    let keepSegments;
    let modeLabel;

    if (hasScript) {
      setStatus('Matching what you said against the script…', null);
      const scriptWords = tokenizeScript(scriptInput.value);
      const anchors = alignLCS(scriptWords, words);

      const matchedCount = anchors.filter((a) => a !== -1).length;
      if (matchedCount < scriptWords.length * 0.4) {
        // Loud, specific warning rather than silently producing a bad cut —
        // low match rate usually means an accent/audio-quality mismatch
        // with the transcription, or the wrong script was pasted in.
        setStatus(
          `Warning: only matched ${matchedCount} of ${scriptWords.length} script words — the edit below may be unreliable. Check the script matches this recording.`,
          null
        );
        await sleep(2500);
      }

      keepSegments = planKeepSegments(scriptWords, words, anchors, durationSec);
      modeLabel = 'script-matched';
    } else {
      // No script pasted — fall back to self-similarity auto-detection.
      // Less reliable: it can only catch retakes that closely repeat the
      // flubbed wording, and can wrongly cut genuinely repeated phrases.
      // See js/autoDetect.js for the full explanation.
      setStatus(
        'No script provided — using automatic retake detection (less precise than script-matching; review the result before trusting it).',
        null
      );
      await sleep(1500);
      keepSegments = planKeepSegmentsAuto(words, durationSec);
      modeLabel = 'auto-detected (no script)';
    }

    const cutSeconds = totalCutSeconds(keepSegments, durationSec);

    setStatus(`Exporting edited video (${modeLabel}) — cutting ${cutSeconds.toFixed(1)}s…`, null);

    const editedBlob = await exportEditedVideo(selectedFile, keepSegments, (info) => {
      if (typeof info?.ratio === 'number') {
        setStatus('Exporting edited video…', info.ratio);
      }
    });

    if (editedBlobUrl) URL.revokeObjectURL(editedBlobUrl);
    editedBlobUrl = URL.createObjectURL(editedBlob);
    editedVideo.src = editedBlobUrl;
    editedPanel.classList.add('visible');

    downloadBtn.href = editedBlobUrl;
    downloadBtn.download = withSuffix(selectedFile.name, '-edited');
    downloadBtn.classList.remove('disabled');

    statsLine.textContent = `[${modeLabel}] Original: ${durationSec.toFixed(1)}s → Edited: ${(durationSec - cutSeconds).toFixed(1)}s (removed ${cutSeconds.toFixed(1)}s, ${keepSegments.length} kept segment${keepSegments.length === 1 ? '' : 's'})`;

    setStatus('Done.', null);
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message || err}`, null);
  } finally {
    setBusy(false);
    updateProcessAvailability();
  }
}

function withSuffix(filename, suffix) {
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return filename + suffix;
  return filename.slice(0, dot) + suffix + filename.slice(dot);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

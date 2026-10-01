/**
 * autoDetect.js — plans keep-segments WITHOUT a script, for when the
 * person didn't paste one. This is a fundamentally different (and
 * less reliable) approach than align.js + planCuts.js:
 *
 * With a script, we know the "correct answer" and can tell exactly
 * which words were a flub vs. the real line. Without one, the only
 * signal available is SELF-similarity: if you say something, pause,
 * then say something that sounds a lot like it again, the second
 * one is probably the corrected retake and the first was the flub.
 *
 * ── Why this is heuristic, not reliable ─────────────────────────
 * - A legitimately repeated phrase ("really, really good") can look
 *   exactly like a flub+retake and will get wrongly cut.
 * - A retake that DOESN'T closely repeat the flubbed wording (e.g.
 *   you rephrase instead of repeating verbatim) won't be detected
 *   at all and will be left in untouched.
 * - There's no ground truth, so confidence here is inherently lower
 *   than script-matched mode. Always review the output.
 *
 * ── How it works ─────────────────────────────────────────────────
 * 1. Group transcript words into "utterances" — consecutive words
 *    with no pause longer than utteranceBreakSec between them.
 * 2. Walk utterances in order. If utterance i+1's words overlap
 *    utterance i's words above a similarity threshold, treat i as a
 *    superseded flub (cut it) and move on to i+1 as the new
 *    "current" utterance — chaining through multiple retakes of the
 *    same line if needed.
 * 3. Utterances that survive become kept segments. The gap between
 *    two consecutive KEPT utterances is trimmed the same way
 *    planCuts.js trims overlong pauses (short pause kept, not
 *    removed outright, so the edit doesn't feel rushed).
 */

import { normalizeWord } from './align.js';

const DEFAULT_OPTIONS = {
  // Gap between words longer than this starts a new utterance.
  utteranceBreakSec: 0.6,
  // Dice coefficient (0-1) above which two adjacent utterances are
  // considered "the same line said twice" (flub + retake).
  similarityThreshold: 0.6,
  // Pause between KEPT utterances longer than this gets trimmed.
  longPauseThresholdSec: 1.2,
  // How much of an overlong pause between kept utterances to leave.
  keptPauseSec: 0.35,
  cutBufferSec: 0.06,
  edgePaddingSec: 0.15,
};

/**
 * @param {{text:string,start:number,end:number}[]} transcriptWords
 * @param {number} breakGapSec
 * @returns {{words: {text:string,start:number,end:number}[], start:number, end:number}[]}
 */
export function buildUtterances(transcriptWords, breakGapSec) {
  if (transcriptWords.length === 0) return [];

  const utterances = [];
  let current = [transcriptWords[0]];

  for (let i = 1; i < transcriptWords.length; i++) {
    const gap = transcriptWords[i].start - transcriptWords[i - 1].end;
    if (gap > breakGapSec) {
      utterances.push(current);
      current = [transcriptWords[i]];
    } else {
      current.push(transcriptWords[i]);
    }
  }
  utterances.push(current);

  return utterances.map((words) => ({
    words,
    start: words[0].start,
    end: words[words.length - 1].end,
  }));
}

/** Dice coefficient over normalized word MULTISETS (repeated words counted). */
export function wordOverlapSimilarity(wordsA, wordsB) {
  const normA = wordsA.map((w) => normalizeWord(w.text)).filter(Boolean);
  const normB = wordsB.map((w) => normalizeWord(w.text)).filter(Boolean);

  if (normA.length === 0 && normB.length === 0) return 0;

  const countA = countOf(normA);
  const countB = countOf(normB);

  let overlap = 0;
  for (const [word, countInA] of countA) {
    overlap += Math.min(countInA, countB.get(word) || 0);
  }

  return (2 * overlap) / (normA.length + normB.length);
}

function countOf(words) {
  const map = new Map();
  for (const w of words) map.set(w, (map.get(w) || 0) + 1);
  return map;
}

/**
 * @param {{text:string,start:number,end:number}[]} transcriptWords
 * @param {number} videoDurationSec
 * @param {Partial<typeof DEFAULT_OPTIONS>} [options]
 * @returns {{start:number, end:number}[]}
 */
export function planKeepSegmentsAuto(transcriptWords, videoDurationSec, options = {}) {
  const opt = { ...DEFAULT_OPTIONS, ...options };

  if (transcriptWords.length === 0) {
    return [{ start: 0, end: videoDurationSec }];
  }

  const utterances = buildUtterances(transcriptWords, opt.utteranceBreakSec);

  // Mark which utterances are superseded (a flub later repeated).
  const superseded = new Array(utterances.length).fill(false);
  for (let i = 0; i < utterances.length - 1; i++) {
    const sim = wordOverlapSimilarity(utterances[i].words, utterances[i + 1].words);
    if (sim >= opt.similarityThreshold) {
      superseded[i] = true;
    }
  }

  const keptIndices = [];
  for (let i = 0; i < utterances.length; i++) {
    if (!superseded[i]) keptIndices.push(i);
  }

  if (keptIndices.length === 0) {
    // Everything looked like a chain of retakes with nothing left —
    // safest fallback is to keep the very last utterance at least.
    keptIndices.push(utterances.length - 1);
  }

  const segments = [];
  let segStart =
    keptIndices[0] === 0 && !superseded[0]
      ? Math.max(0, utterances[0].start - opt.edgePaddingSec)
      : Math.max(0, utterances[keptIndices[0]].start - opt.cutBufferSec);

  for (let k = 0; k < keptIndices.length; k++) {
    const idx = keptIndices[k];
    const nextIdx = keptIndices[k + 1];

    if (nextIdx === undefined) {
      const tailEnd = Math.min(videoDurationSec, utterances[idx].end + opt.edgePaddingSec);
      segments.push({ start: segStart, end: tailEnd });
      break;
    }

    const isAdjacent = nextIdx === idx + 1;
    const pause = isAdjacent ? utterances[nextIdx].start - utterances[idx].end : null;

    if (!isAdjacent) {
      // One or more superseded utterances sit between idx and nextIdx — cut them.
      segments.push({ start: segStart, end: utterances[idx].end + opt.cutBufferSec });
      segStart = Math.max(utterances[idx].end, utterances[nextIdx].start - opt.cutBufferSec);
    } else if (pause > opt.longPauseThresholdSec) {
      segments.push({ start: segStart, end: utterances[idx].end + opt.keptPauseSec });
      segStart = utterances[nextIdx].start - opt.keptPauseSec;
    }
    // else: normal pause between two kept, adjacent utterances — just continue the segment through it.
  }

  return mergeAndClamp(segments, videoDurationSec);
}

function mergeAndClamp(segments, duration) {
  const clamped = segments
    .map((s) => ({ start: Math.max(0, s.start), end: Math.min(duration, s.end) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);

  const merged = [];
  for (const seg of clamped) {
    const last = merged[merged.length - 1];
    if (last && seg.start <= last.end + 0.01) {
      last.end = Math.max(last.end, seg.end);
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

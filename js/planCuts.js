/**
 * planCuts.js — turns alignment anchors (see align.js) into a concrete
 * list of [start, end] time ranges to KEEP from the original video.
 *
 * Two things get cut:
 *  1. "Junk" stretches — transcript words between two anchors that
 *     aren't part of the matched script (flubs, restarts, filler).
 *     These are cut ENTIRELY except for a small buffer so the cut
 *     doesn't feel like a jump-splice.
 *  2. Overlong silences even inside otherwise-good speech — trimmed
 *     down to a fixed short pause rather than removed completely
 *     (removing all pause sounds unnaturally rushed).
 *
 * Output is a list of {start, end} in ORIGINAL video seconds, sorted,
 * non-overlapping, ready to hand to export.js for ffmpeg trim+concat.
 */

const DEFAULT_OPTIONS = {
  // Pause between words longer than this is a candidate for trimming.
  longPauseThresholdSec: 1.2,
  // When trimming a long pause, how much of it to leave behind.
  keptPauseSec: 0.35,
  // Small buffer kept on each side of a junk cut, so the edit doesn't
  // clip the tail/head of the surrounding good words.
  cutBufferSec: 0.06,
  // Leading/trailing padding kept around the very first/last anchor.
  edgePaddingSec: 0.15,
};

/**
 * @param {{norm:string}[]} scriptWords
 * @param {{text:string,start:number,end:number}[]} transcriptWords
 * @param {number[]} anchors — from align.alignLCS(scriptWords, transcriptWords)
 * @param {number} videoDurationSec
 * @param {Partial<typeof DEFAULT_OPTIONS>} [options]
 * @returns {{start:number, end:number}[]} segments to keep, in order
 */
export function planKeepSegments(scriptWords, transcriptWords, anchors, videoDurationSec, options = {}) {
  const opt = { ...DEFAULT_OPTIONS, ...options };

  // Reduce to the ordered list of anchors that actually matched something.
  const matched = [];
  for (let i = 0; i < anchors.length; i++) {
    if (anchors[i] !== -1) matched.push(anchors[i]);
  }

  if (matched.length === 0) {
    // Nothing matched at all (e.g. empty script or transcription failed) —
    // safest fallback is "keep everything, change nothing".
    return [{ start: 0, end: videoDurationSec }];
  }

  const segments = [];

  // Leading edge: if transcript index 0 is itself the first matched
  // word, there's genuine content right from the start of the clip —
  // keep a small padding before it. But if matched[0] > 0, everything
  // before it is a flub that was never followed by a correct
  // continuation until this point (e.g. the recording opens with a
  // false start) — treat it exactly like inter-anchor junk and cut it,
  // leaving only a small cut buffer rather than a full pad.
  const firstWord = transcriptWords[matched[0]];
  const hasLeadingJunk = matched[0] > 0;
  const segStartInit = hasLeadingJunk
    ? Math.max(0, firstWord.start - opt.cutBufferSec)
    : Math.max(0, firstWord.start - opt.edgePaddingSec);

  let segStart = segStartInit;

  for (let k = 1; k < matched.length; k++) {
    const prevIdx = matched[k - 1];
    const curIdx = matched[k];
    const prevWord = transcriptWords[prevIdx];
    const curWord = transcriptWords[curIdx];

    const hasJunkBetween = curIdx > prevIdx + 1; // extra transcript words in between = a flub/restart

    if (hasJunkBetween) {
      // Close out the segment up to the end of the last good word
      // (plus a tiny buffer so we don't clip its tail), then start a
      // fresh segment at the next good word (minus a tiny buffer).
      segments.push({ start: segStart, end: prevWord.end + opt.cutBufferSec });
      segStart = Math.max(prevWord.end, curWord.start - opt.cutBufferSec);
    } else {
      // Consecutive good words — check the pause between them.
      const pause = curWord.start - prevWord.end;
      if (pause > opt.longPauseThresholdSec) {
        segments.push({ start: segStart, end: prevWord.end + opt.keptPauseSec });
        segStart = curWord.start - opt.keptPauseSec;
      }
      // else: normal-length pause, just let the segment continue through it.
    }
  }

  // Trailing padding after the last matched word.
  const lastWord = transcriptWords[matched[matched.length - 1]];
  const tailEnd = Math.min(videoDurationSec, lastWord.end + opt.edgePaddingSec);
  segments.push({ start: segStart, end: tailEnd });

  return mergeAndClamp(segments, videoDurationSec);
}

/** Merge overlapping/adjacent segments and clamp to [0, duration]. */
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

/** Total seconds that will be removed — handy for a "cut 42s of 3:10" UI readout. */
export function totalCutSeconds(keepSegments, videoDurationSec) {
  const kept = keepSegments.reduce((sum, s) => sum + (s.end - s.start), 0);
  return Math.max(0, videoDurationSec - kept);
}

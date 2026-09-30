/**
 * align.js — matches the words you were SUPPOSED to say (the script)
 * against the words Whisper heard you actually say (the transcript),
 * so we know which parts of the recording are "real" narration and
 * which parts are flubs/retakes to cut.
 *
 * Pure logic, zero browser/DOM dependency — this is what makes it
 * possible to unit-test with plain Node (see test/align.test.js)
 * instead of trusting it blind inside a browser.
 *
 * ── The problem in one picture ──────────────────────────────────
 * Script:      "the quick brown fox jumps"
 * You actually said (shadowing, one take, no re-recording):
 *   "the quick br- the quick brown fox jumps"
 *              ^ flub, restarts the sentence
 *
 * Transcript words (from Whisper, with timestamps):
 *   the, quick, br, the, quick, brown, fox, jumps
 *
 * We want to keep only:  the(2nd) quick(2nd) brown fox jumps
 * and cut the first "the quick br" attempt (word junk + the pause
 * around it).
 *
 * ── How it works ────────────────────────────────────────────────
 * 1. Standard LCS (longest common subsequence) between script words
 *    and transcript words gives a baseline set of "anchors" — script
 *    word i is matched to transcript word j. Textbook LCS backtracking
 *    prefers the EARLIEST valid match, which is wrong for our case
 *    (it would anchor to the flubbed first "the quick" instead of the
 *    corrected second one).
 * 2. So we widen each anchor forward: if the same normalized word
 *    appears again before the NEXT anchor, we snap to the LATEST
 *    such occurrence. That's the "keep the last, correct attempt"
 *    rule, and it's the whole trick.
 *
 * This is intentionally simple word-matching, not a phonetic aligner —
 * see README "Known limitations" for what that means in practice.
 */

/** Lowercase + strip everything except letters/digits/apostrophe. */
export function normalizeWord(word) {
  return word.toLowerCase().replace(/[^a-z0-9']/g, '');
}

/** Split raw script text into normalized word tokens (order preserved). */
export function tokenizeScript(scriptText) {
  return scriptText
    .split(/\s+/)
    .map((raw) => ({ raw, norm: normalizeWord(raw) }))
    .filter((w) => w.norm.length > 0);
}

/**
 * @param {{norm: string}[]} scriptWords
 * @param {{text: string, start: number, end: number}[]} transcriptWords
 * @returns {number[]} for each script word index, the matched transcript
 *   word index, or -1 if no match was found (script word never said,
 *   or Whisper missed it — treated as "skip it, don't cut anything for it").
 */
export function alignLCS(scriptWords, transcriptWords) {
  const n = scriptWords.length;
  const m = transcriptWords.length;
  const tNorm = transcriptWords.map((w) => normalizeWord(w.text));

  // dp[i][j] = length of LCS of scriptWords[i:] and transcript[j:]
  // Stored as (n+1) x (m+1); flattened would be faster but n,m are
  // word counts of a short-form video script — a few hundred at most.
  const dp = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint16Array(m + 1);

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (scriptWords[i].norm.length > 0 && scriptWords[i].norm === tNorm[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  // Backtrack to get the baseline (earliest-preferring) anchor set.
  const rawAnchors = new Array(n).fill(-1);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (scriptWords[i].norm.length > 0 && scriptWords[i].norm === tNorm[j]) {
      rawAnchors[i] = j;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  // Widen backward (from the end of the script toward the start): for
  // each matched anchor, if the exact same normalized word occurs
  // again later but still before the NEXT anchor's (already-widened)
  // position, snap to that later occurrence. This is what turns
  // "first attempt" into "final, corrected attempt".
  //
  // Direction matters: if we widened forward (left to right), anchor
  // a's search bound would be anchor a+1's UN-widened, earliest-preferring
  // position — which is often just one word away and hides the real
  // retake several words later. Going right to left, each anchor's
  // bound is the position its neighbour was ALREADY snapped to, which
  // is the correct, later bound.
  const anchors = rawAnchors.slice();
  let boundExclusive = m;
  for (let a = n - 1; a >= 0; a--) {
    if (anchors[a] === -1) continue; // gap (word Whisper never heard) — leave as -1, don't move the bound
    const word = scriptWords[a].norm;
    let latest = anchors[a];
    for (let t = anchors[a] + 1; t < boundExclusive; t++) {
      if (tNorm[t] === word) latest = t;
    }
    anchors[a] = latest;
    boundExclusive = anchors[a];
  }

  return anchors;
}

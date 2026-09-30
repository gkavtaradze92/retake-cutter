// Plain Node test, no framework — run with: node test/align.test.js
// Exits non-zero and prints failures if anything breaks.
import { normalizeWord, tokenizeScript, alignLCS } from '../js/align.js';

let failures = 0;
function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`✗ ${label}\n  expected: ${e}\n  actual:   ${a}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

// Helper to build fake transcript words (timestamps don't matter for align.js itself)
function tw(words) {
  return words.map((text, idx) => ({ text, start: idx, end: idx + 1 }));
}

// --- normalizeWord ---
assertEqual(normalizeWord("Fox,"), "fox", "normalizeWord strips punctuation");
assertEqual(normalizeWord("DON'T"), "don't", "normalizeWord keeps apostrophes, lowercases");
assertEqual(normalizeWord("--"), "", "normalizeWord on pure punctuation is empty");

// --- tokenizeScript ---
assertEqual(
  tokenizeScript("The quick, brown fox!").map((w) => w.norm),
  ["the", "quick", "brown", "fox"],
  "tokenizeScript normalizes each word"
);

// --- alignLCS: perfect read, no mistakes ---
{
  const script = tokenizeScript("the quick brown fox jumps");
  const transcript = tw(["the", "quick", "brown", "fox", "jumps"]);
  const anchors = alignLCS(script, transcript);
  assertEqual(anchors, [0, 1, 2, 3, 4], "perfect read maps 1:1 in order");
}

// --- alignLCS: single-word stutter, snaps to LAST occurrence ---
{
  // "the quick br- the quick brown fox jumps"
  const script = tokenizeScript("the quick brown fox jumps");
  const transcript = tw(["the", "quick", "br", "the", "quick", "brown", "fox", "jumps"]);
  const anchors = alignLCS(script, transcript);
  // "the" should anchor to index 3 (not 0), "quick" to index 4 (not 1)
  assertEqual(anchors, [3, 4, 5, 6, 7], "single-word stutter snaps to the corrected retake");
}

// --- alignLCS: whole-phrase restart ---
{
  // Script: "call me back tomorrow please"
  // Said:   "call me back — call me back tomorrow please"
  const script = tokenizeScript("call me back tomorrow please");
  const transcript = tw(["call", "me", "back", "call", "me", "back", "tomorrow", "please"]);
  const anchors = alignLCS(script, transcript);
  assertEqual(anchors, [3, 4, 5, 6, 7], "whole-phrase restart snaps entirely to the second attempt");
}

// --- alignLCS: filler word inserted mid-take shouldn't break later anchors ---
{
  // Script: "this is a great deal"
  // Said:   "this is uh a great deal"
  const script = tokenizeScript("this is a great deal");
  const transcript = tw(["this", "is", "uh", "a", "great", "deal"]);
  const anchors = alignLCS(script, transcript);
  assertEqual(anchors, [0, 1, 3, 4, 5], "filler word between correct words doesn't shift anchors");
}

// --- alignLCS: word Whisper never caught (mis-heard) still aligns the rest ---
{
  const script = tokenizeScript("the quick brown fox jumps high");
  // Whisper mis-heard "brown" as silence/nothing — word just missing
  const transcript = tw(["the", "quick", "fox", "jumps", "high"]);
  const anchors = alignLCS(script, transcript);
  assertEqual(anchors[0], 0, "unaffected word before the gap still anchors");
  assertEqual(anchors[1], 1, "unaffected word before the gap still anchors (2)");
  assertEqual(anchors[2], -1, "word Whisper missed has no anchor (-1), not a false match");
  assertEqual(anchors[3], 2, "alignment recovers after the missed word");
  assertEqual(anchors[4], 3, "alignment recovers after the missed word (2)");
  assertEqual(anchors[5], 4, "alignment recovers after the missed word (3)");
}

// --- alignLCS: repeated word that's ACTUALLY in the script twice (not a stutter) ---
{
  // Script legitimately repeats "no" — must not eat the second real "no"
  const script = tokenizeScript("no no i said no way");
  const transcript = tw(["no", "no", "i", "said", "no", "way"]);
  const anchors = alignLCS(script, transcript);
  assertEqual(anchors, [0, 1, 2, 3, 4, 5], "legitimately repeated words in the script both anchor correctly");
}

console.log(`\n${failures === 0 ? "All tests passed." : `${failures} test(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);

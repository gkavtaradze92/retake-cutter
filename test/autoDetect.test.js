import { buildUtterances, wordOverlapSimilarity, planKeepSegmentsAuto } from '../js/autoDetect.js';

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
function assertClose(actual, expected, label, eps = 0.02) {
  if (Math.abs(actual - expected) > eps) {
    failures++;
    console.error(`✗ ${label}\n  expected: ${expected}\n  actual:   ${actual}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

function tw(list) {
  return list.map(([text, start, end]) => ({ text, start, end }));
}

// --- buildUtterances: splits on gaps > threshold ---
{
  const words = tw([['hi', 0, 0.3], ['there', 0.3, 0.6], ['friend', 2.0, 2.3]]); // 1.4s gap
  const utt = buildUtterances(words, 0.6);
  assertEqual(utt.length, 2, 'buildUtterances splits on a gap bigger than the threshold');
  assertEqual(utt[0].words.map((w) => w.text), ['hi', 'there'], 'first utterance has the right words');
  assertEqual(utt[1].words.map((w) => w.text), ['friend'], 'second utterance has the right words');
}

{
  const words = tw([['hi', 0, 0.3], ['there', 0.4, 0.7], ['friend', 0.8, 1.1]]); // all small gaps
  const utt = buildUtterances(words, 0.6);
  assertEqual(utt.length, 1, 'small gaps stay in a single utterance');
}

// --- wordOverlapSimilarity ---
{
  const a = tw([['the', 0, 0.1], ['quick', 0.1, 0.2], ['brown', 0.2, 0.3]]);
  const b = tw([['the', 1, 1.1], ['quick', 1.1, 1.2], ['brown', 1.2, 1.3], ['fox', 1.3, 1.4]]);
  const sim = wordOverlapSimilarity(a, b);
  // dice = 2*3 / (3+4) = 6/7 ≈ 0.857
  assertClose(sim, 0.857, 'near-identical phrases (one a prefix of the other) score high similarity');
}

{
  const a = tw([['the', 0, 0.1], ['weather', 0.1, 0.2], ['is', 0.2, 0.3], ['nice', 0.3, 0.4]]);
  const b = tw([['i', 1, 1.1], ['like', 1.1, 1.2], ['pizza', 1.2, 1.3]]);
  const sim = wordOverlapSimilarity(a, b);
  assertEqual(sim, 0, 'completely unrelated phrases score zero similarity');
}

{
  const a = tw([['no', 0, 0.1], ['no', 0.1, 0.2]]);
  const b = tw([['no', 1, 1.1]]);
  const sim = wordOverlapSimilarity(a, b);
  // multiset: min(2,1)=1 overlap, dice = 2*1/(2+1) = 0.667 — repeated words counted, not deduped
  assertClose(sim, 0.667, 'repeated words within an utterance are counted as a multiset, not deduped');
}

// --- planKeepSegmentsAuto: clean speech, nothing to cut ---
{
  const words = tw([
    ['hi', 0.0, 0.3], ['there', 0.3, 0.6], ['friend', 0.6, 1.0],
    ['how', 1.3, 1.5], ['are', 1.5, 1.7], ['you', 1.7, 2.0],
  ]);
  const segs = planKeepSegmentsAuto(words, 2.2);
  assertEqual(segs.length, 1, 'clean speech (no repeats, no long pauses) produces one kept segment');
  assertClose(segs[0].start, 0, 'starts near the beginning');
  assertClose(segs[0].end, 2.15, 'ends at the padded end of the clip (last word end + edgePaddingSec)');
}

// --- planKeepSegmentsAuto: a flub + retake gets detected and cut ---
{
  // "one two three" (flub) <pause> "one two three four five" (retake)
  const words = tw([
    ['one', 0.0, 0.15], ['two', 0.15, 0.3], ['three', 0.3, 0.45],
    ['one', 1.2, 1.35], ['two', 1.35, 1.5], ['three', 1.5, 1.65], ['four', 1.65, 1.8], ['five', 1.8, 1.95],
  ]);
  const segs = planKeepSegmentsAuto(words, 2.1);
  assertEqual(segs.length, 1, 'a detected flub+retake collapses to a single kept segment (the retake only)');
  assertClose(segs[0].start, 1.14, 'kept segment starts at the retake, not the flub', 0.05);
  assertClose(segs[0].end, 2.1, 'kept segment runs to the padded end', 0.01);
}

// --- planKeepSegmentsAuto: chain of two retakes keeps only the last ---
{
  const words = tw([
    ['hi', 0.0, 0.2],                                             // flub attempt 1
    ['hi', 1.0, 1.2],                                             // flub attempt 2
    ['hi', 2.0, 2.2], ['there', 2.2, 2.4],                        // final correct version
  ]);
  const segs = planKeepSegmentsAuto(words, 2.6, { similarityThreshold: 0.5 });
  assertEqual(segs.length, 1, 'a chain of repeated flubs collapses to just the final attempt');
  assertClose(segs[0].start, 1.94, 'kept segment starts at the FINAL retake, not an intermediate one', 0.05);
}

// --- planKeepSegmentsAuto: two genuinely different sentences are BOTH kept ---
{
  const words = tw([
    ['the', 0.0, 0.15], ['weather', 0.15, 0.4], ['is', 0.4, 0.5], ['nice', 0.5, 0.7],
    ['i', 1.4, 1.5], ['like', 1.5, 1.7], ['pizza', 1.7, 2.0],
  ]);
  const segs = planKeepSegmentsAuto(words, 2.2);
  assertEqual(segs.length, 1, 'two different sentences with a normal pause stay in one continuous segment');
  assertClose(segs[0].end, 2.15, 'nothing gets cut since content differs and pause is not overlong (end = last word + padding)', 0.01);
}

// --- planKeepSegmentsAuto: long pause between two DIFFERENT utterances still gets trimmed ---
{
  const words = tw([
    ['the', 0.0, 0.15], ['weather', 0.15, 0.4], ['is', 0.4, 0.5], ['nice', 0.5, 0.7],
    ['i', 3.0, 3.1], ['like', 3.1, 3.3], ['pizza', 3.3, 3.6],
  ]);
  const segs = planKeepSegmentsAuto(words, 3.8);
  assertEqual(segs.length, 2, 'an overlong pause between two different (kept) utterances still gets split/trimmed');
}

// --- Known limitation, explicitly tested: a legitimate repeated phrase IS wrongly cut ---
{
  // "really really good" said once, naturally, as three words with normal gaps —
  // but if spoken as two separate utterances ("really" ... pause ... "really good"),
  // this heuristic has no way to distinguish it from a flub+retake.
  const words = tw([
    ['really', 0.0, 0.3],
    ['really', 1.0, 1.3], ['good', 1.3, 1.6],
  ]);
  const segs = planKeepSegmentsAuto(words, 1.8);
  assertEqual(segs.length, 1, 'KNOWN LIMITATION: a legitimately repeated word across utterances is also cut (documented, not a bug)');
  assertClose(segs[0].start, 0.94, 'the first "really" utterance is treated as a flub and cut', 0.05);
}

// --- Empty input falls back to keeping everything ---
{
  const segs = planKeepSegmentsAuto([], 5.0);
  assertEqual(segs, [{ start: 0, end: 5.0 }], 'no transcript words falls back to keeping the whole clip');
}

console.log(`\n${failures === 0 ? 'All tests passed.' : `${failures} test(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);

import { planKeepSegments, totalCutSeconds } from '../js/planCuts.js';

let failures = 0;
function assertClose(actual, expected, label, eps = 0.001) {
  if (Math.abs(actual - expected) > eps) {
    failures++;
    console.error(`✗ ${label}\n  expected: ${expected}\n  actual:   ${actual}`);
  } else {
    console.log(`✓ ${label}`);
  }
}
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

function tw(list) {
  // list of [text, start, end]
  return list.map(([text, start, end]) => ({ text, start, end }));
}

// --- Clean read, no cuts needed ---
{
  const scriptWords = [{ norm: 'hi' }, { norm: 'there' }, { norm: 'friend' }];
  const transcript = tw([['hi', 0.0, 0.3], ['there', 0.3, 0.6], ['friend', 0.6, 1.0]]);
  const anchors = [0, 1, 2];
  const segs = planKeepSegments(scriptWords, transcript, anchors, 1.2);
  // one continuous segment covering (roughly) the whole clip
  assertEqual(segs.length, 1, 'clean read produces a single kept segment');
  assertClose(segs[0].start, 0, 'clean read starts near 0');
  assertClose(segs[0].end, 1.15, 'clean read ends at video end (within trailing padding clamp)');
}

// --- A flub in the MIDDLE of the script (good words both before and after it) ---
{
  // script: "one two three four five" said as "one two three(flub) three(retake) four five"
  const scriptWords = [{ norm: 'one' }, { norm: 'two' }, { norm: 'three' }, { norm: 'four' }, { norm: 'five' }];
  const transcript = tw([
    ['one', 0.0, 0.15],
    ['two', 0.15, 0.3],
    ['three', 0.3, 0.5],   // flubbed first attempt at "three" — junk
    ['three', 0.7, 0.9],   // corrected retake
    ['four', 0.9, 1.05],
    ['five', 1.05, 1.2],
  ]);
  const anchors = [0, 1, 3, 4, 5]; // as align.js would produce after widening
  const segs = planKeepSegments(scriptWords, transcript, anchors, 1.3);
  assertEqual(segs.length, 2, 'a mid-script flub produces two kept segments (good part before/after the cut)');
  // first segment: "one two", ends right after "two" (index 1) plus buffer
  assertClose(segs[0].end, 0.36, 'first kept segment ends right after the last good word before the flub', 0.02);
  // second segment: starts right before the corrected "three" retake (index 3)
  assertClose(segs[1].start, 0.64, 'second kept segment starts right before the corrected retake', 0.02);
  assertClose(segs[1].end, 1.3, 'second kept segment runs to the (padded) end of the clip', 0.01);
}

// --- A flub at the very START of the recording (nothing good before it) ---
{
  // said: "the quick br-" (flub, right from video start) "the quick brown fox" (retake)
  const scriptWords = [{ norm: 'the' }, { norm: 'quick' }, { norm: 'brown' }, { norm: 'fox' }];
  const transcript = tw([
    ['the', 0.0, 0.2],
    ['quick', 0.2, 0.5],
    ['br', 0.5, 0.6],     // junk — flub right at the start
    ['the', 0.9, 1.1],    // retake starts
    ['quick', 1.1, 1.4],
    ['brown', 1.4, 1.7],
    ['fox', 1.7, 2.0],
  ]);
  const anchors = [3, 4, 5, 6]; // as align.js would produce after widening
  const segs = planKeepSegments(scriptWords, transcript, anchors, 2.2);
  // there is nothing good before the flub, so this should be a SINGLE
  // kept segment starting right at the retake — not two segments, and
  // definitely not one that includes the failed "the quick br-" open.
  assertEqual(segs.length, 1, 'a flub with nothing good before it produces only one kept segment');
  assertClose(segs[0].start, 0.84, 'the single kept segment starts right before the corrected retake, not at video start', 0.02);
  assertClose(segs[0].end, 2.15, 'the single kept segment runs to the (padded) end of the clip', 0.01);
}

// --- Overlong pause gets trimmed, not removed ---
{
  const scriptWords = [{ norm: 'hi' }, { norm: 'friend' }];
  const transcript = tw([['hi', 0.0, 0.3], ['friend', 3.0, 3.3]]); // 2.7s silence between
  const anchors = [0, 1];
  const segs = planKeepSegments(scriptWords, transcript, anchors, 3.5, { longPauseThresholdSec: 1.2, keptPauseSec: 0.35 });
  assertEqual(segs.length, 2, 'an overlong pause splits into two segments so it can be shortened');
  const cut = totalCutSeconds(segs, 3.5);
  // original pause 2.7s, kept pause 2*0.35=0.7s worth of padding around the cut -> should remove a couple seconds
  if (cut < 1.5 || cut > 2.5) {
    failures++;
    console.error(`✗ overlong pause trims a couple seconds\n  cut seconds: ${cut}`);
  } else {
    console.log('✓ overlong pause trims a couple seconds');
  }
}

// --- Normal-length pause is left completely alone ---
{
  const scriptWords = [{ norm: 'hi' }, { norm: 'friend' }];
  const transcript = tw([['hi', 0.0, 0.3], ['friend', 0.9, 1.2]]); // 0.6s pause, under threshold
  const anchors = [0, 1];
  const segs = planKeepSegments(scriptWords, transcript, anchors, 1.4);
  assertEqual(segs.length, 1, 'a normal pause does not get split into multiple segments');
}

// --- Nothing matched at all falls back to "keep everything" ---
{
  const segs = planKeepSegments([], [], [], 5.0);
  assertEqual(segs, [{ start: 0, end: 5.0 }], 'no matches falls back to keeping the whole clip untouched');
}

console.log(`\n${failures === 0 ? 'All tests passed.' : `${failures} test(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);

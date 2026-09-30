# Retake Cutter

Upload a shadowing take and paste the script you read from. It transcribes
what you actually said (using Whisper, running entirely in your browser),
matches it against the script, and cuts out retakes and overlong pauses —
automatically. Nothing is uploaded anywhere; the video and script never
leave the browser tab.

## How it works

1. **Read the audio** (`js/audio.js`) — pulls the audio track out of your
   video using the Web Audio API and resamples it to 16kHz mono.
2. **Transcribe** (`js/transcribe.js`) — runs Whisper (`Xenova/whisper-base.en`)
   via [transformers.js](https://github.com/huggingface/transformers.js),
   entirely in-browser, to get word-level timestamps for what you actually
   said.
3. **Align** (`js/align.js`) — matches the script's words against the
   transcript using an LCS-based algorithm, snapping to the *last*
   occurrence of any repeated word so a corrected retake wins over the
   flubbed first attempt. See the comments at the top of the file for the
   exact logic and its known limits.
4. **Plan cuts** (`js/planCuts.js`) — turns the alignment into a list of
   time ranges to keep: junk between two correct anchors gets cut
   entirely, and overlong pauses (default: anything over 1.2s) get
   trimmed down to a short, natural pause rather than removed outright.
5. **Export** (`js/export.js`) — uses [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm)
   to trim and concatenate the kept segments into a final video, in-browser.

## Running it locally

No build step, no server needed for the app itself — it's a static page.

```bash
# from the project folder
python3 -m http.server 8000
# open http://localhost:8000
```

(Opening `index.html` directly via `file://` will NOT work — ES modules
require a real HTTP origin.)

### Running the logic tests

The alignment and cut-planning algorithms (the two riskiest parts) have a
plain Node test suite with no browser dependency:

```bash
npm test
# or directly:
node test/align.test.js
node test/planCuts.test.js
```

## Putting it on GitHub (so you can use it from any computer)

No `git` command line needed — GitHub's web UI can do this entirely by
drag-and-drop:

1. Go to [github.com/new](https://github.com/new), create a new repository
   (e.g. `retake-cutter`). Public or private both work for GitHub Pages,
   though private repos need a paid plan for Pages.
2. On the new repo's page, click **"uploading an existing file"**.
3. Drag the *entire contents* of this folder in (all files and folders —
   `index.html`, `css/`, `js/`, `test/`, `README.md`, etc.) and commit.
4. Go to **Settings → Pages** in the repo.
5. Under "Build and deployment", set **Source** to "Deploy from a branch",
   branch `main`, folder `/ (root)`. Save.
6. After a minute or two, GitHub shows the live URL (something like
   `https://<your-username>.github.io/retake-cutter/`). That's the app,
   usable from any computer, and the code is safely backed up on GitHub
   even if this chat is deleted.

To update it later: repeat step 2–3 (upload the changed files) or install
`git` and push normally once you're comfortable with it.

## First run is slow — that's expected

The first time you click "Process", the browser downloads:
- The Whisper speech model (~150MB)
- The ffmpeg.wasm engine (~30MB)

Both are cached by the browser afterward, so every run after the first is
fast and fully offline.

## Known limitations

- **Word-level matching, not phonetic.** The alignment matches Whisper's
  transcribed words against your script's words as text. If Whisper
  mis-hears a word (accent, background noise, mumbling), that word won't
  align even if you said it correctly — the app tells you via a warning
  when the match rate looks too low, but it can't fully compensate for a
  bad transcription.
- **Assumes retakes repeat words verbatim.** The "snap to the last
  occurrence" trick (see `align.js`) works well for "I said the wrong
  thing and repeated the same line correctly" but won't help if you
  paraphrase instead of repeating verbatim.
- **English-tuned by default.** `transcribe.js` uses `Xenova/whisper-base.en`.
  For other languages, swap the `MODEL_ID` constant to a multilingual
  Whisper model (e.g. `Xenova/whisper-base`) — English-only models are
  generally more accurate for English speech, which is why that's the
  default here.
- **No audio cleanup.** This tool only cuts; it doesn't remove background
  noise, normalize volume, or fix pronunciation. That's a genuinely
  different problem — see the "audio enhancement" tools mentioned when
  this project was first scoped if you need that separately.
- **Whisper accuracy on accented English.** Whisper handles non-native
  English reasonably well but isn't perfect — review the edited video
  before trusting a cut blindly, especially early on.

## Adjusting the cut behavior

`js/planCuts.js` exports a small set of tunable constants
(`longPauseThresholdSec`, `keptPauseSec`, `cutBufferSec`,
`edgePaddingSec`) with comments explaining each — pass an `options`
object into `planKeepSegments(...)` (already wired up for you to extend
in `app.js` if you want a settings UI later).

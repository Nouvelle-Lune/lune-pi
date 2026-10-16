# Preview assets

The previews are native screenshots and a window recording of Pi running all seven monorepo plugins in Ghostty. The model replies use Pi's official offline faux provider. File edits, shell processes, tool rendering, panels, keyboard input, Recap and compaction execute through their normal runtime paths.

## Regenerate

Requires macOS 15 or later, Ghostty in `/Applications`, Swift command-line tools, Python 3, Pi, and macOS screen-recording permission for the launching app. Pi's `fd` helper must be installed; the script includes the existing agent's `bin` directory in its own `PATH`.

From a prepared checkout:

```bash
npm run build
npm run docs:previews
```

The command opens dedicated Ghostty windows, records the full walkthrough as `walkthrough.mp4`, extracts the question interaction as `walkthrough.gif`, and takes PNG screenshots of the workspace and plugin panels. Each of the seven themes gets a fresh Pi process, so its startup palette and terminal background are captured together. The default output also updates the corresponding package README images. `capture.json` records the capture method, terminal geometry, package versions and source entry hashes.

The terminal profile uses Menlo at 12 points and requests 128 columns by 44 rows. The actual dimensions depend on the display and are recorded in the manifest. The script uses temporary agent settings and a sample project; raw PTY output, an asciicast input/output trace and lifecycle events remain under `.scratch/real-demo/` for diagnosis. It does not use the user's credentials or make model API requests.

`tools/real-demo/terminal.py` runs Pi in a PTY attached to the real Ghostty terminal and accepts replayed keyboard input over a local socket. A headless terminal reads that output only to check which panel is open. Screenshots come from macOS `screencapture`; ScreenCaptureKit records the selected Ghostty window, and AVFoundation/ImageIO extract the GIF from that video.

Use a separate output directory while editing a scenario:

```bash
node tools/make-readme-previews.mjs --output .scratch/preview-review
node tools/make-readme-previews.mjs --workspace-only --palette pi-core-aurora --output .scratch/aurora-review
```

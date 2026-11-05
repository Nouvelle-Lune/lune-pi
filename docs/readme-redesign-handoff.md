# Lune for Pi — README Redesign Handoff

Prepared: October 16, 2026

Repository: <https://github.com/Nouvelle-Lune/lune-pi>

Primary deliverable: a redesigned root [`README.md`](../README.md), written in English.

## Assignment

Redesign the repository README as a polished introduction that makes developers want to try Lune. Explain what the project does, show the experience, and give readers a clear way to get started.

Treat this as a complete editorial and visual redesign. You have freedom to change the headline, structure, captions, image selection, and layout. The current README is a source of project facts, not a layout to preserve. Package documentation supplies the detail behind the introduction.

Success means a first-time visitor can quickly answer:

- What is Lune, and how does it relate to Pi?
- What would improve in my daily workflow?
- What does it look like in use?
- Which parts can I choose, and how do I try them?

## Product and audience

**Lune for Pi is a family of seven cooperating Pi extension packages in one npm workspace.** It adds a coordinated terminal experience around reading agent activity, reviewing changes, answering questions, managing background commands, and returning to long sessions.

Pi remains the host coding agent. Lune provides extensions and shared infrastructure. The root npm package is private; the seven workspace packages have their own names and independent versions.

The primary audience is developers who use, or are considering, Pi for terminal-based coding. They care about understanding what the agent is doing, making decisions with enough context, and keeping work manageable across longer sessions. Extension authors are a secondary audience; give them a route to Core and contributing documentation.

The strongest story is the experience of using the family together, supported by the ability to choose individual extensions. Lead with that experience before introducing package boundaries.

## Positioning and tone

The current brand uses a pixel crescent, the Lune name, moonlit colors, and the line **“Light tools. Deeper work.”** These are useful starting points. The README should feel deliberate, calm, and recognizably connected to the actual terminal UI.

Use concise, concrete English. Explain the benefit, then show the behavior that creates it. For example, compact tool cards make a busy transcript easier to scan; option previews make a decision easier to compare; a short recap helps someone return to an interrupted session.

Keep claims proportional to the evidence. Describe observable behavior rather than promising productivity gains, lower costs, better model reasoning, or perfect memory. Avoid generic AI slogans, superlatives, invented metrics, and paragraphs of adjectives.

Keep the introduction focused on the present product. Release history, migration narratives, internal protocol history, and publication-status commentary do not help the opening story. Explain installation requirements where the reader needs to act.

## Product facts to preserve

All package names below are exact. The directory links lead to their current documentation.

| Package                                                     | User-facing role                                                                                                                              | Exact npm name                     |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| [Core Theme](../packages/pi-core-theme/README.md)           | Compact and expandable tool cards, highlighted split/unified diffs, a pixel-moon header, and seven dark/light palettes.                       | `@lune_99/pi-core-theme`           |
| [Ask Question](../packages/pi-ask-question/README.md)       | Asynchronous structured questions with choices, optional Markdown previews, written answers, and a review/submit flow for multiple questions. | `@lune_99/pi-ask-question`         |
| [Shell Inspector](../packages/pi-shell-inspector/README.md) | Background shell jobs, a live output inspector, job controls, and completion results delivered back to the agent.                             | `@lune_99/pi-shell-inspector`      |
| [Dock](../packages/pi-dock/README.md)                       | A keyboard-operated place for cooperating extensions, model information, working directory, and session statistics.                           | `@lune_99/pi-dock`                 |
| [Compaction](../packages/pi-compaction/README.md)           | A choice of summary model and thinking level for Pi compaction, with optional review of tool history before summarization.                    | `@lune_99/pi-compaction`           |
| [Recap](../packages/pi-recap/README.md)                     | A short reminder near the editor covering the goal, progress, blocker, and a supported next step when returning to a session.                 | `@lune_99/pi-recap`                |
| [Core](../packages/pi-lune-extensions-core/README.md)       | Shared settings, settings panels, lifecycle cleanup, and Dock contracts used by extensions.                                                   | `@lune_99/pi-lune-extensions-core` |

Core is generic infrastructure. Feature behavior belongs to the feature packages; Core's role extends across the family and to other extension authors.

### Behavioral details that affect the copy

- **Core Theme starts disabled.** Users enable it through `/lune-core-settings core-theme`. Its palette setting initially inherits the Pi theme. Installing the package alone does not reproduce a screenshot with a selected Lune palette.
- **Seven palettes exist:** Dark, Light, Aurora, Eclipse, Nebula, Dawn, and Mist. Their file identifiers use the `pi-core-` prefix.
- **Ask Question is asynchronous.** The agent may continue work that does not depend on the answer. Closing the panel with `Esc` leaves the request pending; `/question` reopens it. Optional previews are display context, separate from the submitted answer.
- **Background shells have a lifecycle.** Completion, failure, and cancellation return results to the agent. Jobs belong to the Pi session, and running jobs stop when that owning session shuts down. Ordinary foreground commands retain Pi's foreground behavior.
- **Dock starts enabled with the `ruled` style.** Its five styles are `ruled`, `boxed`, `compact`, `minimal`, and `classic`. Ask Question and Shell Inspector also have independent status rows when the Dock host is inactive.
- **Compaction starts enabled; tool-history review starts disabled.** `/compact` remains the entry point. Review changes the input sent for summarization while leaving the on-disk tool transcript intact.
- **Automatic Recap starts disabled.** `/recap` works on demand after work and pending prompts settle. Automatic mode depends on terminal focus reports. Recap generation is a separate model request and can incur provider charges.
- **Core's SDK and command entry have different roles.** Importing the SDK as a dependency does not itself register `/lune-core-settings`. Keep the loading instructions accurate for the installation route you present.

Keep necessary activation details close to installation. Put deeper controls and settings in package documentation rather than expanding the opening into an operations manual.

## Editorial and visual direction

Build a clear progression from interest to proof to action. The following is a suggested reading order, not a required set of section titles:

1. **A memorable opening:** the project name, a specific promise, a short explanation of its relationship to Pi, and a strong workspace image.
2. **A quick look at the interaction:** a focused GIF or a prominent recording link, with a caption explaining what to watch.
3. **A few concrete reasons to care:** readable tool activity and diffs; decisions with previews; commands that stay accessible; continuity through compaction and recaps. Pair each with visual evidence where useful.
4. **A clear way to try it:** concise commands, essential activation instructions, and a route to individual packages.
5. **A package map:** enough detail to understand the seven components, with links for deeper reading.
6. **Supporting material:** a compact palette gallery, development links, and the MIT license.

Choose image placement by what it explains. A full terminal screenshot can establish the overall experience; a close crop can explain one interaction. Preserve enough context to make the behavior understandable. Avoid repeating large screenshots that communicate the same point.

Design for GitHub Markdown and its supported HTML. Use headings, whitespace, captions, tables, `<picture>`, and `<details>` intentionally. Keep key value statements and the first useful action visible without opening a collapsed section. Check both light and dark appearance and readability in a narrow browser window.

The complete result should work without watching the video. Include useful alt text and a static image for any interaction whose motion is essential to the presentation.

## Available assets

The main asset directory is [`docs/previews/`](previews/). It currently contains **26 PNG screenshots, one GIF, one MP4, a capture manifest, and regeneration instructions**.

The filenames below are relative to that directory. They are an inventory, not a requirement to use every image.

| Story or use            | Files                                                                                                                                                        | What they show                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Workspace hero          | [`workspace-dark.png`](previews/workspace-dark.png), [`workspace-light.png`](previews/workspace-light.png)                                                   | The Lune header, transcript, code change, editor, and session Dock in context.                                                             |
| Motion                  | [`walkthrough.gif`](previews/walkthrough.gif), [`walkthrough.mp4`](previews/walkthrough.mp4)                                                                 | A short question interaction and the complete recorded walkthrough.                                                                        |
| Tool activity and diffs | [`tools-expanded.png`](previews/tools-expanded.png)                                                                                                          | Expanded tool content and the change being reviewed.                                                                                       |
| Structured decisions    | [`ask-question.png`](previews/ask-question.png), `ask-question-alternative.png`, `ask-question-next.png`, `ask-question-submit.png`, `question-answered.png` | Options, changing previews, question tabs, submission, and the transcript result.                                                          |
| Background work         | [`shell-inspector.png`](previews/shell-inspector.png), `shell-inspector-next.png`, `shell-inspector-scroll.png`                                              | Job selection, status, output, and scrolling.                                                                                              |
| Dock                    | [`dock-focus.png`](previews/dock-focus.png), [`dock-styles.png`](previews/dock-styles.png)                                                                   | Dock interaction and its settings panel. The current `dock-styles.png` is a settings capture, not a comparison montage of all five styles. |
| Compaction              | [`compaction.png`](previews/compaction.png), [`compaction-result.png`](previews/compaction-result.png)                                                       | Compaction settings and the recorded result.                                                                                               |
| Recap                   | [`recap.png`](previews/recap.png), [`recap-settings.png`](previews/recap-settings.png)                                                                       | The reminder near the editor and Recap settings.                                                                                           |
| Header and settings     | [`startup.png`](previews/startup.png), [`theme-settings.png`](previews/theme-settings.png)                                                                   | Startup appearance and the Theme settings panel.                                                                                           |
| Palette gallery         | `pi-core-dark.png`, `pi-core-light.png`, `pi-core-aurora.png`, `pi-core-eclipse.png`, `pi-core-nebula.png`, `pi-core-dawn.png`, `pi-core-mist.png`           | A separate Pi startup for each palette.                                                                                                    |

### Provenance and older assets

The current root previews are native captures of Pi running in Ghostty. The demo uses scripted offline model replies; Pi's agent loop, file edits, shell processes, plugin rendering, panels, and keyboard interactions run through their normal runtime paths. The GIF is extracted from the recorded video. Use a short, accurate provenance note if relevant; keep capture implementation details in the asset guide.

[`capture.json`](previews/capture.json) records the capture method, package versions, entry hashes, and terminal geometry. The current recorded geometry is 131 columns by 45 rows, using Menlo at 12 points.

Older SVG-based documentation assets remain alongside package images:

- [Core Theme assets](../packages/pi-core-theme/docs/) and [palette captures](../packages/pi-core-theme/docs/palettes/).
- [Ask Question assets](../packages/pi-ask-question/docs/).
- [Dock assets](../packages/pi-dock/docs/).
- [Compaction assets](../packages/pi-compaction/docs/).
- [Recap assets](../packages/pi-recap/docs/).
- [Shell Inspector package image](../packages/pi-shell-inspector/assets/preview.png).

Some package PNGs have since been replaced by native captures. A same-named SVG and PNG may therefore represent different capture generations. Inspect a file before choosing or editing it. Prefer the native captures when demonstrating the current overall experience.

Local raw PTY output, asciicast traces, lifecycle events, and intermediate attempts are under `.scratch/real-demo/`. Those working files may be absent from a fresh clone; use tracked assets and scripts for a reproducible handoff.

### Regenerating or extending the visuals

Read the [preview asset guide](previews/README.md) first. The repository-level `capture-readme-previews` skill owns the entry point, supporting capture code, and scenarios. Its `.pi/` location is intentionally gitignored; use the locally available skill when regenerating assets.

For the standard capture, run from the repository root:

```bash
npm run build
node .pi/skills/capture-readme-previews/scripts/capture-readme-previews.mjs \
  --output .scratch/readme-redesign-preview
```

Capture requires macOS 15 or later, Ghostty, Swift command-line tools, Python 3, Pi, its `fd` helper, and screen-recording permission for the launching app. These are asset-generation requirements, not established end-user requirements for the extension family.

The explicit `docs/previews` output also updates selected package README images through the mapping bundled with the skill. While exploring a scenario or framing, keep a separate staging directory:

```bash
node .pi/skills/capture-readme-previews/scripts/capture-readme-previews.mjs \
  --suite repository --output .scratch/readme-redesign-repository
```

Package-level `docs:images` commands generate SVG/PNG documentation assets with `rsvg-convert`. Treat these as a separate workflow from native screenshots and inspect their output before replacing current images.

If new captures are needed, record actual supported behavior. Crop, resize, and annotate carefully while keeping the displayed state truthful. Keep new reusable assets in a tracked location and document how they were produced.

## Installation and factual verification

The root README currently documents a full-suite source-checkout route:

```bash
git clone https://github.com/Nouvelle-Lune/lune-pi.git
cd lune-pi
npm ci
npm run build

pi install ./packages/pi-lune-extensions-core
pi install ./packages/pi-core-theme
pi install ./packages/pi-dock
pi install ./packages/pi-ask-question
pi install ./packages/pi-shell-inspector
pi install ./packages/pi-compaction
pi install ./packages/pi-recap
pi
```

The workspace declares Node.js `>=22.19.0` and `npm@11.6.2`. Pi must be available. The checkout remains in place because Pi loads these local package paths. Theme activation and palette selection must follow the commands if this route is used to reproduce the visuals.

Package READMEs also contain individual npm installation commands. Before making registry installation the main call to action, verify current package availability and the complete loading/activation path in a clean Pi configuration. This handoff checked repository files and assets; it does not establish current npm publication state or a fresh end-to-end installation result.

Use these sources when resolving details:

| Question                                     | Owning source                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------- |
| Workspace names, requirements, and commands  | [Root package manifest](../package.json)                                        |
| Package behavior and user controls           | The seven package READMEs linked above, then their owning source files          |
| Theme defaults                               | [Theme settings](../packages/pi-core-theme/src/settings.ts)                     |
| Dock defaults and styles                     | [Dock settings](../packages/pi-dock/src/dock-settings.ts)                       |
| Compaction defaults                          | [Compaction schema](../packages/pi-compaction/src/settings/schema.ts)           |
| Recap defaults                               | [Recap settings](../packages/pi-recap/src/settings.ts)                          |
| Architecture and development conventions     | [CONTRIBUTING.md](../CONTRIBUTING.md) and [AGENTS.md](../AGENTS.md)             |
| Capture provenance and package image updates | [Capture manifest](previews/capture.json) and [asset guide](previews/README.md) |

Recheck facts against the checkout being delivered. If sources conflict or a proposed claim depends on unclear behavior, ask the maintainer before changing that claim or the implementation.

## Delivery and acceptance

Deliver the complete redesigned English root README with any assets needed for its final presentation. Include a short change note identifying the editorial direction, asset changes, and checks performed. Update asset-generation instructions if the capture workflow changes. Preserve the existing package names and public behavior; package READMEs can remain the detailed reference destinations.

Before handing back the result, confirm:

- The opening identifies Lune, its relationship to Pi, and the value of trying it.
- The page presents a coherent product experience and gives every package an accurate place in the package map.
- Screenshots support their adjacent claims, and captions match the actual captured state.
- Images remain useful at normal GitHub reading width, with light/dark appearance and narrow layouts inspected.
- Relative links, anchors, images, and the recording link resolve; important images have descriptive alt text.
- The selected installation path has been checked, and necessary activation steps are visible.
- No publication status, performance result, adoption figure, or capability has been invented.
- Documentation changes pass `git diff --check`. If package code or shared tooling changes, follow the owning instructions and run the applicable validation, including `npm run check` for workspace-wide changes.

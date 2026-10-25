[Back to the README](../README.md)

# Pi Lune Core Theme

Opt-in Lune appearance for Pi: the ice-blue pixel-moon header, seven moonlit palettes, Lune
tool cards and call trees, rich edit/write diffs, Markdown enhancements and a `/context`
inspector. It is an independent extension built on
`@lune_99/pi-lune-extensions-core`'s Settings and Panel infrastructure, so Core and its
other consumers never install appearance code they do not use.

## Install

```sh
pi install npm:@lune_99/pi-core-theme
```

## Enable the theme

`Core theme` defaults to **off**, so installing the package changes nothing until you
turn it on. Open `/lune-core-settings core-theme` (the **Theme** tab) and enable its
first field to use the Lune pixel-moon header, theme/Pi versions and shortcuts, compact
tool cards, rich edit/write diffs, Markdown enhancements and fullscreen interactions.
Changes apply immediately; turning it off restores Pi's native header, tool renderers
and preceding color palette. The switch uses the usual global/project scopes
(`pi-core-theme.enabled`) and controls every appearance change below. The header uses
Pi's native Theme styling and configured keybindings; expanding tool output also expands
startup help. Its brand pixels keep their ice-blue palette unless a Lune palette tints them.

## Appearance options

The same **Theme** tab configures:

- **Style:** `on` for individual cards and groups, `compact` for collapsed tool rounds,
  or `off` for native Pi tools; tool exclusions and width-aware summaries.
- **Diff:** automatic/split/unified layouts, inline changes, syntax highlighting,
  indicators, wrapping and collapsed edit/write preview limits.
- **UI:** bounded input/output previews, compact call trees and fullscreen mouse
  interactions. Every collapsed card, group and thinking block is one heading row
  ending in a dim `click to show more` hint; results summarize there (`40 lines`,
  `+2 -1`). Groups and codemode show the call total with any running, failed or
  cancelled counts, with up to five call summaries underneath. While tools are
  running, this window follows the latest calls so each new invocation becomes
  visible. A clickable `… N more calls` row opens the complete list. Clicking the content of any expanded tool, group or thinking panel
  closes it. A hidden-output tail row opens a separate full-output browser with wheel,
  page scrolling and text wrapped to the pane width; Escape closes the browser. Scrolling, copy and close
  shortcuts share a plain bottom footer, separated from output as in Shell inspector.
  Archived native bash and codemode output is read from its complete output file.
  Commands use concise argument summaries, with status and duration directly beside
  the command. Headings and tree rows share one mark: a moon phase that turns while
  running, `●` for done (success color) or failed (error color, also labelled) and
  `○` for cancelled; composite headings give failures priority. Tool names stay
  unchanged. Expanded cards list arguments as aligned key/value rows. Codemode shows its script only when expanded;
  collapsed, it adds one row per nested call as calls arrive. It merges live call events
  with partial results and keeps nested edit/write calls as summaries. Nested tool
  progress updates repaint immediately; expanded call ledgers show bounded child
  output previews and link hidden lines to the full-output browser. Expanded cards and
  groups follow the latest lines of partial output; collapsed ones add no output rows, a failed
  collapsed card shows its error on the heading, and their call lists keep the newest calls, so finishing a call does not move the transcript. Thinking's run assembly,
  plain-text preview and latest summary-stage selection work as follows:
  streaming text takes precedence over stale OpenAI signatures, while completed
  signatures select the final compact summary. Collapsed thinking follows the latest
  text, and expanded thinking retains every stage and updates live. Empty thinking
  has no expansion hint and reserves its row before the first token arrives. Its star
  and color animation runs on a separate 30fps clock; tool activity retains a 300ms minimum.
  A mouse-expanded card stays open while the agent keeps working and when Pi rebuilds the
  transcript; it closes when clicked or when another card is opened, and panels opened with
  Pi's expand toggle stay open. Dragging and jump-to-latest navigation remain native Pi behavior.
  Input/output and expanded diff rendering use their configured line budgets. Standalone
  edit/write results use rich diffs; unchanged overwrite context is folded, and large
  replacements retain a bounded diff preview. Completed cards and groups reuse cached
  layouts, and thinking animation reuses its text layout between token updates.

The following are enabled automatically with Core theme and have no separate settings:

- **Markdown:** additional Mermaid dialect fences, GitHub admonitions, clickable bare
  URLs and terminal-safe numbering. Code and existing links keep their text.
- **Links:** when Pi detects OSC 8 link support (for example in Ghostty, iTerm2,
  WezTerm or Kitty, or with `PI_HYPERLINKS=1`), explicit references to existing files
  and directories become `file://` links: Markdown links to local paths, inline code
  naming one path such as `src/index.ts:12` or `README.md`, and path-tool headings.
  Relative paths resolve from Pi's working directory; explicit references outside it,
  such as temporary reports or home-directory configuration files, also work. A `:line`
  or `#anchor` suffix stays in the text, but the link opens the file itself.
  Bare paths in prose and tool output stay plain text, including logs, search results,
  directory listings, source code and diff bodies. They are not scanned for existing
  files. URLs in messages and tool output remain clickable, and existing full-output
  browser actions are unchanged. Missing paths do not gain `file://` links; existing
  Markdown link syntax is left for Pi to render, including unresolved targets. Remote
  URI and UNC-style network paths are not reinterpreted as local references. In fullscreen
  mode, Pi opens a link on a plain click.
  Links have no underline. In fullscreen mode with mouse tracking on, the link under the
  pointer is underlined, including the rows of a link that wraps, but not other links with the same target. In other modes, the terminal shows its own hover, for example
  while Cmd is held in Ghostty.
- **Context:** `/context` shows Pi context usage separately from estimated category
  sizes, with browsable System prompt, Memory, Skills, Tool definitions, Tool results
  and Messages categories. A persistent usage meter, category token counts and an
  overview chart use the active theme's colors and update when the palette changes.
  The centered panel is capped at 100 columns and 24 rows and adapts to smaller terminals.
  Header usage, percentage and available capacity come directly from Pi, matching Dock.
  The colored bar spans the full context window, with remaining capacity calculated
  from the category estimates. Category values use Pi's token estimator over its
  current projected messages, merged system prompt and complete tool declarations.
  Unknown Pi usage stays unknown, including after compaction before a new reply.
  Up/Down, a category click or the left-pane wheel switches
  categories, as in Shell Inspector. The right-pane wheel, Shift+Up/Down, Page Up/Down
  and Home/End scroll the selected content, which wraps to the pane width without
  preview truncation. `c` copies the complete category and Escape closes the browser.

Appearance options use the `pi-core-theme` Settings namespace with the usual
project/global precedence, stored in `<agentDir>/lune-settings/pi-core-theme.json`
(`~/.pi/agent` by default, or `PI_CODING_AGENT_DIR`) and
`<project>/.pi/lune-settings/pi-core-theme.json`. Project values apply only in trusted
projects. Pi draws its startup header
before the project is known, so the header's on/off switch (`enabled` and `showStartupHeader`)
is read from global settings; a project override takes effect for the rest of the theme but not
for that first header.
The **Core theme** switch remains the default-off master activation control.
If you previously saved Markdown/context overrides, remove `markdownEnabled`,
`mermaid`, `admonitions`, `linkifyUrls`, `normalizeTypography` and
`enableContextCommand` from the `pi-core-theme` namespace; these options no
longer exist.

Choose a palette under **Style · Color palette**, or select its theme name through Pi's
native theme selector:

| Label             | Theme name        | Appearance |
| ----------------- | ----------------- | ---------- |
| Lune Core Dark    | `pi-core-dark`    | dark       |
| Lune Core Light   | `pi-core-light`   | light      |
| Lune Core Aurora  | `pi-core-aurora`  | dark       |
| Lune Core Eclipse | `pi-core-eclipse` | dark       |
| Lune Core Nebula  | `pi-core-nebula`  | dark       |
| Lune Core Dawn    | `pi-core-dawn`    | light      |
| Lune Core Mist    | `pi-core-mist`    | light      |

Each palette is built around its own five-step crescent gradient, which also tints the
header moon and thinking levels, and keeps separate success, error and warning tones.
**Inherit Pi theme** keeps the current palette without changing it.

Pi themes only color text and cards; everything else shows the terminal's default
background, so a light palette on a dark terminal profile would read as dark text on
black. While the theme applies a Lune palette, **Style · Palette background**
(`paletteBackground`, on by default) sets the terminal's default background and text
colors to the palette's (OSC 11/10) and restores the profile's colors (OSC 111/110)
when the palette changes to **Inherit**, the theme turns off or Pi exits. Terminals
without OSC 11 support keep their own colors, and a palette chosen through Pi's native
theme selector does not paint the background.

Standard `mermaid` fences follow Pi's **Mermaid diagrams** setting; choose **final**
there for stable streamed replies. Additional dialect fences such as
`sequencediagram`, `classdiagram` and `statediagram-v2` always render after the reply
finishes.
Write diffs capture a bounded UTF-8 preimage through Pi's native write operations;
external write tools keep their ownership, and older results without preimages keep
normal output instead of displaying fabricated diffs.

## Themed custom messages

Pi's tool-renderer chain does not reach custom messages, so the theme publishes a
renderer for them. While the theme renders tools,
`globalThis[Symbol.for("@lune_99/pi-core-theme/renderer/v1")]` holds
`{ version: 1, renderActivity(activity, { expanded, key? }, theme) }`; it is removed when the
theme turns off or the session ends. `renderActivity` draws a Lune call tree: a heading
with attention counts, one tool-style row per entry, and each entry's error and output
underneath, keeping the last lines until Pi's expand toggle opens it. Passing a stable
`key` in the options (for example the message's own data) makes the card clickable like a
tool card: the heading's `click to show more` and any hidden-output row open it, a click on
an open card closes it (its output is capped like a tool card's, with a row that opens the
full-output browser), and Pi rebuilding the component keeps the state. When an entry's
`output` is only a retained tail, `fullOutputPath` names the complete log for that browser.
Consumers look the
value up on every render, keep their own renderer for when it is absent, and declare the
types locally so the theme stays optional. The contract lives in `src/protocol.ts`.

## Development

```sh
npm install
npm run typecheck
COLORTERM=truecolor npm test
npm run dev
```

`npm run dev` loads only the installed Core dependency's Pi entry and the theme,
keeping the shared settings command available. Thinking color
assertions expect a truecolor terminal. Format changed TypeScript with
`bash .scripts/format-ts.sh`.

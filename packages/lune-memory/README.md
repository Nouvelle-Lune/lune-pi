# Lune Memory

[![npm version](https://img.shields.io/npm/v/@lune_99/lune-memory.svg)](https://www.npmjs.com/package/@lune_99/lune-memory) [![npm downloads](https://img.shields.io/npm/dw/@lune_99/lune-memory.svg)](https://www.npmjs.com/package/@lune_99/lune-memory) [![license](https://img.shields.io/npm/l/@lune_99/lune-memory.svg)](LICENSE)

**One project memory for [Pi](https://pi.dev), Claude Code and Codex, kept current by background
Dreaming.**

Lune Memory reads the session files of your coding agents and keeps one memory for each project.
A local daemon imports new sessions and indexes every event. When a session is
idle, a Dreaming pass reads what changed and updates the project wiki, the working state of each
branch and your preferences. Each new session starts with a short summary of that memory, and the
agent can search all earlier sessions through MCP.

## Quick start

Requires Node.js **22.19.0 or newer** and an API key for a model that
[pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) supports, or for an endpoint of your
own that speaks the OpenAI or Anthropic protocol.

```bash
npm install -g @lune_99/lune-memory
lune-memory setup claude --install-hook
lune-memory setup codex --install-hook
lune-memory setup pi
lune-memory settings
```

npm installs pi-ai with the package. Each `setup` command turns on import for one harness and prints the command that adds the MCP
server, for example `claude mcp add --scope user lune-memory -- …`. Run that command once. For Pi,
run the printed `pi install` command instead; the Pi extension gives the same tools and the session
summary.

`lune-memory settings` opens the settings page in your browser. Select the Dreaming model and add
its API key there. Without a model, import and search work, but no Dreaming pass runs.

## What it does

- **Share memory across harnesses.** Sessions from Pi, Claude Code and Codex in the same
  repository go to one project. Clones with the same remote and Git worktrees share it too.
- **Start each session with context.** A summary of at most 200 lines (L1) goes into each new
  session: your preferences, the project overview, the working state of the current branch and
  the recent sessions that Dreaming has not processed yet.
- **Search every earlier session.** `transcript_search` finds events in all imported sessions
  with full-text search, with filters for project, harness, session and time.
- **Keep notes during the work.** The agent writes notes, decisions and lessons with `note_write`.
  The next Dreaming pass reviews them against the session evidence.
- **Dream in the background.** After a session is idle for 6 hours, an Analyzer reads its new
  events and an Organizer updates the project memory. Every change cites its evidence and every
  pass can be reverted.
- **Know what is stored.** Import and note writes keep the text as it is, with no redaction for
  now. Keys and tokens in a session reach the database, the Markdown views and the Dreaming
  model. A setting that turns redaction on is planned.
- **Stay local.** The daemon listens on loopback only, with a random token. All data stays in
  `~/.lune-memory`.

## Memory layers

| Layer | Content                                                    | How the agent gets it                      |
| ----- | ---------------------------------------------------------- | ------------------------------------------ |
| L1    | Preferences, project overview, working state, open threads | Injected at session start                  |
| L2    | Project wiki: an index and topic pages                     | Linked from L1; Markdown files in `views/` |
| L3    | Notes, decisions, lessons, facts and open items            | `note_write`, Markdown files in `views/`   |
| L4    | Transcripts of every imported session                      | `transcript_search`, Markdown in `views/`  |

The SQLite database is the source of truth. The `views` folder is a read-only Markdown projection
that each change rebuilds. Earlier generations stay for restore.

## Dreaming

A pass has three steps:

1. **Eligibility.** Sessions with unprocessed events that were idle for `idleHours` take part, up
   to `maxSessionsPerPass`. On the first run, sessions older than `historyDays` go to L4 only.
2. **Analyzer.** One model call for each session extracts decisions, lessons, preferences, the
   working state and open items, each with the events that support it.
3. **Organizer and global pass.** One model call for each project merges the results into the
   project items and the wiki. A last call keeps the global preferences that apply in every
   project.

The daemon scans every 10 minutes. `lune-memory dream` starts a pass at once, and `--force`
ignores the idle time. `lune-memory runs` lists passes and `lune-memory revert <run>` undoes one.

## MCP tools

| Tool                | Purpose                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| `transcript_search` | Search earlier sessions of this project or of all projects              |
| `note_write`        | Save a note, decision, lesson, fact, open item, reference or preference |
| `note_update`       | Change a note that this session wrote                                   |
| `note_retract`      | Withdraw a note that this session wrote                                 |
| `memory_location`   | Show the project of a folder and where its Markdown views are           |

`lune-memory mcp` runs the MCP server over stdio. In Pi the extension registers the same tools and
fills in the session and folder.

## Settings page

`lune-memory settings` starts the daemon if necessary and opens a local page. On the page you can:

- turn import on or off for each harness and change its session folder
- select the Dreaming model, its thinking level and the pass limits; a picker with search and one
  list of models for each provider replaces a long drop-down
- add or remove provider API keys (the page never shows a stored key)
- add your own provider that speaks the OpenAI Chat Completions, OpenAI Responses or Anthropic
  Messages protocol, and let lune-memory list its models
- start a pass, read the run history and revert a run
- rename, merge, split and register projects

The same settings are in `~/.lune-memory/config.json` and in `lune-memory config get|set`.

See the [reference](docs/reference.md) for every config key, CLI command, MCP argument, API route
and storage path.

## Development

From the repository root:

```bash
npm ci
npm run build
npm test --workspace=@lune_99/lune-memory
npm run typecheck --workspace=@lune_99/lune-memory
npm run check
```

Set `LUNE_MEMORY_HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` to temporary folders to try the CLI
without your real sessions.

## License

MIT

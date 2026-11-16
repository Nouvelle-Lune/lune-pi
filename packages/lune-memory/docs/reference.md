# Lune Memory reference

[Back to the README](../README.md)

## Storage

All data is in one folder. `LUNE_MEMORY_HOME` sets it; the default is `~/.lune-memory`. Every
command accepts `--home <dir>` too.

| Path                                      | Content                                                              |
| ----------------------------------------- | -------------------------------------------------------------------- |
| `memory.db`                               | SQLite database in WAL mode, the source of truth                     |
| `config.json`                             | Settings, mode 0600                                                  |
| `credentials.json`                        | Provider API keys, mode 0600                                         |
| `daemon.json`                             | Address, token and process id of the running daemon, mode 0600       |
| `daemon.lock`                             | Lock that keeps one daemon for each memory folder                    |
| `logs/daemon.log`                         | Daemon log, rotated at 5 MB                                          |
| `transcripts/<project>/<harness>/<id>.md` | Redacted transcript of each session; `_unassigned` outside a project |
| `views`                                   | Symlink to the current Markdown generation                           |
| `.generations/`                           | Markdown generations; `generations` of them stay                     |
| `projection.lock`                         | Lock that lets one process write a generation at a time              |

A Markdown generation has this layout:

```text
views/
  README.md                         What the views contain
  projects/<project>/index.md       Project index and working state
  projects/<project>/wiki/          Topic pages of the project wiki (L2)
  projects/<project>/notes/         Notes, decisions and lessons (L3)
  projects/<project>/transcripts/   Links to the session transcripts (L4)
  global/index.md                   Global preferences
  global/notes/                     Global notes
```

The views are read-only. Each change to the database writes a new generation and moves the
`views` link. `lune-memory regenerate` writes one from the database at any time.

## Configuration

`config.json` holds the settings. The settings page, `lune-memory config set` and `PUT
/api/config` change it. An invalid value falls back to its default.

| Key                           | Default                | Meaning                                                                       |
| ----------------------------- | ---------------------- | ----------------------------------------------------------------------------- |
| `harnesses.pi.enabled`        | `false`                | Import Pi sessions                                                            |
| `harnesses.pi.root`           | `~/.pi/agent/sessions` | Folder with Pi session files                                                  |
| `harnesses.claude.enabled`    | `false`                | Import Claude Code sessions                                                   |
| `harnesses.claude.root`       | `~/.claude/projects`   | Folder with Claude Code sessions; follows `CLAUDE_CONFIG_DIR`                 |
| `harnesses.codex.enabled`     | `false`                | Import Codex sessions                                                         |
| `harnesses.codex.root`        | `~/.codex/sessions`    | Folder with Codex sessions; follows `CODEX_HOME`                              |
| `importSeconds`               | `60`                   | Seconds between imports in the daemon, at least 5                             |
| `autoStart`                   | `true`                 | Start the daemon when a hook, the MCP server or Pi needs it                   |
| `retentionDays`               | `0`                    | Days to keep imported sessions; 0 keeps everything                            |
| `generations`                 | `3`                    | Markdown generations to keep, 1 to 20                                         |
| `dreaming.enabled`            | `true`                 | Run scheduled passes; a manual pass runs in any case                          |
| `dreaming.model`              | `null`                 | Model as `provider/id`; no model means no pass                                |
| `dreaming.thinking`           | `low`                  | Thinking level of the model calls                                             |
| `dreaming.idleHours`          | `6`                    | Idle time after the last change before a session takes part                   |
| `dreaming.maxSessionsPerPass` | `8`                    | Sessions in one pass, 1 to 100                                                |
| `dreaming.maxCharsPerSession` | `80000`                | Event characters of one session in one pass, at least 1000                    |
| `dreaming.maxAttempts`        | `3`                    | Failed passes for one session revision before it waits for a change, 1 to 100 |
| `dreaming.concurrency`        | `3`                    | Analyzer calls at the same time, 1 to 16                                      |
| `dreaming.scanMinutes`        | `10`                   | Minutes between scheduled scans, at least 1                                   |
| `dreaming.historyDays`        | `30`                   | On the first run, older sessions go to L4 only                                |
| `dreaming.maxRetries`         | `2`                    | Provider retries for one model call, 0 to 10                                  |

A `~` at the start of a harness root expands to the home folder. A change to `importSeconds` or
`scanMinutes` resets the daemon timers at once.

### Models and keys

Dreaming calls models through [pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai). The
model is a pi-ai provider and model id, for example `anthropic/claude-sonnet-4-5`. The settings
page lists the providers and models that pi-ai knows.

A key in `credentials.json` has priority over the environment variable of the provider, for example
`ANTHROPIC_API_KEY`. `lune-memory credential list` and `GET /api/credentials` show only the
provider and the key type, never the key.

## Command line

```text
lune-memory <command> [options]
```

| Command                                                                                                                                      | Purpose                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `setup`                                                                                                                                      | Show the state of each harness                                          |
| `setup <harness> [--root dir] [--disable]`                                                                                                   | Turn import of one harness on or off and print the next steps           |
| `setup <claude\|codex> --install-hook`                                                                                                       | Add the SessionStart hook; not for `pi`                                 |
| `setup <claude\|codex> --remove-hook`                                                                                                        | Remove the SessionStart hook; not for `pi`                              |
| `settings [--print]`                                                                                                                         | Open the settings page; `--print` only prints the address               |
| `l1 [--harness h] [--session id] [--cwd dir]`                                                                                                | Print the session summary for a folder                                  |
| `search <query...> [--project id \| --all] [--harness h] [--session id] [--since time] [--until time] [--limit n] [--context n] [--cwd dir]` | Search transcripts                                                      |
| `location [--cwd dir]`                                                                                                                       | Print the project of a folder and its view paths                        |
| `import [harness...]`                                                                                                                        | Import new sessions now                                                 |
| `dream [--force] [--project id] [harness:id...]`                                                                                             | Run a Dreaming pass now                                                 |
| `status`                                                                                                                                     | Show the daemon, the import and the Dreaming state                      |
| `runs [--limit n]`                                                                                                                           | List the latest passes                                                  |
| `sessions [--limit n] [--project id\|_unassigned]`                                                                                           | List imported sessions                                                  |
| `revert <run> [--reprocess]`                                                                                                                 | Undo a pass; `--reprocess` marks its sessions unprocessed               |
| `forget <harness> <id>`, `forget <harness:id>`                                                                                               | Delete a session and the memory that only it supports                   |
| `regenerate`                                                                                                                                 | Write a new Markdown generation                                         |
| `projects [--merged]`                                                                                                                        | List projects; `--merged` includes merged ones                          |
| `register <path> [--name name]`                                                                                                              | Make a folder outside Git a project                                     |
| `rename <project> <name...>`                                                                                                                 | Rename a project                                                        |
| `merge <source> <target>`                                                                                                                    | Move one project into another                                           |
| `split <git_common_dir\|remote\|path> <value> [--name name]`                                                                                 | Move one locator and its sessions to a project of its own               |
| `config get [key.path]`                                                                                                                      | Print the configuration or one value                                    |
| `config set <key.path> <value>`                                                                                                              | Change one value; the value is JSON or text                             |
| `credential list`                                                                                                                            | List the stored keys without their values                               |
| `credential set <provider>`                                                                                                                  | Store a key that you give on stdin                                      |
| `credential remove <provider>`                                                                                                               | Remove a stored key                                                     |
| `daemon [run\|start\|stop\|status]`                                                                                                          | Run the daemon in front, start it in the background, stop it or show it |
| `mcp [--harness h] [--session id] [--cwd dir]`                                                                                               | Run the MCP server over stdio                                           |
| `hook --harness <claude\|codex>`                                                                                                             | SessionStart hook; reads the hook input on stdin                        |

`--home <dir>` selects the memory folder. `--json` prints JSON. `--help` and `--version` work with
every command. The CLI calls the daemon
when it runs and opens the database itself when it does not.

| Exit code | Meaning                 |
| --------- | ----------------------- |
| 0         | Success                 |
| 1         | Runtime error           |
| 2         | Wrong command or option |

## MCP tools

`lune-memory mcp` serves these tools over stdio. The server fills in `session_id` and `cwd` from
its options when the agent leaves them out. In Pi the extension fills them in from the session.

### `transcript_search`

Search earlier sessions. The result lists matching events with an excerpt and the events around
each match.

| Argument       | Type    | Default                 | Meaning                                                                           |
| -------------- | ------- | ----------------------- | --------------------------------------------------------------------------------- |
| `query`        | string  | required                | Words to find; all words must match, and double quotes mark an exact phrase       |
| `project`      | string  | project of `cwd`        | Project id to search; when `cwd` is in no project, the search covers all sessions |
| `all_projects` | boolean | `false`                 | Search every project and the sessions outside projects                            |
| `harness`      | string  |                         | `pi`, `claude` or `codex`                                                         |
| `session`      | string  |                         | One session id                                                                    |
| `since`        | string  |                         | ISO time; events at or after it                                                   |
| `until`        | string  |                         | ISO time; events before it                                                        |
| `limit`        | integer | `10`                    | Results, 1 to 50                                                                  |
| `context`      | integer | `1`                     | Events before and after a match, 0 to 5                                           |
| `cwd`          | string  | the folder of the agent | Folder that selects the project                                                   |

### `note_write`

Save a note. A `cwd` in a project gives a note of that project. Any other note is a global
candidate that only the global pass can promote to Global Memory. The note is provisional until a
Dreaming pass reviews it.

| Argument     | Type   | Meaning                                                                                  |
| ------------ | ------ | ---------------------------------------------------------------------------------------- |
| `title`      | string | Required, up to 200 characters                                                           |
| `body`       | string | Required, up to 20000 characters                                                         |
| `kind`       | string | `note` (default), `decision`, `lesson`, `fact`, `open_item`, `reference` or `preference` |
| `sources`    | array  | Up to 50 objects, each with optional `harness`, `session_id`, `event_key` and `item_id`  |
| `session_id` | string | The session that writes the note                                                         |
| `cwd`        | string | Folder that selects the project                                                          |

### `note_update` and `note_retract`

`note_update` takes `id`, `title` and `body`, and an optional `session_id`. It changes only a
provisional note of the same session. A note that Dreaming reviewed does not change; write a new
note instead. `note_retract` takes `id` and an optional `session_id`, and retires a note of the same
session.

### `memory_location`

Takes `cwd` and returns the project and the folders of its index, wiki, notes, transcripts and
Global Memory.

## Harness integration

| Harness     | Session summary                      | Tools                                          |
| ----------- | ------------------------------------ | ---------------------------------------------- |
| Claude Code | SessionStart hook in `settings.json` | `claude mcp add --scope user lune-memory -- …` |
| Codex       | SessionStart hook in `hooks.json`    | `codex mcp add lune-memory -- …`               |
| Pi          | Pi extension, system prompt section  | Pi extension                                   |

The Claude Code hook goes into `$CLAUDE_CONFIG_DIR/settings.json` or `~/.claude/settings.json`, with
the matcher `^(startup|resume|clear|compact|fork)$`. The Codex hook goes into
`$CODEX_HOME/hooks.json` or `~/.codex/hooks.json`, with the matcher `startup|resume|clear|compact`,
and `setup` sets `hooks = true` under `[features]` in `config.toml`. Both hooks have a 30-second
timeout. `setup` backs up a file before it changes it and keeps the hooks of other tools.

The Pi extension registers the five tools as Memory Search, Memory Note, Memory Note Update,
Memory Note Retract and Memory Location. It reads the session summary at session start and again
after a compaction. It sets the summary as the same system prompt section on every turn, so the
prompt cache holds. Before an agent turn it waits up to 10 seconds for a pending read. At session
start it shows a hint when Pi import is off.

## Session summary (L1)

The summary has these sections, in this order:

1. Global preferences
2. Project overview and project preferences
3. Working state of the current branch
4. Other active branches
5. Recent sessions not yet in memory, at most 10
6. How to use this memory: trust labels, view paths and the tools

The budget is 200 lines and 25 KB. The stable sections leave a reserve of 30 lines and 4 KB for
the recent sessions and the guidance. An item that the user did not state carries its trust,
`tool` or `inference`, and an item that is not active carries its status.

## Projects

A folder in a Git repository belongs to the project of that repository. Three locators identify a
project:

- `git_common_dir`: the shared `.git` folder, so all worktrees of a clone match
- `remote`: the normalized URL of the `origin` remote, so all clones match
- `path`: a folder outside Git that you registered

A remote that is a local path is not a locator, so unrelated clones of a local repository stay
apart. Sessions in a folder outside any project stay unassigned until you register the folder.
Registration moves the already imported sessions of that folder to the project and marks them
unprocessed.

`merge` moves the sessions, items and locators of one project into another and hides the source. `split` moves one
locator and its sessions to a project of its own and marks those sessions unprocessed, so the next
pass builds the memory of that project. A split never moves a locator into a project that is in use.
When the locator made a project that was merged away (the first project of its Git common dir or
registered path, or the project of an earlier split of the locator), `split` brings that project
back with its old name, unless you give `--name`. Otherwise the split makes a new project. When
the locator made the project that it is in, that project keeps its id and items.

## Dreaming

A session takes part in a pass when it has unprocessed events and no change for `idleHours`.
`dream --force` ignores the idle time and the attempt limit. A pass:

1. Fixes a snapshot of each eligible session, up to `maxSessionsPerPass` sessions and
   `maxCharsPerSession` characters each. Other sessions wait for the next pass.
2. Runs the Analyzer for each session, `concurrency` at a time. It sees the new events, a short
   lead-in, the provisional notes of the session and up to 80 items of the project.
3. Runs the Organizer for each project. It sees up to 300 items and the Analyzer results and
   returns item changes and wiki pages. The backend checks each change and its evidence.
4. Runs the global pass. It keeps up to 400 preferences that apply in every project.
5. Writes a new Markdown generation when at least one project or the global pass committed.

Each project commits its changes in its own transaction, with its own run. The global pass
commits after the projects, in a separate run. When one of them fails, the others stay
committed and the pass ends `partial`. Each change records the run, so `revert <run>` restores
the items of the run. A failed session
gets another attempt in the next pass, up to `maxAttempts` for each revision.

Events that the memory itself put into a session, such as the session summary, are context, not
evidence. The Analyzer does not take them as new facts.

## Local API

The daemon listens on `127.0.0.1` on a free port. `daemon.json` holds the address and a random
token of 32 bytes in base64url. Only the settings page files (`/`, `/ui/app.js` and
`/ui/app.css`) are public. Every other request, also to a path that does not exist, needs
`Authorization: Bearer <token>`. The check uses the path after the router decodes it.

| Check                                                    | Response |
| -------------------------------------------------------- | -------- |
| Host is not `127.0.0.1`, `localhost` or `[::1]`          | 403      |
| `Origin` is not a loopback origin                        | 403      |
| Token is missing or wrong                                | 401      |
| Route does not exist                                     | 404      |
| Unknown or missing project, run, session, note or folder | 404      |
| Invalid input or a rejected operation                    | 400      |
| Other error, such as a failed SQLite or file operation   | 500      |

Errors have the body `{ "error": "<message>" }`. The settings page gets the token from the
address fragment, so the token does not go to the server log or the `Referer` header.

| Method and path                      | Purpose                                                        |
| ------------------------------------ | -------------------------------------------------------------- |
| `GET /api/health`                    | `{ ok, version, pid, busy }`; `busy` is true while a pass runs |
| `POST /api/l1`                       | Session summary for `harness`, `sessionId`, `cwd`              |
| `POST /api/notes`                    | Write a note                                                   |
| `PUT /api/notes/:id`                 | Update a note                                                  |
| `POST /api/notes/:id/retract`        | Retract a note                                                 |
| `POST /api/search`                   | Search transcripts                                             |
| `POST /api/location`                 | Project and view paths of a folder                             |
| `POST /api/import`                   | Import now                                                     |
| `POST /api/dream`                    | Run a pass; `wait: false` returns 202 at once                  |
| `POST /api/regenerate`               | Write a new Markdown generation                                |
| `POST /api/runs/:id/revert`          | Revert a pass                                                  |
| `POST /api/sessions/forget`          | Forget a session                                               |
| `GET /api/status`                    | Daemon, import and Dreaming state                              |
| `GET /api/runs`                      | Latest passes                                                  |
| `GET /api/projects`                  | Projects and their locators                                    |
| `GET /api/sessions`                  | Imported sessions                                              |
| `GET /api/config`, `PUT /api/config` | Read or replace the whole configuration                        |
| `GET /api/credentials`               | Stored providers and key types                                 |
| `PUT /api/credentials/:provider`     | Store a key; an empty key removes it                           |
| `GET /api/providers`                 | Providers and models of pi-ai                                  |
| `POST /api/projects`                 | Register a folder                                              |
| `POST /api/projects/merge`           | Merge two projects                                             |
| `POST /api/projects/split`           | Split a locator off                                            |
| `POST /api/projects/:id/rename`      | Rename a project                                               |
| `GET /api/events`                    | Server-sent events                                             |

`GET /api/events` sends `ready` with the version first. Then it sends `import`, `dream`, `index`
and `config` events, and a ping comment every 25 seconds.

## Privacy

- Import redacts private keys, Bearer and Basic credentials, `key=value` secrets, and the token
  forms of OpenAI, Anthropic, AWS, GitHub, Slack, Google and npm. It also removes passwords from
  URLs. The redaction runs before an event reaches the database. A note that an agent writes
  or updates gets the same redaction before it is stored.
- Dreaming sends session events to the model provider that you select. Nothing else leaves the
  computer.
- `forget` deletes the events and the transcript of a session and stops a new import of its file.
  Items keep their other sources. An item that rests only on that session is retired. The item
  history stays.
- `retentionDays` deletes sessions, events and transcripts that are older. The record of the
  source file stays, so an unchanged file is not imported again. Items stay.

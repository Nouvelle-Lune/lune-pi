# Lune Memory reference

[Back to the README](../README.md)

## Storage

All data is in one folder. `LUNE_MEMORY_HOME` sets it; the default is `~/.lune-memory`. Every
command accepts `--home <dir>` too.

| Path                                      | Content                                                        |
| ----------------------------------------- | -------------------------------------------------------------- |
| `memory.db`                               | SQLite database in WAL mode, the source of truth               |
| `config.json`                             | Settings, mode 0600                                            |
| `credentials.json`                        | Provider API keys, mode 0600                                   |
| `daemon.json`                             | Address, token and process id of the running daemon, mode 0600 |
| `daemon.lock`                             | Lock that keeps one daemon for each memory folder              |
| `logs/daemon.log`                         | Daemon log, rotated at 5 MB                                    |
| `transcripts/<project>/<harness>/<id>.md` | Transcript of each session; `_unassigned` outside a project    |
| `views`                                   | Symlink to the current Markdown generation                     |
| `.generations/`                           | Markdown generations; `generations` of them stay               |
| `projection.lock`                         | Lock that lets one process write a generation at a time        |

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

When a view write fails, the change stays in the database and the views are out of date. `status`
shows `Views out of date` with the error. A note, `revert` and `forget` report the error too, so
the caller does not repeat a change that is already saved. The daemon writes the views again after
each scheduled import, and `regenerate` writes them at once.

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
| `dream [--force] [--project id\|_unassigned] [harness:id...]`                                                                                | Run a Dreaming pass now                                                 |
| `status`                                                                                                                                     | Show the daemon, the import, the Dreaming and the view state            |
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

`--home <dir>` selects the memory folder. It can come before the command name, as in the hook and
MCP commands that `setup` writes. `--json` prints JSON. `--help` and `--version` work with every
command. The CLI calls the daemon when it runs and opens the database itself when it does not.

`dream` with no `--project` covers every project, and with no `harness:id` every eligible
session. `--project _unassigned` covers the sessions outside any project.

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
candidate that only the global pass can promote to Global Memory.

The note is provisional until a Dreaming pass reviews it. The note becomes active only when the
review keeps or corrects it and live session evidence supports it. With no review or no live
evidence, it stays provisional and the next revision of the session reviews it again. A
retraction in the review retires it. An open item on a closed branch is retired too. When the
view write fails, the note is saved and the result says that the views do not show it yet, so the
agent does not write it again.

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
prompt cache holds. Before an agent turn it waits up to 10 seconds for a pending read. A read that
ends after a newer read, or after the session ends, is dropped, so an old summary never replaces a
newer one. At session start it shows a hint when Pi import is off.

## Import

Each import reads the session files of the enabled harnesses and stores the new or changed events.
A file that did not change is not imported again.

- The import follows a symlink in a harness root only when its real path is in the real root.
- A message with a content shape that the adapter does not know makes the import of that file
  fail. A Claude Code file with a cycle in the parent chain of its active path fails too. The
  file and its session get the error, `import` prints it and exits with 1, and the earlier events
  stay. The import does not skip the unknown events, because that would remove them. A text
  block whose `text` is not a string is an unknown shape too.
- Claude Code events take the order of the parent chain. A file that is in chain order keeps its
  order. The active path ends at the last message in chain order, not at the last line of the
  file.
- A Codex event key is the full SHA-256 of its line, so a record keeps its key when other lines
  change. A record that is written again becomes a removed event and a new event.
- A tool call that reads a memory file comes from the memory itself. A relative path counts when
  it resolves to a memory file from the working folder of the call, or from a folder after `cd`,
  `workdir` or a similar word. An absolute path outside the memory folder does not count, also in
  a session that runs in the memory folder.
- When events are removed or moved, the next remaining event, or the new last event, becomes
  unprocessed again, so the next pass sees the change. A session that loses all its events stays
  in the queue until a pass reviews the items that cite it.
- A changed session with no branch in its transcript takes the branch that its work tree has
  checked out now. A work tree on a detached HEAD gives no branch.

## Session summary (L1)

The summary has these sections, in this order:

1. Global preferences
2. Project overview and project preferences
3. Working state of the current branch
4. Other active branches
5. Recent sessions not yet in memory, at most 10
6. How to use this memory: trust labels, view paths and the tools

The budget is 200 lines and 25 KB on each branch. Sections 1 to 4 are the stable part. Dreaming
rejects a change that makes the stable part of a branch grow past the budget less a reserve. The
reserve is measured from the real paths of the memory folder: 10 recent sessions, the count line
and the guidance. A longer memory folder path makes the reserve larger. When a session starts,
the recent sessions that fit the budget are listed, and a last line counts the others. The
stable part and the guidance are never cut. When they alone are over the budget, the summary
goes in full, and the hook writes a warning to stderr or Pi shows a warning.

An item that the user did not state carries its trust, `tool` or `inference`, and an item that is
not active carries its status.

## Projects

A folder in a Git repository belongs to the project of that repository. Three locators identify a
project:

- `git_common_dir`: the shared `.git` folder, so all worktrees of a clone match
- `remote`: the normalized fetch URL of each remote of the repository, so all clones match
- `path`: a folder outside Git that you registered

A remote URL becomes `host/path`, with no protocol, no user and no `.git`, and a lowercase host.
The default port of the protocol goes away. Another port stays (`host:2222/path`), because two
services on one host are two remotes. scp syntax, `git+ssh` and `ssh+git` count as ssh. A remote
that is a local path or a `file:` URL is not a locator, so unrelated clones of a local repository
stay apart. Sessions in a folder outside any project stay unassigned until you register the
folder. Registration moves the already imported sessions of that folder to the project and marks
them unprocessed.

A clone that moves keeps its project when it has a remote, and the project root follows it when
the old root no longer exists. A moved clone with no remote becomes a new project; `merge` joins
it to the old one. The branch of a folder is read from its work tree on each request, so a branch
switch shows at once.

Dreaming reads the state of each branch from Git. In one clone, a branch is deleted when no local
or remote-tracking ref has its name, merged when no worktree has it checked out and its tip is in
a mainline branch, and open in all other cases. Across the clones of a project, open wins over
merged and merged wins over deleted. A clone folder that is no longer a repository does not
count. `main`, `master`, `dev`, `develop` and `trunk` are mainline branches and stay open.

`merge` moves the sessions, items and locators of one project into another and hides the source.
`split` moves one locator and its sessions to a project of its own and marks those sessions
unprocessed, so the next pass builds the memory of that project. It also moves each item whose
evidence all comes from the moved sessions, and each item without evidence that a moved session
wrote, and prints both counts. A provisional note goes with the session that wrote it. When the
locator was the root of the old project, the root moves to a clone or a path that stays. A
project with no root gets one on the next request from its repository. A split never moves a
locator into a project that is in use.
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
the items of the run. A restored item stays in the project that it is in now, so a revert after
a `split` does not move it back. A failed session gets another attempt in the next pass, up to
`maxAttempts` for each revision.

The import goes on during a pass. A pass commits an event as processed only when its hash is the
hash that the model saw, so an event that changed during the pass stays unprocessed for the next
pass. An import that removes or moves events during a pass also stops the pass from marking the
next event processed. An event that is longer than the session budget is analyzed in parts over
several passes.

### Evidence

Every change needs live evidence, the project index and the wiki pages included. Live evidence
is an event that exists, did not come from the memory itself, and has the hash that the model
saw. This includes the sources of the existing items and preferences that the model saw: a
change that cites one of them after it changed or was removed is rejected as a whole, and its
events stay unprocessed. Events that the memory put into a session, such as the session summary,
are context, not evidence. The Analyzer does not take them as new facts.

An event off the active conversation path, such as an abandoned attempt, supports only a lesson, a
fact or a reference. An active project item goes to review in the next pass of a session when it
cites an event of that session that is gone or came from the memory. An item of another kind
also goes to review when it cites an event that left the active path. The pass retires the item
when the Analyzer lists it as unsupported, no other session supports it, and all its other
evidence in the session was in the snapshot. Otherwise the item drops the dead sources of the
session. When no live evidence stays, it keeps its sources and becomes `source-missing`. A pass
reviews at most 40 items of a session; when more need review, the session stays in the queue for
the next pass.

### Branches

When a branch is merged or deleted, the next pass retires its Working State and its open items,
provisional notes included. A Working State change for a closed branch is rejected, and an open
item for a closed branch loses its branch.

### Global pass

A change to a global preference needs the user's own words or support in two or more projects.
A preference is general only when the user's own words say that it applies everywhere; a
statement that names one project, or says "this service" or "this project", is not general. A
global preference retires only with a user retraction outside a project, a user retraction whose
words say that it applies everywhere, or exceptions in two or more projects. The retraction must
be in the same clause as a negation and share a topic word with the preference, so "Always answer
in English, and don't use tabs" does not retire an English rule, and "don't forget" is not a
retraction. A user retraction in a session outside a project starts the global pass. A statement
that the preference already cites does not count. The pass also compares the words of a change
with the stored preference. These checks compare words: they can only stop a change, and they do
not prove that two statements are about the same preference.

A global note becomes active only when the global pass keeps or corrects it with live evidence.
Without such a review it stays provisional, and a retract review retires it.

A reverted global run counts as the last global run, so the next pass does not repeat the
reverted result without new input. `revert <run> --reprocess` marks the sessions of the run
unprocessed, so the next pass analyzes them again.

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
| `GET /api/status`                    | Daemon, import, Dreaming and view state                        |
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

- Import stores the text of each event as the session file has it, and a note stores the text
  that the agent wrote. Neither is redacted for now. A setting that turns redaction on is
  planned. Keys, tokens and passwords in a session go into the database, the Markdown views and
  the Dreaming model.
- The error text of a failed import is redacted: private keys, Bearer and Basic credentials,
  `key=value` secrets, the token forms of OpenAI, Anthropic, AWS, GitHub, Slack, Google and npm,
  and passwords in URLs.
- Dreaming sends session events to the model provider that you select. Nothing else leaves the
  computer.
- `forget` deletes the events and the transcript of a session and stops a new import of its file.
  Items keep their other sources. An item that rests only on that session is retired. The item
  history stays.
- `retentionDays` deletes sessions, events and transcripts that are older. The record of the
  source file stays, so an unchanged file is not imported again. Items stay.

# Lune Subagent

**Delegated tasks for [Pi](https://pi.dev): subagent runs in their own sessions, a Dock entry and an `/agents` inspector.**

The main agent gives a task to a subagent run. A run is a complete Pi session with a fresh context. It works in the background, reports back when its turn ends, and stays available, so the main agent or you can continue it later.

## Quick start

Install from npm:

```bash
pi install npm:@lune_99/pi-subagent
```

Then start Pi and ask for delegated work, for example:

```text
Start a subagent that reviews the diff in src/parser while you update the tests.
```

The main agent starts the run with `subagent_start` and continues its own work. When the run's turn ends, its report arrives as a message and the main agent reacts to it.

## What it does

- **A run is a session, not a prompt.** Each run has its own session file. A run that ended, failed or was interrupted can continue with `subagent_send`.
- **Fresh context only.** A run starts with an empty conversation and gets only its task.
- **Runs never block the main agent.** `subagent_start` returns at once. The report arrives as a steer message when the turn ends; reports that end close together arrive as one message.
- **Optional definitions.** Reusable roles are Markdown files. A one-off task needs no file: the main agent sets up the run in the call.
- **Optional worktrees.** A run can work in its own Git worktree, so parallel changes do not touch your files.
- **No extensions in runs.** A run loads none of your user or project extensions. It gets Pi's native tools and the codemode, tool-search and MCP built-ins, and it cannot start runs of its own. For the same reason, a run cannot use a model that an extension provides, such as a model of the llama.cpp built-in: the start fails and says so.
- **Visible.** Runs show in the Dock and in the `/agents` inspector, where you can read their live transcripts and write to them.

## Agent definitions

Definitions are Markdown files directly in `~/.pi/agent/lune-subagents/` (the `lune-subagents` folder in Pi's agent directory, which follows `PI_CODING_AGENT_DIR`). There is no project-level folder. The package ships no definitions.

| Field         | Required | Meaning                                                                                       |
| ------------- | -------- | --------------------------------------------------------------------------------------------- |
| `name`        | Yes      | Unique name. The main agent uses it to pick the agent.                                        |
| `description` | Yes      | When to use the agent. Shown in the system prompt's agent list.                               |
| `tools`       | No       | Pi tool names, as a comma-separated string or a list. Default: `defaultTools`.                |
| `model`       | No       | `provider/id`. Default: the main agent's current model.                                       |
| `thinking`    | No       | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. Default: the main agent's level. |
| `isolation`   | No       | `shared` or `worktree`. `subagent_start` can override it.                                     |

The body is added to the end of Pi's system prompt; it does not replace it. Definitions load when a session starts, so a new or changed file takes effect after `/new` or `/reload`. A file with invalid frontmatter, an unknown field, a missing field or a duplicate name is reported and not loaded.

The main agent sees the loaded agents as a `subagents` section of its system prompt, one `- name: description` line each.

### Examples

These examples have no `model` field, so they use the main agent's model.

`~/.pi/agent/lune-subagents/reviewer.md`:

```markdown
---
name: reviewer
description: Reviews a diff in a clean context and reports problems.
tools: read, grep, find, ls, bash
thinking: high
---

Review the diff named in the task. Do not change files. Report each problem with its file,
line and reason, most severe first. Report "done" with an empty list when you find nothing.
```

`~/.pi/agent/lune-subagents/explorer.md`:

```markdown
---
name: explorer
description: Finds where something lives in the codebase and explains how it works.
tools: read, grep, find, ls
thinking: medium
---

Answer the question in the task from the code. Name the files and symbols you used. Keep the
summary short; quote only the lines that matter.
```

`~/.pi/agent/lune-subagents/test-writer.md`:

```markdown
---
name: test-writer
description: Writes and runs tests for agreed behavior in an isolated worktree.
tools: read, grep, find, ls, edit, write, bash
isolation: worktree
---

Write tests for the behavior the task names. Follow the project's existing test style. Run
the tests and report the commands, the results and the files you changed.
```

## Starting a run

`subagent_start` takes the task and, optionally, an agent and run settings. Each value comes from the first source that sets it:

| Value     | Sources, in order                                        |
| --------- | -------------------------------------------------------- |
| Model     | The call, the definition, the main agent's current model |
| Thinking  | The call, the definition, the main agent's current level |
| Tools     | The call, the definition, the `defaultTools` setting     |
| Isolation | The call, the definition, `shared`                       |

- The `model` parameter accepts the models of your scope (`--models` or `enabledModels`), or every available model when no scope is set.
- The run always gets the `report` tool as well. A selected tool that the run does not have fails the start; MCP tools are waited for until their server connects.
- A run started from a definition shows with the definition's name. Inline runs are named `run-1`, `run-2` and so on.
- The task is the run's first message, unchanged. The run's system prompt is Pi's own, then the definition body, then a short fixed guide for subagents.

### Workspace isolation

- **`shared`** uses the main agent's working directory. The run sees uncommitted changes and shares files with the main agent.
- **`worktree`** creates a Git worktree for the run, detached at the current `HEAD` commit, in `~/.pi/agent/lune-subagents/worktrees/`. It does not contain uncommitted, untracked or ignored files. A run in a repository subdirectory works in the same subdirectory of the worktree.

The package never merges, commits or deletes a worktree. Its changes stay there until the main agent or you review and integrate them. Remove a worktree with `git worktree remove` once you no longer need the run.

## Tools

| Tool              | Parameters                                                          | Effect                                                                                   |
| ----------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `subagent_start`  | `task`; optional `agent`, `model`, `thinking`, `tools`, `isolation` | Creates a run and returns its ID, workspace and start values.                            |
| `subagent_send`   | `runId`, `message`                                                  | Steers a running run, or starts a new turn in an idle, failed or interrupted run.        |
| `subagent_status` | optional `runId`                                                    | Reads one run, or every run on the current branch, with token usage and the last report. |
| `subagent_stop`   | `runId`                                                             | Stops the current turn. The run becomes `interrupted`; its session and worktree stay.    |

## Reports and states

A run ends each turn with the `report` tool:

| Status        | Meaning                                                                                |
| ------------- | -------------------------------------------------------------------------------------- |
| `done`        | The task is complete.                                                                  |
| `blocked`     | The run cannot finish, for example because it declined the task or finished only part. |
| `needs_input` | The run needs something before it can continue. Its question goes to the main agent.   |

A turn without a report reaches the main agent as unreported, with the run's last message. A run never asks you directly: the main agent answers a question when it can and asks you when only you can.

The run state describes the session, not the task: `running`, `idle`, `failed` (the last turn ended with an error after Pi's retries) or `interrupted` (stopped, or the main session shut down). An `idle` run can be `blocked`.

## Dock and `/agents`

The Dock counts the runs of the current branch by status, for example `◐ Agents · 2 running · 1 needs input`. The statuses are `running`, `needs input`, `blocked`, `failed`, `interrupted`, `unreported`, `done` and `idle`. A run of another branch counts too while its report waits for that branch, and the line says how many such runs there are. The full Dock level also names the run that changed last, for example `latest: reviewer done`.

The Dock never cuts its line. When the cell is too narrow, it leaves out complete parts, the least urgent first, so the `failed`, `blocked` and `needs input` counts stay longest. Then only `◐ Agents` shows, then only the marker. Failed and blocked runs keep the marker red until you open them in the inspector. Without the Lune Dock host, the same line shows as a row below the editor, followed by `/agents to open`.

Run `/agents` to open the inspector. The current branch's runs are on the left, followed by dimmed runs of other branches. The selected run's live transcript is on the right, below the run's heading. The heading shows the run's name, ID, state and report. Below them, it shows the model and thinking level that the run's requests use, for example `Model anthropic/claude-opus-5-5 · Thinking high`. For a live run, the model and level come from its session, where Pi limits the level to what the model supports. Otherwise, they are the run's start values. A narrow pane leaves out heading parts or wraps the model; it never cuts them.

| Action                            | Keys                               |
| --------------------------------- | ---------------------------------- |
| Select run                        | `↑` / `↓` or `k` / `j`             |
| Scroll transcript                 | `Shift+↑` / `Shift+↓` or `K` / `J` |
| Jump to oldest / follow newest    | `Home` / `End`                     |
| Write to the run                  | `Enter`, type, `Enter` to send     |
| Show details                      | `d`                                |
| Stop the run's turn               | `x`                                |
| Copy a report from another branch | `c`                                |
| Close                             | `Esc`                              |

A message you write reaches the run marked as coming from you. A running run gets it as a steer message; otherwise it starts a new turn. The main agent's next report from that run tells it that you wrote to the run.

The details view shows the start values and where each came from, the workspace, the token usage and the run's diagnostics. A run's tokens are not added to the main session's totals.

With the Lune theme on, tool calls in the inspector and the report messages in the transcript render as its activity cards. Without it, the package renders them itself.

## Sessions and branches

- **Shutdown.** When the main session ends, for any reason, running runs stop and become `interrupted`. `subagent_send` continues them later from their session file, in the same working directory. A missing worktree fails the continuation.
- **Branches.** A run belongs to the branch that started it. When you leave a branch with running runs, Pi asks once whether to keep or stop them. A report from a run on another branch waits until you return to that branch.
- **Fork and clone.** Runs of the original session show read-only after `/fork` or `/clone`. Start a new run to continue that work.
- **Storage.** Run sessions are in `~/.pi/agent/lune-subagents/sessions/<session ID>/`, outside Pi's sessions folder, so `/resume` does not list them.

## Development

```bash
npm install
npm test --workspace=@lune_99/pi-subagent
npm run typecheck --workspace=@lune_99/pi-subagent
```

`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` and `typebox` come from the Pi host at runtime, so the package declares them as peer dependencies. The Dock contribution uses `@lune_99/pi-lune-extensions-core/dock`.

## License

MIT

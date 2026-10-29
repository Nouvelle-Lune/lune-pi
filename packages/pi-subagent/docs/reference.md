# Subagent reference

[Back to the README](../README.md)

## Agent definitions

Definitions are Markdown files directly in one of two folders. The package ships no definitions.

- **User definitions** are in `~/.pi/agent/lune-subagents/`: the `lune-subagents` folder in Pi's agent directory, which follows `PI_CODING_AGENT_DIR`.
- **Project definitions** are in `.pi/lune-subagents/` in the directory where you start Pi. They load only when Pi trusts the project.

When a project definition and a user definition have the same name, the project definition is used and the user file is reported as not loaded.

Pi asks whether to trust a project only when the project has resources that Pi itself guards, such as `.pi/settings.json` or `.pi/extensions/`. A project whose only `.pi` content is `lune-subagents/` counts as trusted without a prompt, the same as its `AGENTS.md`. Read the definitions of a project you did not write before you use them.

| Field         | Required | Meaning                                                                                                                                      |
| ------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | Yes      | Unique name. The main agent uses it to pick the agent.                                                                                       |
| `description` | Yes      | When to use the agent. Shown in the system prompt's agent list.                                                                              |
| `tools`       | No       | Tool names, extension tools included, as a comma-separated string or a list. Default: `defaultTools`.                                        |
| `model`       | No       | `provider/id`, or `auto` for the model of the task's tier. Default: the main agent's model.                                                  |
| `thinking`    | No       | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. Default: the classifier's level for `model: auto`, then the main agent's level. |
| `isolation`   | No       | `shared` or `worktree`. Default: `shared`.                                                                                                   |

The body is added to the end of Pi's system prompt; it does not replace it. Definitions load when a session starts, so a new or changed file takes effect after `/new` or `/reload`. Edits in the [settings panel](#settings) are the exception: their model, thinking, tools and isolation apply to the next run at once. A file with invalid frontmatter, an unknown field, a missing field or a name that another file in the same folder uses is reported and not loaded.

The main agent sees the loaded agents as a `subagents` section of its system prompt, one `- name: description` line each, in name order. A project definition shows as `- name (project): description`.

With Lune Core Theme enabled, the same loaded names also appear in an `[Agents]` section below Pi's startup resource lists. No section is shown when no definitions are loaded.

### Create a definition with the built-in skill

The package includes `create-lune-subagent`. Pi can select it when you ask to create a reusable
subagent, or you can invoke it directly:

```text
/skill:create-lune-subagent Create a reusable code-review subagent.
```

The skill first asks whether the definition should be global (user-level) or project-level, unless
you already specified the scope. It asks you to choose the name, description and model, then uses
the model's capabilities and your task details to recommend thinking, tools, isolation and role
instructions. Following the main agent's model is an explicit choice, not an assumed default.

It locates the definition directory with existing shell and file tools and uses the main agent's
tool declarations as its authoring reference, without an extra query tool or helper script. A run
that selects a tool of one of your extensions loads that extension; see
[Extension tools](#extension-tools).

You review the complete definition and destination before it writes the file. The skill does not
start a run; use `/reload` after saving to make the definition available.

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

`subagent_start` takes the task, an optional title, and either an agent or the settings of an inline run. A call that names an agent gives only `task` and `title`: the agent runs with the model, thinking, tools and isolation of its definition, and the main agent cannot change them. A call that names an agent and sets `model`, `thinking`, `tools` or `isolation` starts nothing. To change a role's settings, edit its definition.

With **Auto mode only** on in [settings](#settings), the schema has no `model` parameter and every inline run uses `model: auto`. An inline call that still sets another model starts nothing, and in a `tasks` call no entry starts. Agent runs keep the model of their definition.

Each value comes from the first source that sets it:

| Value     | Agent run                                                                        | Inline run                                                                 |
| --------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Model     | The definition, the main agent's current model                                   | The call, `auto` with Auto mode only, the main agent's current model       |
| Thinking  | The definition, the classifier for `model: auto`, the main agent's current level | The call, the classifier for `model: auto`, the main agent's current level |
| Tools     | The definition, the `defaultTools` setting                                       | The call, the `defaultTools` setting                                       |
| Isolation | The definition, `shared`                                                         | The call, `shared`                                                         |

- The `model` parameter accepts the **Allowed models** selection in [settings](#settings), when nonempty, and `auto`. Otherwise, it accepts the models of your scope (`--models` or `enabledModels`), or every available model when no scope is set. The same allowed set checks explicit models in definitions and auto tiers; inheriting the main agent's current model remains allowed even outside that set.
- The run always gets the `report` tool as well. A selected tool that the run does not have fails the start; MCP tools are waited for until their server connects.
- A run started from a definition shows with the definition's name. Inline runs are named `run-1`, `run-2` and so on.
- The optional `title` labels a run in the `/agents` inspector, the Dock and its end-of-turn notice. The inspector and Dock show the title in place of the name.
- The task is the run's first message, unchanged. The run's system prompt is Pi's own, then the definition body, then a short fixed guide for subagents.

### Auto model

`model: auto`, in the call or in a definition, lets a Pi classifier rate the task. The run then uses the model that you set for the task's tier, and the thinking level that the task needs among the levels this model supports. Set it up in the [Subagents settings](#settings).

The classifier answers three separate questions: how difficult the task is, how much reasoning it needs, and whether a mistake in it could do serious harm. It reads the task, the agent's name, description and instructions, the tool access and the workspace. It does not see model names or prices: you map the tiers to models.

| Question  | Options                                                                      | Result                       |
| --------- | ---------------------------------------------------------------------------- | ---------------------------- |
| Tier      | light, standard, complex, deep                                               | The model set for that tier  |
| Thinking  | Pi's levels `off` to `max` that the run's model supports, as Pi reports them | The run's thinking level     |
| High risk | Yes or no, as a probability                                                  | A floor for the model's tier |

The tier and high-risk questions always go in the first request. The thinking options depend on the run's model, and the model depends on the tier. When every model that the tier can lead to supports the same levels, the first request also asks the thinking question. Otherwise, a second request asks it after the model is known. A model with only one level gets no thinking question.

- **Tier models.** A tier without a model uses the next tier up that has one. When no tier from the rated one up has a model, the run uses the main agent's model, so the main agent's model is the ceiling. With no tier set, every auto run uses the main agent's model with the rated thinking.
- **Thinking.** A thinking level from the call or the definition stays, and then the classifier gets no thinking question.
- **High risk.** A task is high risk when the classifier's probability reaches the High-risk threshold (default 0.4). The threshold is below one half because a missed high-risk task usually costs more than a false alarm; adjust it with your own tasks. A high-risk task gets at least the model of the High-risk floor tier (default Deep, which falls back to the main agent's model). The rated tier stays as it is, and a tier above the floor is not lowered. The risk does not change the thinking level. It is a model choice only: tool permissions, approvals and the other checks of a run stay the same.
- **Unsure answers.** When the classifier's confidence in an answer is below 50%, the run uses the next level up.
- **Long tasks.** The request must fit the classifier's context window, and the package does not know the classifier's tokenizer. It therefore counts UTF-8 bytes, because a token always has at least one byte. The request gets at most 32 KB, and at most the window less 512 tokens for the classifier's own prompt; Pi's llama.cpp classifier shows the request twice, so it gets half. When the task and the agent's instructions do not fit, the instructions get at most a quarter of the room, and each is cut in the middle: the start and the end stay, with a note of how many characters are left out. When less than 1 KB is left for them, the classifier is not called and the run falls back as when the classifier fails.
- **No classifier selected:** the run uses the main agent's model and thinking. This is the default.
- **Nothing to rate:** when no tier has a model and the thinking is set, the run uses the main agent's model without a classifier request.

When the classifier fails, the run uses the main agent's model, and its thinking unless the call or the definition sets one. This covers an unavailable classifier, a failed request, an invalid answer and a window that is too small. A cancelled start still stops. A tier model that the subagent allowed set no longer permits is a settings error and fails the start; select another model under Auto tiers. For an inline run, the main agent can name a model instead; an agent run takes its model only from its definition. The start values show the choice and any error, for example `Model: anthropic/claude-haiku-5-5 (auto from call: the classifier cls/judge rated the task complex (71%), not high risk (8%); the complex tier's model)` and `Thinking: high (auto: the classifier rated the thinking high (64%))`. The [inspector](#dock-and-agents) shows the rating at the top of the run's log.

### Extension tools

A run can select a tool that one of your user or project extensions registers in the main session. The run then loads the file of that extension in its own session, with only the tools it selected. The `tools` parameter of `subagent_start` lists these tools with the others; a tool that an extension registers after the session started is missing from the list, but a run can still select it.

- The extension runs in the run, not in the main session, and its event handlers run too. An extension that adds to the system prompt or blocks tool calls does the same in the run.
- Pi reuses a loaded extension module for the sessions in the same working directory. A `shared` run can therefore use the same module as the main session and as other `shared` runs. An extension that keeps session state at module level, and not in the state that its factory creates, shares that state with them.
- The run has no UI, so a tool that needs your input does not work in a run. A tool that checks for the interactive UI returns an error. A dialog that an extension opens is answered as dismissed and shows as a run diagnostic.
- Names that the run has on its own stay Pi's. An extension that replaces `bash` in the main session does not replace it in the run, and an extension loaded for one tool adds none of its other tools.
- A tool that works together with a replaced built-in tool is therefore incomplete in a run. For example, Lune Shell Inspector's `background_shell` shows background jobs, but only its `bash` starts them, so a run has no jobs to show.
- The subagent tools are never available, so runs cannot start runs. Tools of project extensions are available only while Pi trusts the project.
- An extension that fails to load, or that does not register the selected tool in the run's working directory, fails the start.
- A run that continues after you resume the session loads the extensions of its tools again, as the main session has them at that time. When the main session no longer has one of its tools, the run cannot continue.

### Several runs in one call

The main agent can give `tasks` instead of `task`: a list of entries, each with its own `task` and the same optional values as a single start. With `tasks`, the optional values go in each entry, not at the top level. A call that mixes them, gives both `task` and `tasks`, or has an entry that names an agent and sets its settings, starts nothing.

All entries start at the same time, and each one on its own. An entry that fails to start, for example with a tool that the run does not have, undoes only its own work and does not stop the others. A run that started is kept. The result names each entry by its index, `tasks[0]`, `tasks[1]` and so on, with its run or its error. When no entry starts, the call fails.

### Workspace isolation

- **`shared`** uses the main agent's working directory. The run sees uncommitted changes and shares files with the main agent.
- **`worktree`** creates a Git worktree for the run, detached at the current `HEAD` commit, in `~/.pi/agent/lune-subagents/worktrees/`. It does not contain uncommitted, untracked or ignored files. A run in a repository subdirectory works in the same subdirectory of the worktree.

The package never merges, commits or deletes a worktree. Its changes stay there until the main agent or you review and integrate them. Remove a worktree with `git worktree remove` once you no longer need the run.

## Tools

Every tool that takes a run addresses it by the ID that `subagent_start` returned: eight hexadecimal characters, such as `8416992c`. A run's title and name identify it only in the inspector, the Dock and notices; a tool given either one fails, and the error lists the branch's run IDs.

| Tool              | Parameters                                                                                                                        | Effect                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `subagent_start`  | `task` or `tasks`; optional `agent`, `title`; for inline runs `model` (not with Auto mode only), `thinking`, `tools`, `isolation` | Creates a run, or one run per `tasks` entry, and returns each ID, workspace and start values. |
| `subagent_send`   | `runId`, `message`                                                                                                                | Steers a running run, or starts a new turn in an idle, failed or interrupted run.             |
| `subagent_status` | optional `runId`                                                                                                                  | Reads one run, or every run on the current branch, with token usage and the last report.      |
| `subagent_stop`   | `runId`                                                                                                                           | Stops the current turn. The run becomes `interrupted`; its session and worktree stay.         |

## Reports and states

A run ends each turn with the `report` tool:

| Status        | Meaning                                                                                |
| ------------- | -------------------------------------------------------------------------------------- |
| `done`        | The task is complete.                                                                  |
| `blocked`     | The run cannot finish, for example because it declined the task or finished only part. |
| `needs_input` | The run needs something before it can continue. Its question goes to the main agent.   |

A turn without a report reaches the main agent as unreported, with the run's last message. A run never asks you directly: the main agent answers a question when it can and asks you when only you can.

A message that reaches a run while it reports, for example a steer message from the main agent or from you, continues the same turn, and the run reports again. The last report is the turn's report. The main agent also gets the earlier reports of the turn in the same message, and `subagent_status` shows them.

Each report message is confirmed in the main session. A message that is still missing after a run of the main agent ended is sent again. When you interrupt the main agent in Pi's interactive mode, Pi clears the queued messages, so a report message that waited in the queue goes with your next message instead, and a notification says so. After two retries without success, an error notification says that `subagent_status` still returns the results.

The run state describes the session, not the task: `running`, `idle`, `failed` (the last turn ended with an error after Pi's retries) or `interrupted` (stopped, or the main session shut down). An `idle` run can be `blocked`.

## Dock and `/agents`

The Dock counts the runs of the current branch by status, for example `◐ Agents · 2 running · 1 needs input`. The statuses are `running`, `needs input`, `blocked`, `failed`, `interrupted`, `unreported`, `done` and `idle`. A run of another branch counts too while its report waits for that branch, and the line says how many such runs there are. The full Dock level also names the run that changed last, for example `latest: reviewer done`. Without runs every level shows only `○ Agents`, as Shell and Ask do.

The Dock never cuts its line. When the cell is too narrow, it leaves out complete parts, the least urgent first, so the `failed`, `blocked` and `needs input` counts stay longest. Then only `◐ Agents` shows, then only the marker.

The marker shows the most urgent state: a red `✕` for a failed or blocked turn, `?` when a run needs input, `◐` while a run works, a gray `●` when runs are failed or blocked, a green `●` for other runs, and `○` without runs. The red `✕` shows for 10 seconds after the turn ends, or until you open the run in the inspector; a later failed turn shows it again. Without the Lune Dock host, the same line shows as a row below the editor, followed by `/agents to open`.

Run `/agents` to open the inspector. The current branch's runs are on the left, followed by dimmed runs of other branches. The selected run's live transcript is on the right, below the run's heading. The heading shows the run's name, ID, state and report. Below them, it shows the model and thinking level that the run's requests use, for example `Model anthropic/claude-opus-5-5 · high`. For a live run, the model and level come from its session, where Pi limits the level to what the model supports. Otherwise, they are the run's start values. A narrow pane leaves out heading parts or wraps the model; it never cuts them.

For a run with `model: auto`, the model row ends with the tier and its share, for example `Model anthropic/claude-haiku-5-5 · medium · auto complex 71%`. When the classifier was unsure and the run used a higher tier, the row shows that tier without a share. A task rated high risk adds `high risk` to the row. When the classifier failed, the row ends with `auto failed`, and the top of the log shows the error. The top of the run's log shows the classifier's answer: the share of each tier, the chosen tier and its model, the high-risk probability with its threshold and any floor it set, and the rated thinking level. This block scrolls with the log.

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

The transcript is a compact log. Each tool call takes one row with its status and time, and an edit also shows the lines it added and removed, for example `● edit src/a.ts · +12 −3 · 0.2s`. A failed call adds the first lines of its error, and a running call the last lines of its output. A finished thought takes one row, for example `Thinking · 42 lines`. Assistant text, your messages, the main agent's messages and reports show in full. A report call shows `writing` while its arguments stream and until the run records it, and `not sent` when it was stopped first. Until then its status and summary are dimmed. A recorded report still reaches the main agent only when the turn ends.

With the Lune theme on, the report messages in the main transcript render as its activity cards. Without it, the package renders them itself.

## Settings

Run `/lune-core-settings subagents` to open the Subagents section of Lune settings. It needs Lune Core's extension; settings are saved per scope, global or project, like other Lune settings.

| Setting         | Meaning                                                                                                                                                                                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Allowed models  | A multi-select list from Pi's scoped models. A nonempty selection replaces the session's default allowed list for new runs; an empty list follows Pi's scope.                                                                                                                          |
| Auto classifier | The Pi classifier for `model: auto`. None: auto runs use the main agent's model and thinking.                                                                                                                                                                                          |
| Auto mode only  | Off by default. On: `subagent_start` has no `model` parameter, and inline runs always use `model: auto`. Custom agents keep their definition's model.                                                                                                                                  |
| Auto tiers      | A menu with one model per task tier, Light, Standard, Complex and Deep, from the subagent allowed set. A tier without a model uses the next tier up, then the main agent's model. The menu also sets the High-risk floor (Off, Standard, Complex or Deep) and the High-risk threshold. |
| Custom agents   | A menu of agent definitions: your user agents at global scope, the project's at project scope.                                                                                                                                                                                         |

In **Allowed models**, Space toggles a model and Enter saves. Changes update the `subagent_start`
model options for both single and batched starts immediately. A saved selection replaces the
session's list rather than intersecting it, so an available saved model remains allowed when a
later session has a different scope. Saved models outside the current scope or no longer available
stay listed for removal; unavailable models cannot start new runs, and a selection containing only
unavailable models does not fall back to Pi's list. Clear the selection to restore Pi's default.
The main agent's inherited model and the model of an existing or resumed run are unchanged.

In **Custom agents**, Enter opens an agent, and its page edits the name, description, model, thinking level, tools and isolation. Each change is written to the definition file at once; comments and the body stay. Ctrl+R removes an optional field, so the run's default applies again. Renaming an agent renames a file named after it. Model, thinking, tools and isolation apply to the next run; the name and description reach the main agent after `/reload`, because its agent list stays fixed for the session. MCP tools are not listed in the tools menu, but selected MCP tools stay in the file. A file that does not load is listed with its problem and must be fixed by hand.

## Sessions and branches

- **Shutdown.** When the main session ends, for any reason, running runs stop and become `interrupted`. `subagent_send` continues them later from their session file, in the same working directory. A missing worktree fails the continuation.
- **Branches.** A run belongs to the branch that started it. When you leave a branch with running runs, Pi asks once whether to keep or stop them. A report from a run on another branch waits until you return to that branch.
- **Fork and clone.** Runs of the original session show read-only after `/fork` or `/clone`. Start a new run to continue that work.
- **Storage.** Run sessions are in `~/.pi/agent/lune-subagents/sessions/<session ID>/`, outside Pi's sessions folder, so `/resume` does not list them.

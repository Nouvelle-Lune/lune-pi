---
name: create-lune-subagent
description: Create a reusable Lune Subagent definition with a user-approved scope, name, description and model, then recommend thinking, tools and isolation for its tasks. Use when the user asks to create a reusable Lune subagent, not merely to start a one-off run.
---

# Create a Lune subagent

Create a reusable Markdown definition, not a running session. Follow the steps in order. Do not
write a definition until the user approves the complete draft. Use an available question tool for
user decisions; otherwise ask in the conversation and wait for an answer.

## 1. Ask for the scope first

If the user has not explicitly specified the scope, begin by asking:

> Should this subagent be global (user-level), or only available to the current project?

Wait for the answer before collecting the other fields. Never infer the scope from the working
directory. If the user already specified it, keep that choice without asking again.

- **Global (user-level):** `<agentDir>/lune-subagents/<name>.md`. Resolve Pi's actual agent directory,
  respecting `PI_CODING_AGENT_DIR`; its default is `~/.pi/agent`.
- **Project:** `<cwd>/.pi/lune-subagents/<name>.md`, where `cwd` is the current Pi session's working
  directory. Do not move the file to the Git root or search ancestor directories instead. Project
  definitions load only when Pi trusts the project; do not change trust settings on the user's behalf.

Locate these paths with the shell and file tools already available to you:

- Read the session's working directory from the host context. If needed, verify it with the shell's
  working-directory query without changing directories. Do not use the skill's own directory as `cwd`.
- For global scope, inspect `PI_CODING_AGENT_DIR` in the inherited environment. If set, use that path
  and expand a leading `~` against the user's home directory. Otherwise inspect `~/.pi/agent`.
- If the local Pi setup is unclear, inspect its installed documentation or the path-resolution code
  around `getAgentDir` using a targeted search. Do not scan the whole filesystem or choose the first
  directory named `lune-subagents`. If the effective path still cannot be established, ask the user.

A missing `lune-subagents` directory is normal for a first definition; create it only after draft
approval. Do not switch to another scope or directory merely because it already exists. Only
Markdown files directly in the selected directory are definitions, not files in nested folders
such as `sessions/` or `worktrees/`. No helper script, new runtime, or extra Pi process is needed.

## 2. Confirm the identity, model and task

Ask for any missing decisions below. Accept values the user already supplied; do not ask them to
repeat the same information.

- **`name`:** Ask what the user wants to call the subagent. You may offer candidates, but do not
  choose one without approval.
- **`description`:** Ask what it should do and when the main agent should select it. You may draft
  or refine a concise routing description, but the user must approve the wording.
- **Model:** Ask the user to choose an exact `provider/id`, or explicitly choose **Follow the main
  agent's model**. Use the current `subagent_start` tool schema's model choices rather than a
  hardcoded list. A fixed model must be available within the current model scope. Following the main
  agent means omitting `model`; explain that behavior instead of silently omitting the field.

Runs load no user or project extensions. A model supplied only by an extension, including the
llama.cpp built-in, is unavailable to a run even if the parent lists it. If the requested model is
unavailable, explain the problem and ask for a supported choice or the necessary configuration;
never substitute another model silently. Do not read or print credentials to check availability.

Clarify only the task details that affect the design: expected inputs and outputs, responsibilities,
prohibited actions, whether it edits files or executes commands, external services, and whether it
needs the current uncommitted files. Reuse details already given. Do not ask the user to write the
system prompt or select every remaining field themselves.

## 3. Analyze and recommend the remaining configuration

Base recommendations on both the selected model and the task, not a fixed role preset. For every
field, show the proposed value or omission, why it fits, and the important tradeoff. Respect values
already requested by the user; explain conflicts rather than changing them silently.

### Thinking

Check the selected model's current Pi metadata and supported thinking levels. Use information
already exposed by the session, or inspect the relevant local model configuration and Pi support
code on demand; do not install a runtime or start another Pi session to obtain it. The definition
format accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`, but an individual model does not
necessarily support all of them. Do not infer support from the model name or rely on Pi clamping an
unsupported recommendation.

Recommend a supported level based on the reasoning required and the latency or cost tradeoff. Do
not always recommend the highest level. If the user chose to follow the main model, analyze the
current model and explain that changing models can change which levels are suitable. If capability
information cannot be verified, say so and resolve that uncertainty with the user before finalizing
the recommendation. Do not change the parent's model or thinking level merely to inspect it.

### Tools

Use the main agent's currently available tool declarations as the authoring catalog. Read the
names, descriptions and parameters already exposed to you. If more detail is needed, use existing
tool discovery, such as Codemode's `describeTool` when available. Do not add a dedicated query tool
or create a child session to inspect its catalog.

Recommend the smallest sufficient set for the work: reading and searching for exploration,
editing for changes, and a shell only when commands are needed. A shell can modify files even when
`edit` and `write` are absent; tool selection is not a security boundary.

- Use exact registered tool names, not display labels or code aliases. `tools` accepts a YAML list
  or a comma-separated string. `+name` and `-name` are not supported.
- Select MCP tools by their actual names and descriptions from the main agent's tool declarations
  or existing discovery results. Do not invent names from a placeholder or assume the same server
  configuration is present in a different working directory.
- `report` is always added by the package. Do not list it as an optional task tool or claim that it
  can be disabled.
- Omitting `tools` inherits Pi's `defaultTools`. `tools: []` deliberately selects no task tools;
  it still receives `report`. Explain the distinction if recommending either option.

The main agent's catalog is the reference for authoring, not a guarantee of child availability.
The current Lune runtime loads Pi native tools and the codemode, tool-search and MCP built-ins,
but not user or project extensions. Disclose this limitation if a recommendation depends on an
extension-only tool. Do not claim that future extension support is already implemented, or silently
remove or substitute a tool the user chose.

### Isolation

Keep definition scope and workspace isolation separate: a project definition can use either mode.

- Recommend **`shared`** when the task must inspect the current uncommitted changes or intentionally
  work in the main agent's working directory. Explain that files are shared with the parent and
  other shared runs.
- Recommend **`worktree`** for independent parallel changes that must not touch the main checkout,
  provided the current directory is in a usable Git repository. The run starts at the current
  `HEAD`, without staged, unstaged, untracked or ignored files. Do not recommend it for reviewing
  uncommitted changes. It is not a sandbox and does not isolate external services.

A worktree does not automatically install dependencies or copy local configuration. The package
never automatically merges, commits or deletes it. Do not create a worktree or install dependencies
just to create this definition.

### Definition body

Write durable role instructions covering its goal, boundaries, necessary workflow, evidence or
verification requirements, and expected deliverable. Runs start with a fresh conversation, so do not
refer to the parent's earlier discussion or assume it will be inherited. Leave task-specific inputs
for the start call unless the user explicitly wants them fixed in the role.

The body is appended to Pi's system prompt. The package then adds its own guide for reporting and
questions. Do not replace that protocol, duplicate its full instructions, instruct the run to ask
the user directly, or give it subagent-management tools.

## 4. Present the draft and obtain approval

Inspect existing definitions in both scopes before presenting the destination. Names must be unique
within a scope; two files with the same name in one folder are both rejected. A trusted project's
definition replaces a user definition of the same name. Point out any cross-scope shadowing and
obtain approval for that effect. An existing file or same-scope name requires an explicit decision
to update it or use a different name; do not overwrite it as part of creating a new definition.

Check the draft against the definition format:

- The YAML mapping has only `name`, `description`, `model`, `thinking`, `tools` and `isolation`.
  Do not add fields such as `scope`, `skills`, `allowed-tools`, `permissionMode` or `systemPrompt`.
- `name` and `description` are non-empty strings. A name starts with a letter or digit, contains
  only letters, digits, `.`, `_` or `-`, and is at most 64 characters. `run-<digits>` is reserved.
  Use the approved name exactly; do not silently normalize or rename it.
- A fixed `model` is the approved `provider/id`. Quote YAML strings when necessary.
- Any `thinking` value is supported by the chosen model, tool names are exact, and `isolation` is
  `shared` or `worktree`.

Explain any omitted optional fields: `model` follows the main model, `thinking` follows the main
thinking level subject to the selected model's support, `tools` inherits `defaultTools`, and
`isolation` defaults to `shared`. Start-call overrides take precedence over definition values.

Show the chosen scope, exact destination path, recommendation summary, and complete Markdown file
including its frontmatter and body. Ask the user to approve this draft or request changes. A request
to create a subagent is not approval of configuration the user has not seen. If a later choice
changes the recommendations, revise the draft and obtain approval before writing.

## 5. Save only the approved definition

After approval, recheck the destination and names for new conflicts, create the selected directory
if necessary, and write only the approved file. Do not change Pi settings, install extra packages,
copy the skill into a user directory, or start a run.

Report the saved path and summarize the approved role and configuration. Tell the user to run
`/reload` (or start a new session with `/new`) before selecting the new definition: the roster and
`agent` tool choices were built when the session started. Do not claim the definition is already
loaded or call `subagent_start` with its name before that reload. Include a concise usage example
with the approved agent name and a self-contained task, but do not execute it unless requested.

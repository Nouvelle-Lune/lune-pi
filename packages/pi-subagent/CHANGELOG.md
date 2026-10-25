# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- **Subagent runs.** The main agent delegates a task with `subagent_start` and continues while the run works in its own Pi session with a fresh context. With `tasks`, one call starts several runs at the same time, and an entry that fails to start does not stop the others. `subagent_send`, `subagent_status` and `subagent_stop` steer, read and stop runs, and each ended turn reaches the main agent as a batched steer message with the run's report.
- **Agent definitions.** Markdown files in `lune-subagents/` in Pi's agent directory, and in `.pi/lune-subagents/` of a trusted project, define reusable roles with their tools, model, thinking level and isolation. A project definition replaces a user definition of the same name. The loaded agents appear in the system prompt's `subagents` section, with project agents marked, and invalid or replaced files are reported instead of loaded.
- **Runs per branch and session.** A run belongs to the branch that started it, and its reports wait while another branch is active, then arrive when you return. Leaving a branch with running runs asks once whether to keep or stop them. Runs come back from their own session files when you resume the session, and runs that arrive through `/fork` or `/clone` are read-only.
- **Worktree isolation.** A run can work in its own detached Git worktree at the current `HEAD` commit. The package keeps the worktree for later turns and never merges or deletes it.
- **Dock entry and `/agents` inspector.** The Dock counts runs by status, and its full level names the run that changed last. Without runs it shows only `○ Agents` at every display level, matching Shell and Ask. A narrow Dock cell leaves out complete parts, the least urgent first, and never cuts the line. The inspector shows each run's live transcript and the model and thinking level that its requests use. It lets you write to a run or stop it, and shows its start values, workspace and token usage.

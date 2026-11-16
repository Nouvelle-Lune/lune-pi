# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- **Session import.** Import the session files of Pi, Claude Code and Codex into one SQLite database with full-text search. Each harness is off until `lune-memory setup <harness>` turns it on. The import reads only new or changed files, redacts keys, tokens, passwords and private keys before an event reaches the database, and writes a redacted Markdown transcript of each session.
- **Projects across harnesses.** Map every session to the project of its repository. All worktrees of a clone and all clones with the same remote share one project, and a folder outside Git becomes a project with `register`. `rename`, `merge` and `split` correct the mapping, and the moved sessions go through Dreaming again.
- **Session summary (L1).** Give each new session a summary of at most 200 lines: global preferences, the project overview, the working state of the current branch, other active branches, the recent sessions that Dreaming has not processed and how to use the memory. Claude Code and Codex get it from a SessionStart hook that `setup --install-hook` adds. Pi gets it from the extension as a stable system prompt section.
- **Dreaming.** Update the memory in the background after a session is idle for `idleHours`. An Analyzer call for each session extracts decisions, lessons, preferences, the working state and open items with their evidence, an Organizer call for each project merges them into the items and the wiki, and a global pass keeps the preferences that apply in every project. The backend checks every change against its evidence and the L1 budget. Each project and the global pass commit in their own transaction, so one failure leaves the others committed. `dream` starts a pass at once, `runs` lists passes and `revert` undoes one.
- **Models through pi-ai.** Call the Dreaming model through pi-ai, so every provider and model that pi-ai knows works without a separate adapter. A key in the credential store has priority over the environment variable of the provider, and no list or API response shows a stored key.
- **MCP tools.** `lune-memory mcp` serves `transcript_search`, `note_write`, `note_update`, `note_retract` and `memory_location` over stdio. The Pi extension registers the same tools and fills in the session and the folder.
- **Markdown views.** Write the project index, the wiki, the notes, the transcript links and Global Memory as read-only Markdown under `~/.lune-memory/views`. Each change writes a new generation and moves the link, and earlier generations stay for restore.
- **Local daemon and settings page.** Run imports and scheduled passes in a daemon that listens on loopback only and needs a random token for every request. `lune-memory settings` opens a local page where you turn harnesses on, select the model and its limits, store API keys, start and revert passes and manage projects.
- **Command line.** `lune-memory` covers setup, search, import, Dreaming, runs, sessions, projects, config, credentials, the daemon and the hooks. It calls the daemon when it runs and opens the database itself when it does not.
- **Forget and retention.** `forget` deletes one session and the memory that only it supports, and keeps its file from a new import. `retentionDays` deletes older sessions, events and transcripts and keeps the items.

[Unreleased]: https://github.com/Nouvelle-Lune/lune-pi/commits/dev/packages/lune-memory

import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Definitions live directly in this folder; its `sessions/` and `worktrees/` children are never read as definitions. */
export function definitionsDir(agentDir: string = getAgentDir()): string {
    return join(agentDir, "lune-subagents");
}

/** Run sessions sit outside Pi's sessions folder, so `/resume` and Core's `@` mentions never list them. */
export function runSessionsDir(parentSessionId: string, agentDir: string = getAgentDir()): string {
    return join(definitionsDir(agentDir), "sessions", parentSessionId);
}

export function runSessionFile(
    parentSessionId: string,
    runId: string,
    agentDir: string = getAgentDir(),
): string {
    return join(runSessionsDir(parentSessionId, agentDir), `${runId}.jsonl`);
}

export function runWorktreePath(
    parentSessionId: string,
    runId: string,
    agentDir: string = getAgentDir(),
): string {
    return join(definitionsDir(agentDir), "worktrees", parentSessionId, runId);
}

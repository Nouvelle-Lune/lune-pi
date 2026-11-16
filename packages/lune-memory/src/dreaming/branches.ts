import { nowIso } from "../core/util.ts";
import { branchStates } from "../projects/git.ts";
import { text, textOrNull, type Store } from "../store/db.ts";
import { getProject } from "../store/rows.ts";

export type ClosedState = "merged" | "deleted";

export interface ClosedBranch {
    name: string;
    status: ClosedState;
    closedAt: string | null;
}

export interface BranchRefresh {
    checked: number;
    closed: string[];
    reopened: string[];
}

/**
 * Check the Git state of the branches of one project, with no model call. It checks open
 * branches, and closed branches that got new session changes after they closed, because a
 * branch name can come back. A branch that Git reports open again is reopened.
 */
export function refreshBranches(
    store: Store,
    projectId: string,
    now: number = Date.now(),
): BranchRefresh {
    const result: BranchRefresh = { checked: 0, closed: [], reopened: [] };
    const project = getProject(store, projectId);
    if (!project?.root) return result;
    const rows = store.all(
        `SELECT b.name, b.status, b.closed_at FROM branches b
        WHERE b.project_id = ? AND (b.status = 'open' OR EXISTS (
            SELECT 1 FROM sessions s
            WHERE s.project_id = b.project_id AND s.branch = b.name
            AND b.closed_at IS NOT NULL AND s.changed_at > b.closed_at
        ))`,
        projectId,
    );
    if (!rows.length) return result;
    const names = rows.map((row) => text(row, "name"));
    const states = branchStates(project.root, names);
    const at = nowIso(now);
    store.tx(() => {
        for (const row of rows) {
            const name = text(row, "name");
            const before = text(row, "status");
            const state = states.get(name) ?? "open";
            result.checked++;
            if (state === "open") {
                if (before !== "open") {
                    store.run(
                        `UPDATE branches SET status = 'open', closed_at = NULL, handled_run = NULL,
                        checked_at = ? WHERE project_id = ? AND name = ?`,
                        at,
                        projectId,
                        name,
                    );
                    result.reopened.push(name);
                } else {
                    store.run(
                        "UPDATE branches SET checked_at = ? WHERE project_id = ? AND name = ?",
                        at,
                        projectId,
                        name,
                    );
                }
                continue;
            }
            if (before === "open") {
                store.run(
                    `UPDATE branches SET status = ?, closed_at = ?, handled_run = NULL, checked_at = ?
                    WHERE project_id = ? AND name = ?`,
                    state,
                    at,
                    at,
                    projectId,
                    name,
                );
                result.closed.push(name);
            } else {
                store.run(
                    "UPDATE branches SET status = ?, checked_at = ? WHERE project_id = ? AND name = ?",
                    state,
                    at,
                    projectId,
                    name,
                );
            }
        }
    });
    return result;
}

/** Closed branches whose Working State a pass has not closed yet. */
export function pendingClosedBranches(store: Store, projectId: string): ClosedBranch[] {
    return store
        .all(
            `SELECT name, status, closed_at FROM branches
            WHERE project_id = ? AND status != 'open' AND handled_run IS NULL
            ORDER BY closed_at, name`,
            projectId,
        )
        .map((row) => ({
            name: text(row, "name"),
            status: text(row, "status") === "deleted" ? "deleted" : "merged",
            closedAt: textOrNull(row, "closed_at"),
        }));
}

/** Projects with open or unhandled closed branches. */
export function projectsWithBranches(store: Store): string[] {
    return store
        .all(
            `SELECT DISTINCT b.project_id FROM branches b JOIN projects p ON p.id = b.project_id
            WHERE p.merged_into IS NULL AND (b.status = 'open' OR b.handled_run IS NULL)
            ORDER BY b.project_id`,
        )
        .map((row) => text(row, "project_id"));
}

import { access, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
    getAgentDir,
    type ExtensionAPI,
    type ExtensionContext,
    type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type { ResourceScope } from "../resources/resources.ts";
import { createMentionAutocomplete } from "./autocomplete.ts";
import { SessionCatalog } from "./catalog.ts";
import { fileReference, findMentions, replaceMentions, resolveMention } from "./mention.ts";
import { buildTranscript } from "./transcript.ts";

/**
 * `@` lists local sessions with pi's file matches, and `@@` lists sessions only. A picked
 * session becomes `@session:<id>`. On submit, each such token becomes an `@` reference to
 * a filtered copy of that session, which the model reads when it needs the background.
 */
export function installMentions(pi: ExtensionAPI, resources: ResourceScope): void {
    let catalog: SessionCatalog | undefined;
    const transcripts = new TranscriptCache();
    const retire = () => {
        catalog?.dispose();
        catalog = undefined;
    };
    resources.defer(retire);

    resources.defer(
        pi.on("session_start", (_event, ctx) => {
            retire();
            const report = (error: unknown) =>
                ctx.ui.notify(`Session list failed: ${errorMessage(error)}`, "error");
            const sessions = new SessionCatalog(ctx.sessionManager.getSessionDir(), report);
            catalog = sessions;
            if (ctx.mode !== "tui") return;
            // Pi drops autocomplete wrappers when it replaces the session, so add one per start.
            ctx.ui.addAutocompleteProvider((current) =>
                createMentionAutocomplete(current, {
                    catalog: sessions,
                    currentSessionFile: ctx.sessionManager.getSessionFile(),
                }),
            );
            // Read the sessions now, so the first `@` already lists them.
            sessions.reload().catch(report);
        }),
    );

    resources.defer(
        pi.on("input", async (event, ctx) => {
            const mentions = findMentions(event.text);
            if (mentions.length === 0) return { action: "continue" };
            try {
                if (!catalog) throw new Error("Session mentions have no active session");
                const files = new Map<string, string>();
                for (const idPrefix of new Set(mentions.map((mention) => mention.idPrefix))) {
                    const session = await findSession(catalog, idPrefix);
                    files.set(idPrefix, await transcripts.file(session));
                }
                return {
                    action: "transform",
                    text: replaceMentions(event.text, mentions, (mention) =>
                        fileReference(files.get(mention.idPrefix)!),
                    ),
                    images: event.images,
                };
            } catch (error) {
                return refuseInput(ctx, event.text, error);
            }
        }),
    );
}

async function findSession(catalog: SessionCatalog, idPrefix: string): Promise<SessionInfo> {
    const cached = await catalog.list();
    if (cached.some((session) => session.id.startsWith(idPrefix))) {
        return resolveMention(idPrefix, cached);
    }
    // A typed id can name a session that is newer than the cached list.
    return resolveMention(idPrefix, await catalog.reload());
}

/**
 * Building a copy parses the whole session file, so a session that has not changed since its
 * last mention reuses the copy written then.
 */
class TranscriptCache {
    private readonly written = new Map<string, { version: string; file: string }>();

    async file(session: SessionInfo): Promise<string> {
        const stats = await stat(session.path);
        const version = `${stats.ino}:${stats.size}:${stats.mtimeMs}`;
        const cached = this.written.get(session.path);
        if (cached?.version === version && (await exists(cached.file))) return cached.file;
        const file = await writeTranscript(session);
        this.written.set(session.path, { version, file });
        return file;
    }
}

async function writeTranscript(session: SessionInfo): Promise<string> {
    const transcript = buildTranscript(session);
    const directory = join(getAgentDir(), "tmp", "session-refs");
    await mkdir(directory, { recursive: true });
    // One file per session state: earlier messages keep pointing at the copy they referenced.
    const file = join(directory, `${session.id}.${transcript.leafId ?? "empty"}.md`);
    await writeFile(file, transcript.markdown, "utf8");
    return file;
}

async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

/**
 * With a UI, a prompt whose session reference fails is not sent, and the text goes back to the
 * editor to correct. Without one the error is raised; pi reports it and sends the original text.
 */
function refuseInput(ctx: ExtensionContext, text: string, error: unknown): { action: "handled" } {
    if (!ctx.hasUI) throw error;
    ctx.ui.notify(`Prompt not sent. ${errorMessage(error)}`, "error");
    ctx.ui.setEditorText(text);
    return { action: "handled" };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

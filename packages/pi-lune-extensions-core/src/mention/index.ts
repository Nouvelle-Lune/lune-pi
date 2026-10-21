import { createHash } from "node:crypto";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResourceScope } from "../resources/resources.ts";
import { createMentionAutocomplete } from "./autocomplete.ts";
import { SessionCatalog } from "./catalog.ts";
import {
    fileReference,
    findMentions,
    replaceMentions,
    resolveMention,
    type Mention,
} from "./mention.ts";
import type { LocalSession } from "./session.ts";
import { buildTranscript } from "./transcript.ts";

/**
 * `@` lists local sessions with pi's file matches, and `@@` lists sessions only. A picked
 * session becomes a source-specific token. On submit, each such token becomes an `@` reference to
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
                for (const mention of mentions) {
                    if (files.has(mention.token)) continue;
                    const session = await findSession(catalog, mention);
                    files.set(mention.token, await transcripts.file(session));
                }
                return {
                    action: "transform",
                    text: replaceMentions(event.text, mentions, (mention) =>
                        fileReference(files.get(mention.token)!),
                    ),
                    images: event.images,
                };
            } catch (error) {
                return refuseInput(ctx, event.text, error);
            }
        }),
    );
}

async function findSession(catalog: SessionCatalog, mention: Mention): Promise<LocalSession> {
    const cached = await catalog.list();
    if (
        cached.some(
            (session) =>
                session.source === mention.source && session.id.startsWith(mention.idPrefix),
        )
    ) {
        return resolveMention(mention, cached);
    }
    // A typed id can name a session that is newer than the cached list.
    return resolveMention(mention, await catalog.reload());
}

interface TranscriptFiles {
    file: string;
    rawFile: string;
}

/**
 * Building a copy parses the whole session file, so a session that has not changed since its
 * last mention reuses the copy written then.
 */
class TranscriptCache {
    private readonly written = new Map<string, TranscriptFiles & { version: string }>();

    async file(session: LocalSession): Promise<string> {
        const stats = await stat(session.path);
        const version = `${stats.ino}:${stats.size}:${stats.mtimeMs}:${session.name ?? ""}`;
        const cached = this.written.get(session.path);
        if (
            cached?.version === version &&
            (await exists(cached.file)) &&
            (await exists(cached.rawFile))
        ) {
            return cached.file;
        }
        const files = await writeTranscript(session);
        this.written.set(session.path, { version, ...files });
        return files.file;
    }
}

async function writeTranscript(session: LocalSession): Promise<TranscriptFiles> {
    const content = await readFile(session.path);
    const directory = join(tmpdir(), "pi-lune-session-refs");
    await mkdir(directory, { recursive: true });
    // Hash the full snapshot: metadata can change without moving the active branch's leaf.
    const hash = createHash("sha256")
        .update(content)
        .update("\0")
        .update(session.name ?? "")
        .digest("hex");
    const name = `${session.source}.${session.id}.${hash}`;
    const rawFile = join(directory, `${name}.jsonl`);
    await writeFile(rawFile, content, { mode: 0o600 });
    const transcript = buildTranscript({ ...session, path: rawFile });
    const file = join(directory, `${name}.md`);
    await writeFile(file, transcript.markdown, { encoding: "utf8", mode: 0o600 });
    return { file, rawFile };
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

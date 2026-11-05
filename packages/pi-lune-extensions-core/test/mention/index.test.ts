import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
    appendFile,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ResourceScope } from "../../src/resources/index.ts";
import { installMentions } from "../../src/mention/index.ts";
import {
    claudeMessage,
    codexMeta,
    codexMessage,
    jsonl,
} from "../harness/external-session-fixtures.ts";
import { isolateExternalSessions, SessionFile } from "../harness/session-fixtures.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

const ID_A = "01a14931-31bb-7000-8000-aaaaaaaaaaaa";
const ID_B = "01a14931-31bb-7000-8000-bbbbbbbbbbbb";
const ID_C = "01c24931-31bb-7000-8000-cccccccccccc";

async function setup(
    t: TestContext,
    options: { hasUI?: boolean; mode?: string; tempDirName?: string } = {},
) {
    const root = await mkdtemp(path.join(os.tmpdir(), "session-mention-"));
    const externalHomes = isolateExternalSessions(t, root);
    t.after(() => rm(root, { recursive: true, force: true }));
    const tempDir = path.join(root, options.tempDirName ?? "tmp");
    // Cover both POSIX and Windows temp-directory precedence without sharing real temp files.
    const directories = {
        TMPDIR: tempDir,
        TMP: tempDir,
        TEMP: tempDir,
    };
    const previous = new Map(Object.keys(directories).map((key) => [key, process.env[key]]));
    for (const [key, directory] of Object.entries(directories)) process.env[key] = directory;
    t.after(() => {
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    await mkdir(tempDir, { recursive: true });
    const sessionDir = path.join(root, "custom-sessions");
    await mkdir(sessionDir, { recursive: true });

    const handlers = new Map<string, Handler[]>();
    const removed: string[] = [];
    const pi = {
        on(name: string, handler: Handler) {
            handlers.set(name, [...(handlers.get(name) ?? []), handler]);
            return () => {
                removed.push(name);
            };
        },
    } as unknown as ExtensionAPI;

    const notices: { message: string; type: string }[] = [];
    const editorTexts: string[] = [];
    const providers: unknown[] = [];
    const ctx = {
        mode: options.mode ?? "tui",
        hasUI: options.hasUI ?? true,
        ui: {
            notify: (message: string, type: string) => notices.push({ message, type }),
            setEditorText: (text: string) => editorTexts.push(text),
            addAutocompleteProvider: (factory: unknown) => providers.push(factory),
        },
        sessionManager: {
            getSessionDir: () => sessionDir,
            getSessionFile: () => path.join(sessionDir, "current.jsonl"),
        },
    } as unknown as ExtensionContext;

    const resources = new ResourceScope();
    t.after(() => resources.dispose());
    installMentions(pi, resources);

    const call = (name: string, event: unknown) => handlers.get(name)![0]!(event, ctx);
    const writeSession = async (id: string, build?: (file: SessionFile) => void) => {
        const file = new SessionFile(id);
        file.user(`request ${id}`);
        file.assistant(`answer ${id}`);
        build?.(file);
        const target = path.join(sessionDir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
        await writeFile(target, file.jsonl());
        return target;
    };
    return {
        ...externalHomes,
        tempDir,
        call,
        notices,
        editorTexts,
        providers,
        removed,
        resources,
        writeSession,
        handlers,
    };
}

test("session_start in the TUI adds one autocomplete provider per start", async (t) => {
    const env = await setup(t);

    await env.call("session_start", {});
    await env.call("session_start", {});

    assert.equal(env.providers.length, 2);
});

test("session_start outside the TUI adds no autocomplete provider", async (t) => {
    const env = await setup(t, { mode: "rpc" });

    await env.call("session_start", {});

    assert.equal(env.providers.length, 0);
});

test("input without mentions continues unchanged", async (t) => {
    const env = await setup(t);
    await env.call("session_start", {});

    assert.deepEqual(await env.call("input", { text: "plain @file.ts and not@session:abc" }), {
        action: "continue",
    });
});

test("a mention becomes a file reference to a filtered transcript of that session", async (t) => {
    const env = await setup(t);
    const raw = await env.writeSession(ID_A, (file) =>
        file.assistant([
            { type: "thinking", thinking: "PRIVATE" },
            { type: "text", text: "later" },
        ]),
    );
    const rawBefore = await readFile(raw);
    const rawMtimeBefore = (await stat(raw)).mtimeMs;
    await env.call("session_start", {});

    const result = (await env.call("input", {
        text: "Continue from @session:01a14931-31bb please",
        images: [],
    })) as { action: string; text: string; images: unknown[] };

    assert.equal(result.action, "transform");
    assert.deepEqual(result.images, []);
    const match = /^Continue from @(.+\.md) please$/.exec(result.text);
    assert.ok(match, result.text);
    const file = match[1]!;
    assert.ok(file.startsWith(path.join(env.tempDir, "pi-lune-session-refs", "pi." + ID_A + ".")));
    const markdown = await readFile(file, "utf8");
    assert.match(markdown, /\[User\]: request /);
    assert.match(markdown, /\[Assistant\]: later/);
    assert.doesNotMatch(markdown, /PRIVATE/);
    assert.ok(!result.text.includes(raw));
    assert.ok(!markdown.includes(raw));
    const fullCopy = rawCopyFile(markdown);
    assert.equal(path.dirname(fullCopy), path.dirname(file));
    assert.ok((await readFile(fullCopy)).equals(rawBefore));
    assert.match(await readFile(fullCopy, "utf8"), /PRIVATE/);
    assert.notEqual((await stat(fullCopy)).ino, (await stat(raw)).ino);
    await writeFile(fullCopy, "EDITED COPY");
    assert.ok((await readFile(raw)).equals(rawBefore));
    assert.equal((await stat(raw)).mtimeMs, rawMtimeBefore);
});

test("a repeated mention reuses one pair of copies and two sessions get two pairs", async (t) => {
    const env = await setup(t);
    await env.writeSession(ID_A);
    await env.writeSession(ID_C);
    await env.call("session_start", {});

    const result = (await env.call("input", {
        text: `@session:${ID_A.slice(0, 13)} @session:${ID_A.slice(0, 13)} @session:${ID_C.slice(0, 13)}`,
    })) as { text: string };

    const files = result.text.split(" ").map((part) => part.slice(1));
    assert.equal(files[0], files[1]);
    assert.notEqual(files[0], files[2]);
    const written = await readdir(path.join(env.tempDir, "pi-lune-session-refs"));
    assert.equal(written.filter((file) => file.endsWith(".md")).length, 2);
    assert.equal(written.filter((file) => file.endsWith(".jsonl")).length, 2);
    assert.equal(written.length, 4);
});

test("a temp path with whitespace is quoted in the reference", async (t) => {
    const env = await setup(t, { tempDirName: "system temp" });
    await env.writeSession(ID_A);
    await env.call("session_start", {});

    const result = (await env.call("input", { text: `@session:${ID_A.slice(0, 13)}` })) as {
        text: string;
    };

    assert.match(result.text, /^@".* .*\.md"$/);
});

test("an unknown id refuses the prompt, restores the editor text and notifies", async (t) => {
    const env = await setup(t);
    await env.writeSession(ID_A);
    await env.call("session_start", {});
    const text = "look at @session:zzzzzzzzzzzzz";

    const result = await env.call("input", { text });

    assert.deepEqual(result, { action: "handled" });
    assert.deepEqual(env.editorTexts, [text]);
    assert.equal(env.notices.length, 1);
    assert.equal(env.notices[0]!.type, "error");
    assert.match(env.notices[0]!.message, /^Prompt not sent\. No local session matches/);
});

test("an ambiguous id refuses the prompt with the ambiguity message", async (t) => {
    const env = await setup(t);
    await env.writeSession(ID_A);
    await env.writeSession(ID_B);
    await env.call("session_start", {});

    const result = await env.call("input", { text: "@session:01a14931-31bb" });

    assert.deepEqual(result, { action: "handled" });
    assert.match(env.notices[0]!.message, /^Prompt not sent\. .*matches 2 sessions/);
});

test("without a UI a failed mention is rethrown and the editor is untouched", async (t) => {
    const env = await setup(t, { hasUI: false, mode: "print" });
    await env.call("session_start", {});

    await assert.rejects(
        async () => env.call("input", { text: "@session:zzzzzzzzzzzzz" }),
        /No local session matches/,
    );
    assert.deepEqual(env.editorTexts, []);
    assert.deepEqual(env.notices, []);
});

test("a mention before any session started is refused", async (t) => {
    const env = await setup(t);

    const result = await env.call("input", { text: "@session:abcdefabcdef1" });

    assert.deepEqual(result, { action: "handled" });
    assert.match(
        env.notices[0]!.message,
        /^Prompt not sent\. Session mentions have no active session/,
    );
});

test("disposing the resource scope removes both handlers", async (t) => {
    const env = await setup(t);

    await env.resources.dispose();

    assert.deepEqual([...env.removed].sort(), ["input", "session_start"]);
});

const referencedFile = (result: unknown) => {
    const match = /^@(.+\.md)$/.exec((result as { text: string }).text);
    assert.ok(match, JSON.stringify(result));
    return match[1]!;
};

const rawCopyFile = (markdown: string) => {
    const match = /^- Full session copy \(JSONL\): (.+\.jsonl) \(/m.exec(markdown);
    assert.ok(match, markdown);
    return match[1]!;
};

test("a prompt mentioning all sources keeps identical ids separate and attaches exact JSONL copies", async (t) => {
    const env = await setup(t);
    const piPath = await env.writeSession(ID_A);
    const codexDir = path.join(env.codexHome, "sessions");
    const claudeDir = path.join(env.claudeHome, "projects", "--project--");
    await mkdir(codexDir, { recursive: true });
    await mkdir(claudeDir, { recursive: true });
    const codexPath = path.join(codexDir, "rollout-main.jsonl");
    const claudePath = path.join(claudeDir, `${ID_A}.jsonl`);
    await writeFile(
        codexPath,
        jsonl([
            codexMeta(ID_A),
            codexMessage("user", "Codex request"),
            codexMessage("assistant", "Codex answer"),
            { type: "response_item", payload: { type: "reasoning", text: "PRIVATE-CODEX" } },
        ]),
    );
    await writeFile(
        claudePath,
        jsonl([
            claudeMessage(ID_A, "u", null, "user", "Claude request"),
            claudeMessage(ID_A, "a", "u", "assistant", [
                { type: "text", text: "Claude answer" },
                { type: "thinking", thinking: "PRIVATE-CLAUDE" },
            ]),
        ]),
    );
    const originals = await Promise.all(
        [piPath, codexPath, claudePath].map((file) => readFile(file)),
    );
    await env.call("session_start", {});

    const result = (await env.call("input", {
        text: `@session:${ID_A} @codex:${ID_A} @claude:${ID_A} @codex:${ID_A}`,
    })) as { action: string; text: string };

    assert.equal(result.action, "transform");
    const files = result.text.split(" ").map((reference) => reference.slice(1));
    assert.equal(new Set(files).size, 3);
    assert.equal(files[1], files[3]);
    for (const [index, source] of ["pi", "Codex", "Claude Code"].entries()) {
        const markdown = await readFile(files[index]!, "utf8");
        assert.ok(markdown.includes(`# Earlier ${source} session`));
        assert.doesNotMatch(markdown, /PRIVATE-/);
        assert.ok((await readFile(rawCopyFile(markdown))).equals(originals[index]!));
    }
    assert.match(await readFile(files[1]!, "utf8"), /\[User\]: Codex request/);
    assert.match(await readFile(files[2]!, "utf8"), /\[Assistant\]: Claude answer/);
    assert.deepEqual(
        await Promise.all([piPath, codexPath, claudePath].map((file) => readFile(file))),
        originals,
    );
    assert.deepEqual(env.notices, []);
});

test("an indexed Codex rename creates a new snapshot while preserving the earlier title", async (t) => {
    const env = await setup(t);
    const directory = path.join(env.codexHome, "sessions");
    await mkdir(directory, { recursive: true });
    await writeFile(
        path.join(directory, "rollout-main.jsonl"),
        jsonl([codexMeta(ID_A), codexMessage("user", "Question")]),
    );
    const index = path.join(env.codexHome, "session_index.jsonl");
    await writeFile(index, jsonl([{ id: ID_A, thread_name: "Original title" }]));
    await env.call("session_start", {});
    const first = referencedFile(await env.call("input", { text: `@codex:${ID_A}` }));
    await writeFile(index, jsonl([{ id: ID_A, thread_name: "Renamed title" }]));
    // Replacing the Pi session also reloads the external title index without changing the rollout.
    await env.call("session_start", {});
    const second = referencedFile(await env.call("input", { text: `@codex:${ID_A}` }));

    assert.notEqual(first, second);
    assert.match(await readFile(first, "utf8"), /- Title: Original title/);
    assert.match(await readFile(second, "utf8"), /- Title: Renamed title/);
});

for (const source of ["codex", "claude"] as const) {
    test(`${source} parser failures after selection are silent and allow the rest of the prompt to be sent`, async (t) => {
        const env = await setup(t);
        await env.writeSession(ID_C);
        const directory =
            source === "codex"
                ? path.join(env.codexHome, "sessions")
                : path.join(env.claudeHome, "projects", "--project--");
        await mkdir(directory, { recursive: true });
        const target = path.join(
            directory,
            source === "codex" ? "rollout-main.jsonl" : `${ID_A}.jsonl`,
        );
        await writeFile(
            target,
            source === "codex"
                ? jsonl([codexMeta(ID_A), codexMessage("user", "Question")])
                : jsonl([claudeMessage(ID_A, "u", null, "user", "Question")]),
        );
        await env.call("session_start", {});
        const token = `@${source}:${ID_A}`;
        assert.equal(
            ((await env.call("input", { text: token })) as { action: string }).action,
            "transform",
        );
        await writeFile(target, "broken\n");
        const images = [{ type: "image", data: "unchanged" }];

        const result = (await env.call("input", { text: `${token} @session:${ID_C}`, images })) as {
            action: string;
            text: string;
            images: unknown[];
        };

        assert.equal(result.action, "transform");
        assert.ok(result.text.startsWith(`${token} @`));
        assert.ok(result.text.endsWith(".md"));
        assert.deepEqual(result.images, images);
        const repeated = (await env.call("input", { text: token })) as {
            action: string;
            text: string;
        };
        assert.equal(repeated.action, "transform");
        assert.equal(repeated.text, token);
        assert.deepEqual(env.notices, []);
        assert.deepEqual(env.editorTexts, []);
    });
}

test("mentioning a legacy session leaves the original and its full copy unchanged", async (t) => {
    const env = await setup(t);
    const raw = await env.writeSession(ID_A);
    const legacy = (await readFile(raw, "utf8")).replace('"version":3', '"version":2');
    await writeFile(raw, legacy);
    const mtimeBefore = (await stat(raw)).mtimeMs;
    await env.call("session_start", {});

    const markdown = await readFile(
        referencedFile(await env.call("input", { text: `@session:${ID_A.slice(0, 13)}` })),
        "utf8",
    );

    assert.match(markdown, /\[User\]: request /);
    assert.equal(await readFile(rawCopyFile(markdown), "utf8"), legacy);
    assert.equal(await readFile(raw, "utf8"), legacy);
    assert.equal((await stat(raw)).mtimeMs, mtimeBefore);
});

test("a full-copy write failure refuses the prompt and restores the editor text", async (t) => {
    const env = await setup(t);
    await env.writeSession(ID_A);
    await env.call("session_start", {});
    await writeFile(path.join(env.tempDir, "pi-lune-session-refs"), "BLOCKED");
    const text = `@session:${ID_A.slice(0, 13)}`;

    const result = await env.call("input", { text });

    assert.deepEqual(result, { action: "handled" });
    assert.deepEqual(env.editorTexts, [text]);
    assert.equal(env.notices.length, 1);
    assert.equal(env.notices[0]!.type, "error");
    assert.match(env.notices[0]!.message, /^Prompt not sent\. EEXIST/);
});

test("a second mention of an unchanged session reuses the copy written before", async (t) => {
    const env = await setup(t);
    await env.writeSession(ID_A);
    await env.call("session_start", {});
    const first = referencedFile(
        await env.call("input", { text: `@session:${ID_A.slice(0, 13)}` }),
    );
    // A marker no rebuild would write proves the file was not written again.
    await writeFile(first, "MARKER");

    const second = referencedFile(
        await env.call("input", { text: `@session:${ID_A.slice(0, 13)}` }),
    );

    assert.equal(second, first);
    assert.equal(await readFile(second, "utf8"), "MARKER");
});

test("a session that grew since its last mention gets a new copy and the old one stays", async (t) => {
    const env = await setup(t);
    const target = await env.writeSession(ID_A);
    await env.call("session_start", {});
    const first = referencedFile(
        await env.call("input", { text: `@session:${ID_A.slice(0, 13)}` }),
    );
    const firstRawCopy = rawCopyFile(await readFile(first, "utf8"));
    const rawBefore = await readFile(firstRawCopy, "utf8");
    await writeFile(first, "MARKER");
    await appendFile(
        target,
        JSON.stringify({
            type: "message",
            id: "appended1",
            parentId: "e2",
            timestamp: "2026-01-01T00:00:09.000Z",
            message: { role: "user", content: "appended question", timestamp: 9 },
        }) + "\n",
    );

    const second = referencedFile(
        await env.call("input", { text: `@session:${ID_A.slice(0, 13)}` }),
    );

    assert.notEqual(second, first);
    assert.match(await readFile(second, "utf8"), /\[User\]: appended question/);
    assert.equal(await readFile(first, "utf8"), "MARKER");
    const secondRawCopy = rawCopyFile(await readFile(second, "utf8"));
    assert.notEqual(secondRawCopy, firstRawCopy);
    assert.match(await readFile(secondRawCopy, "utf8"), /appended question/);
    assert.equal(await readFile(firstRawCopy, "utf8"), rawBefore);
});

test("a full copy that was deleted is recreated before reusing its Markdown reference", async (t) => {
    const env = await setup(t);
    const raw = await env.writeSession(ID_A);
    await env.call("session_start", {});
    const first = referencedFile(
        await env.call("input", { text: `@session:${ID_A.slice(0, 13)}` }),
    );
    const fullCopy = rawCopyFile(await readFile(first, "utf8"));
    await rm(fullCopy);

    const second = referencedFile(
        await env.call("input", { text: `@session:${ID_A.slice(0, 13)}` }),
    );

    assert.equal(second, first);
    assert.equal(rawCopyFile(await readFile(second, "utf8")), fullCopy);
    assert.ok((await readFile(fullCopy)).equals(await readFile(raw)));
});

test("session metadata changes preserve the earlier full copy even when the leaf stays", async (t) => {
    const env = await setup(t);
    const raw = await env.writeSession(ID_A);
    await env.call("session_start", {});
    const first = referencedFile(
        await env.call("input", { text: `@session:${ID_A.slice(0, 13)}` }),
    );
    const firstMarkdown = await readFile(first, "utf8");
    const firstRawCopy = rawCopyFile(firstMarkdown);
    const before = await readFile(firstRawCopy, "utf8");
    const updated = before.replace('"/work/project"', '"/work/renamed-project"');
    await writeFile(raw, updated);

    const second = referencedFile(
        await env.call("input", { text: `@session:${ID_A.slice(0, 13)}` }),
    );

    assert.notEqual(second, first);
    assert.equal(await readFile(first, "utf8"), firstMarkdown);
    assert.equal(await readFile(firstRawCopy, "utf8"), before);
    assert.equal(await readFile(rawCopyFile(await readFile(second, "utf8")), "utf8"), updated);
});

test("a copy that was deleted is written again at the same path", async (t) => {
    const env = await setup(t);
    await env.writeSession(ID_A);
    await env.call("session_start", {});
    const first = referencedFile(
        await env.call("input", { text: `@session:${ID_A.slice(0, 13)}` }),
    );
    await rm(first);

    const second = referencedFile(
        await env.call("input", { text: `@session:${ID_A.slice(0, 13)}` }),
    );

    assert.equal(second, first);
    assert.match(await readFile(second, "utf8"), /\[User\]: request /);
});

test("a temp directory that was removed is recreated on the next mention", async (t) => {
    const env = await setup(t);
    await env.writeSession(ID_A);
    await env.call("session_start", {});
    const first = referencedFile(
        await env.call("input", { text: `@session:${ID_A.slice(0, 13)}` }),
    );
    await rm(path.join(env.tempDir, "pi-lune-session-refs"), { recursive: true });

    const second = referencedFile(
        await env.call("input", { text: `@session:${ID_A.slice(0, 13)}` }),
    );

    assert.equal(second, first);
    assert.match(await readFile(second, "utf8"), /\[User\]: request /);
});

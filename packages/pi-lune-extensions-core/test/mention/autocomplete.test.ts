import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type {
    AutocompleteItem,
    AutocompleteProvider,
    AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import { createMentionAutocomplete, SESSION_TRIGGER } from "../../src/mention/autocomplete.ts";
import { SessionCatalog } from "../../src/mention/catalog.ts";
import {
    claudeMessage,
    codexMeta,
    codexMessage,
    jsonl,
} from "../harness/external-session-fixtures.ts";
import { isolateExternalSessions, SessionFile } from "../harness/session-fixtures.ts";

const HOUR = 3_600_000;

interface SessionSpec {
    /** At least 13 characters, so the mention value is the first 13. */
    id: string;
    project?: string;
    name?: string;
    /** First user message, which is also the title unless the session is named. */
    text?: string;
    /** A later assistant message, searched only by `@@query`. */
    more?: string;
    ageMs?: number;
    /** A header-only file has no messages. */
    empty?: boolean;
}

const mentionValue = (spec: SessionSpec) => `@session:${spec.id.slice(0, 13)}`;
const file = (name: string, dir = ""): AutocompleteItem => ({
    value: `@${dir}${name}`,
    label: name,
    description: `${dir}${name}`,
});
const values = (result: AutocompleteSuggestions | null) => result?.items.map((i) => i.value);

async function environment(
    t: TestContext,
    options: {
        sessions?: SessionSpec[];
        /** Items pi's provider returns for an `@` token; null makes it return null. */
        files?: AutocompleteItem[] | null;
        /** What pi's provider reports as the prefix; defaults to the token's own. */
        providerPrefix?: string;
        current?: string;
        load?: boolean;
    } = {},
) {
    const root = await mkdtemp(path.join(os.tmpdir(), "mention-autocomplete-"));
    const externalHomes = isolateExternalSessions(t, root);
    t.after(() => rm(root, { recursive: true, force: true }));
    const previous = process.env["PI_CODING_AGENT_DIR"];
    process.env["PI_CODING_AGENT_DIR"] = path.join(root, "agent");
    t.after(() => {
        if (previous === undefined) delete process.env["PI_CODING_AGENT_DIR"];
        else process.env["PI_CODING_AGENT_DIR"] = previous;
    });
    const sessionDir = path.join(root, "custom-sessions");
    await mkdir(sessionDir, { recursive: true });
    const now = Date.now();
    const paths = new Map<string, string>();
    for (const spec of options.sessions ?? []) {
        const session = new SessionFile(spec.id, `/work/${spec.project ?? "project"}`);
        if (!spec.empty) {
            session.message({
                role: "user",
                content: spec.text ?? `question ${spec.id}`,
                timestamp: now - (spec.ageMs ?? HOUR),
            });
            if (spec.more) {
                session.message({
                    role: "assistant",
                    content: [{ type: "text", text: spec.more }],
                    timestamp: now - (spec.ageMs ?? HOUR),
                });
            }
            if (spec.name) session.add({ type: "session_info", name: spec.name });
        }
        const target = path.join(sessionDir, `${spec.id}.jsonl`);
        await writeFile(target, session.jsonl());
        paths.set(spec.id, target);
    }
    const catalog = new SessionCatalog(sessionDir, () => assert.fail("no background error"));
    t.after(() => catalog.dispose());
    if (options.load !== false) await catalog.reload();

    const underlying = {
        suggestionCalls: [] as unknown[][],
        applyCalls: [] as unknown[][],
        results: [] as (AutocompleteSuggestions | null)[],
    };
    const applied = { lines: ["applied by the underlying provider"], cursorLine: 0, cursorCol: 7 };
    const provider: AutocompleteProvider = {
        async getSuggestions(lines, cursorLine, cursorCol, request) {
            underlying.suggestionCalls.push([lines, cursorLine, cursorCol, request]);
            // The prefix pi's own provider would report for the text before the cursor.
            const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
            const prefix = /(?:^|[\s([{<`，])(@[^\s"]*)$/u.exec(before)?.[1];
            let result: AutocompleteSuggestions | null;
            if (!prefix) result = ownResult;
            else if (options.files === null) result = null;
            else {
                result = {
                    items: options.files ?? [],
                    prefix: options.providerPrefix ?? prefix,
                };
            }
            underlying.results.push(result);
            return result;
        },
        applyCompletion(...args) {
            underlying.applyCalls.push(args);
            return applied;
        },
    };
    const ownResult: AutocompleteSuggestions = {
        items: [{ value: "/help", label: "/help" }],
        prefix: "/h",
    };
    const mention = createMentionAutocomplete(provider, {
        catalog,
        currentSessionFile: options.current ? paths.get(options.current) : undefined,
    });
    const suggest = (text: string, signal = new AbortController().signal) =>
        mention.getSuggestions([text], 0, text.length, { signal, force: false });
    return { mention, suggest, underlying, applied, ownResult, catalog, ...externalHomes };
}

test("external sessions appear in @ and @@ with source labels, body search and source-specific completions", async (t) => {
    const env = await environment(t, { sessions: [{ id: "pi-source-session001" }] });
    const id = "01a14931-31bb-7000-8000-aaaaaaaaaaaa";
    const codexDir = path.join(env.codexHome, "sessions");
    const claudeDir = path.join(env.claudeHome, "projects", "--project--");
    await mkdir(codexDir, { recursive: true });
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
        path.join(codexDir, "rollout-main.jsonl"),
        jsonl([
            codexMeta(id),
            codexMessage("user", "First question"),
            codexMessage("assistant", "Searchable body"),
        ]),
    );
    await writeFile(
        path.join(claudeDir, `${id}.jsonl`),
        jsonl([
            claudeMessage(id, "u", null, "user", "Other question"),
            claudeMessage(id, "a", "u", "assistant", "Searchable body"),
        ]),
    );
    await env.catalog.reload();

    const plain = await env.suggest("@");
    assert.deepEqual(
        plain?.items.map((item) => item.label.split(" ")[0]),
        ["[pi]", "[claude]", "[codex]"],
    );
    assert.deepEqual(
        (await env.suggest("@@"))?.items.map((item) => item.label.split(" ")[0]),
        ["[pi]", "[claude]", "[codex]"],
    );
    assert.deepEqual(values(await env.suggest("@@Searchable")), [
        `@claude:${id.slice(0, 13)}`,
        `@codex:${id.slice(0, 13)}`,
    ]);
    assert.deepEqual(values(await env.suggest("@@codex")), [`@codex:${id.slice(0, 13)}`]);
    const result = env.mention.applyCompletion(["@"], 0, 1, plain!.items[1]!, "@");
    assert.deepEqual(result.lines, [`@claude:${id.slice(0, 13)} `]);
});

test("text without an @ token goes to the underlying provider and its answer comes back as is", async (t) => {
    const env = await environment(t, { sessions: [{ id: "alpha-session-1" }] });
    const controller = new AbortController();

    const result = await env.mention.getSuggestions(["/he"], 0, 3, {
        signal: controller.signal,
        force: false,
    });

    assert.strictEqual(result, env.ownResult);
    assert.equal(env.underlying.suggestionCalls.length, 1);
    assert.deepEqual(env.underlying.suggestionCalls[0]!.slice(0, 3), [["/he"], 0, 3]);
});

test("a bare @ lists the three newest sessions in front of the files", async (t) => {
    const sessions: SessionSpec[] = [
        { id: "oldest-session-1", ageMs: 5 * HOUR },
        { id: "newest-session-2", ageMs: 1 * HOUR, project: "web", name: "Fix the login" },
        { id: "third-session-0003", ageMs: 3 * HOUR },
        { id: "second-session-4", ageMs: 2 * HOUR },
    ];
    const env = await environment(t, { sessions, files: [file("a.ts"), file("b.ts")] });

    const result = await env.suggest("@");

    assert.equal(result?.prefix, "@");
    assert.deepEqual(values(result), [
        mentionValue(sessions[1]!),
        mentionValue(sessions[3]!),
        mentionValue(sessions[2]!),
        "@a.ts",
        "@b.ts",
    ]);
    assert.deepEqual(result?.items[0], {
        value: "@session:newest-sessio",
        label: "[pi]  1h  web",
        description: "Fix the login",
    });
});

test("files whose name contains the query come before the session rows, other files after", async (t) => {
    const session: SessionSpec = { id: "parse-session-01", name: "parse the config" };
    const env = await environment(t, {
        sessions: [session],
        files: [
            file("x.ts", "src/parser/"), // matches by path only
            file("parser.ts", "src/"),
            { value: "@src/parser/", label: "parser/", description: "src/parser" },
            file("Parser.md"),
        ],
    });

    const result = await env.suggest("@par");

    assert.deepEqual(values(result), [
        "@src/parser.ts",
        "@src/parser/",
        "@Parser.md",
        mentionValue(session),
        "@src/parser/x.ts",
    ]);
});

test("a title or id match ranks above a project match, and message text is not searched", async (t) => {
    const byProject: SessionSpec = { id: "project-session-1", project: "parser-app", ageMs: HOUR };
    const byTitle: SessionSpec = { id: "title-session-0001", name: "Parser bug", ageMs: 9 * HOUR };
    const byText: SessionSpec = {
        id: "txt-session-00001",
        text: "hello",
        more: "deep in the parser",
        ageMs: 2 * HOUR,
    };
    const env = await environment(t, { sessions: [byProject, byTitle, byText], files: [] });

    const result = await env.suggest("@parser");

    assert.deepEqual(values(result), [mentionValue(byTitle), mentionValue(byProject)]);
});

test("a query with a folder shows no session rows", async (t) => {
    const env = await environment(t, {
        sessions: [{ id: "alpha-session-1", name: "src/par and my notes" }],
        files: [file("par.ts", "src/")],
    });

    const result = await env.suggest("@src/par");

    assert.strictEqual(result, env.underlying.results[0]);
    assert.deepEqual(values(result), ["@src/par.ts"]);
});

for (const text of ["a@b", "email@x.com", '@"quoted path', "@foo，bar", "plain words"]) {
    test(`text that is not an @ token (${JSON.stringify(text)}) goes to the underlying provider`, async (t) => {
        const env = await environment(t, {
            sessions: [{ id: "alpha-session-1", name: "foo bar quoted b x.com" }],
            files: [file("a.ts")],
        });

        const result = await env.suggest(text);

        assert.equal(env.underlying.suggestionCalls.length, 1);
        assert.strictEqual(result, env.underlying.results[0]);
        assert.equal(
            result?.items.some((item) => item.value.startsWith("@session:")) ?? false,
            false,
        );
    });
}

for (const [text, prefix] of [
    ["(@src/x", "@src/x"],
    ["`@x", "@x"],
    ["看看，@abc", "@abc"],
    ["foo @abc", "@abc"],
    ["[@abc", "@abc"],
] as const) {
    test(`the token in ${JSON.stringify(text)} is ${prefix}`, async (t) => {
        const env = await environment(t, {
            sessions: [{ id: "alpha-session-1", name: "abc and x notes" }],
            files: [file("other.ts")],
        });

        const result = await env.suggest(text);

        assert.equal(result?.prefix, prefix);
        // A folder in the query gets no session rows; anything else gets the matching one.
        const hasSession = result?.items.some((item) => item.value.startsWith("@session:"));
        assert.equal(hasSession, !prefix.includes("/"));
    });
}

test("@@ with an empty query lists the 50 newest sessions and never asks the underlying provider", async (t) => {
    const sessions = Array.from({ length: 55 }, (_, index) => ({
        id: `bulk-sess-${String(index).padStart(3, "0")}`,
        ageMs: (index + 1) * HOUR,
    }));
    const env = await environment(t, { sessions, files: [file("a.ts")] });

    const result = await env.suggest(SESSION_TRIGGER);

    assert.equal(result?.prefix, "@@");
    assert.equal(result?.items.length, 50);
    assert.deepEqual(values(result)!.slice(0, 2), [
        mentionValue(sessions[0]!),
        mentionValue(sessions[1]!),
    ]);
    assert.ok(values(result)!.every((value) => value.startsWith("@session:")));
    assert.equal(env.underlying.suggestionCalls.length, 0);
});

test("@@query searches message text and ignores case, which a plain @query does not", async (t) => {
    const inText: SessionSpec = {
        id: "txt-session-00001",
        text: "hello",
        more: "We discussed the Quokka cache",
    };
    const other: SessionSpec = { id: "other-session-0001", text: "unrelated" };
    const env = await environment(t, { sessions: [inText, other], files: [] });

    const scoped = await env.suggest("@@quokka");
    const plain = await env.suggest("@quokka");
    const none = await env.suggest("@@zzz");

    assert.deepEqual(values(scoped), [mentionValue(inText)]);
    assert.equal(scoped?.prefix, "@@quokka");
    // No session row is added, so pi's own (here empty) result comes back.
    assert.deepEqual(plain?.items, []);
    assert.equal(none, null);
});

test("@@query after other text replaces only the @@ token", async (t) => {
    const session: SessionSpec = { id: "alpha-session-1", name: "alpha plan" };
    const env = await environment(t, { sessions: [session, { id: "bravo-session-2" }], files: [] });

    const result = (await env.suggest("foo @@alp"))!;
    const applied = env.mention.applyCompletion(
        ["foo @@alp"],
        0,
        9,
        result.items[0]!,
        result.prefix,
    );

    assert.equal(result.prefix, "@@alp");
    assert.deepEqual(values(result), [mentionValue(session)]);
    assert.deepEqual(applied, {
        lines: [`foo ${mentionValue(session)} `],
        cursorLine: 0,
        cursorCol: `foo ${mentionValue(session)} `.length,
    });
    assert.equal(env.underlying.suggestionCalls.length, 0);
});

test("a plain @query returns the provider's own result when there are no session rows", async (t) => {
    const quoted = await environment(t, {
        sessions: [{ id: "alpha-session-1", name: "my notes" }],
        files: [file("my file.ts")],
    });
    const folder = await environment(t, {
        sessions: [{ id: "alpha-session-1", name: "src/par" }],
        files: [file("par.ts", "src/")],
    });
    const unmatched = await environment(t, {
        sessions: [{ id: "alpha-session-1", name: "alpha" }],
        files: [file("zzz.ts")],
    });

    const results = [
        await quoted.suggest('@"my'),
        await folder.suggest("@src/par"),
        await unmatched.suggest("@zzz"),
    ];

    assert.strictEqual(results[0], quoted.underlying.results[0]);
    assert.strictEqual(results[1], folder.underlying.results[0]);
    assert.strictEqual(results[2], unmatched.underlying.results[0]);
});

test("the running session and sessions without messages are left out", async (t) => {
    const running: SessionSpec = { id: "running-session-01" };
    const empty: SessionSpec = { id: "empty-session-0001", empty: true };
    const shown: SessionSpec = { id: "shown-session-0001" };
    const env = await environment(t, {
        sessions: [running, empty, shown],
        files: [],
        current: running.id,
    });

    const bare = await env.suggest("@");
    const scoped = await env.suggest("@@");

    assert.deepEqual(values(bare), [mentionValue(shown)]);
    assert.deepEqual(values(scoped), [mentionValue(shown)]);
});

test("completing a session row inserts its value and a space and moves the cursor after it", async (t) => {
    const session: SessionSpec = { id: "alpha-session-1", name: "alpha" };
    const env = await environment(t, { sessions: [session], files: [file("a.ts")] });
    const result = (await env.suggest("see @al"))!;
    const row = result.items[0]!;

    const actual = env.mention.applyCompletion(["see @al tail"], 0, 7, row, result.prefix);

    assert.deepEqual(actual, {
        lines: [`see ${mentionValue(session)}  tail`],
        cursorLine: 0,
        cursorCol: `see ${mentionValue(session)} `.length,
    });
    assert.equal(env.underlying.applyCalls.length, 0);
});

test("completing a file row is left to the underlying provider", async (t) => {
    const env = await environment(t, {
        sessions: [{ id: "alpha-session-1", name: "alpha" }],
        files: [file("alpha.ts")],
    });
    const result = (await env.suggest("@al"))!;
    const fileRow = result.items.find((item) => item.value === "@alpha.ts")!;

    const actual = env.mention.applyCompletion(["@al"], 0, 3, fileRow, "@al");

    assert.strictEqual(actual, env.applied);
    assert.deepEqual(env.underlying.applyCalls, [[["@al"], 0, 3, fileRow, "@al"]]);
});

test("a list the underlying provider made for another prefix is returned unchanged", async (t) => {
    const env = await environment(t, {
        sessions: [{ id: "alpha-session-1", name: "alpha" }],
        files: [file("other")],
        providerPrefix: "other-prefix",
    });

    const result = await env.suggest("@al");

    assert.strictEqual(result, env.underlying.results[0]);
    assert.deepEqual(result, { items: [file("other")], prefix: "other-prefix" });
});

test("an aborted request returns null", async (t) => {
    const env = await environment(t, {
        sessions: [{ id: "alpha-session-1", name: "alpha" }],
        files: [file("alpha.ts")],
    });
    const controller = new AbortController();
    controller.abort();

    const result = await env.suggest("@al", controller.signal);

    assert.equal(result, null);
});

test("an empty or not yet loaded catalog neither delays nor changes the file results", async (t) => {
    const env = await environment(t, {
        sessions: [{ id: "alpha-session-1" }],
        files: [file("a.ts")],
        load: false,
    });

    const result = await env.suggest("@");

    assert.deepEqual(result, { items: [file("a.ts")], prefix: "@" });
    // The lookup started the first load in the background; let it finish before cleanup.
    await env.catalog.reload();
});

test("no matches from any source returns null", async (t) => {
    const env = await environment(t, { files: null });

    assert.equal(await env.suggest("@nothing"), null);
});

import assert from "node:assert/strict";
import {
    lstatSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { MemoryOperationError } from "../../src/core/errors.ts";
import {
    isProviderId,
    ModelConfig,
    modelsFileSignature,
    normalizeBaseUrl,
    providerEntry,
    readModelsDocument,
    writeModelsDocument,
} from "../../src/dreaming/providers/models-json.ts";

const PROVIDER = {
    name: "Acme",
    baseUrl: "http://127.0.0.1:3425/v1",
    api: "openai-completions",
    models: [{ id: "acme-1", name: "Acme One", contextWindow: 200000 }],
};

function tempDir(t: TestContext): string {
    const dir = mkdtempSync(join(tmpdir(), "lune-memory-test-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function assertOperationError(run: () => unknown, path: string, message: RegExp): void {
    assert.throws(run, (error: unknown) => {
        assert.ok(error instanceof MemoryOperationError);
        assert.match(error.message, message);
        assert.ok(error.message.includes(path), error.message);
        return true;
    });
}

test("a missing models.json reads as an empty document", (t) => {
    const path = join(tempDir(t), "models.json");

    const actual = readModelsDocument(path);

    assert.deepEqual(actual, { providers: {} });
});

test("comments and trailing commas parse and unknown fields survive the read", (t) => {
    const path = join(tempDir(t), "models.json");
    writeFileSync(
        path,
        `{
            // A hand-written entry keeps its notes.
            "$schema": "https://example.com/models.schema.json",
            "providers": {
                "acme": {
                    "baseUrl": "http://127.0.0.1:3425/v1",
                    "api": "openai-completions",
                    "note": "hand written",
                    "models": [{ "id": "acme-1", }],
                },
            },
        }\n`,
    );

    const actual = readModelsDocument(path);

    assert.deepEqual(actual["$schema"], "https://example.com/models.schema.json");
    assert.deepEqual(providerEntry(actual, "acme"), {
        baseUrl: "http://127.0.0.1:3425/v1",
        api: "openai-completions",
        note: "hand written",
        models: [{ id: "acme-1" }],
    });
    assert.equal(providerEntry(actual, "other"), undefined);
});

test("a file that does not parse or has the wrong shape names its path", (t) => {
    const path = join(tempDir(t), "models.json");

    writeFileSync(path, '{ "providers": ');
    assertOperationError(() => readModelsDocument(path), path, /Cannot parse/u);

    for (const content of ["[]", '{ "providers": [] }', '"text"']) {
        writeFileSync(path, content);
        assertOperationError(
            () => readModelsDocument(path),
            path,
            /must be an object with a "providers" object/u,
        );
    }
});

test("a write keeps unknown top-level and provider fields", (t) => {
    const path = join(tempDir(t), "models.json");
    writeFileSync(
        path,
        JSON.stringify({
            $schema: "https://example.com/models.schema.json",
            customTop: { keep: true },
            providers: {
                acme: { ...PROVIDER, customProviderField: { keep: true }, models: [] },
            },
        }),
    );
    const document = readModelsDocument(path);
    const entry = providerEntry(document, "acme");
    assert.ok(entry);
    entry.models = PROVIDER.models;

    writeModelsDocument(path, document);

    const expected = {
        $schema: "https://example.com/models.schema.json",
        customTop: { keep: true },
        providers: { acme: { ...PROVIDER, customProviderField: { keep: true } } },
    };
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), expected);
});

test("a symlinked models.json stays a symlink and the target keeps its mode", (t) => {
    const dir = tempDir(t);
    const target = join(dir, "pi-models.json");
    const link = join(dir, "models.json");
    writeFileSync(target, JSON.stringify({ providers: { acme: PROVIDER } }), { mode: 0o640 });
    symlinkSync(target, link);
    const modeBefore = statSync(target).mode & 0o777;

    const document = readModelsDocument(link);
    const entry = providerEntry(document, "acme");
    assert.ok(entry);
    entry.models = [{ id: "acme-2" }];
    writeModelsDocument(link, document);

    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(realpathSync(link), realpathSync(target));
    assert.equal(statSync(target).mode & 0o777, modeBefore);
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")).providers.acme.models, [
        { id: "acme-2" },
    ]);
});

test("a new models.json has mode 0600", (t) => {
    const path = join(tempDir(t), "nested", "models.json");

    writeModelsDocument(path, { providers: { acme: PROVIDER } });

    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { providers: { acme: PROVIDER } });
});

test("isProviderId accepts the ids of a model ref and rejects the others", () => {
    for (const valid of ["acme", "a.b-c_1", "0day", "a".repeat(64)]) {
        assert.equal(isProviderId(valid), true, valid);
    }
    for (const invalid of ["", "-acme", ".acme", "acme corp", "a".repeat(65), "ac mé"]) {
        assert.equal(isProviderId(invalid), false, invalid);
    }
});

test("normalizeBaseUrl drops trailing slashes and rejects a non-HTTP URL", () => {
    assert.equal(normalizeBaseUrl("http://127.0.0.1:3425/v1/"), "http://127.0.0.1:3425/v1");
    assert.equal(normalizeBaseUrl(" https://example.com// "), "https://example.com");

    assert.throws(() => normalizeBaseUrl("ftp://example.com/v1"), MemoryOperationError);
    assert.throws(() => normalizeBaseUrl("127.0.0.1:3425/v1"), /Not a URL/u);
});

test("normalizeBaseUrl rejects userinfo and a query string or fragment without echoing a secret", () => {
    const secret = "sk-secret-in-userinfo";
    const rejected: Array<[string, RegExp]> = [
        [
            `https://user:${secret}@example.invalid/v1`,
            /The base URL has no user name or password\. Give the key as the API key/u,
        ],
        [`https://example.invalid/v1?api_key=${secret}`, /no query string or fragment/u],
        ["https://example.invalid/v1#frag", /no query string or fragment/u],
        ["https://example.invalid/v1?", /no query string or fragment/u],
    ];

    for (const [value, message] of rejected) {
        assert.throws(
            () => normalizeBaseUrl(value),
            (error: unknown) => {
                assert.ok(error instanceof MemoryOperationError);
                assert.match(error.message, message);
                assert.ok(!error.message.includes(secret), error.message);
                return true;
            },
        );
    }

    const unparsable = `not a url ${secret}`;
    assert.throws(
        () => normalizeBaseUrl(unparsable),
        (error: unknown) => {
            assert.ok(error instanceof MemoryOperationError);
            assert.equal(error.message, "Not a URL. Give an absolute http:// or https:// base URL");
            assert.ok(!error.message.includes(secret), error.message);
            return true;
        },
    );
});

test("a JSON parse error keeps its location and never quotes the secret", (t) => {
    const path = join(tempDir(t), "models.json");
    // An unquoted value makes the JSON.parse message quote the input next to the error.
    const secret = "sk-secret";
    writeFileSync(path, `{ "providers": { "acme": ${secret} } }`);

    const configError = ModelConfig.load(path).getError() ?? "";
    assert.match(configError, /Failed to parse models\.json: Invalid JSON syntax/u);
    assert.ok(configError.includes(path), configError);
    assert.ok(!configError.includes(secret), configError);

    assert.throws(
        () => readModelsDocument(path),
        (error: unknown) => {
            assert.ok(error instanceof MemoryOperationError);
            assert.match(error.message, /Cannot parse .*Invalid JSON syntax/u);
            assert.ok(error.message.includes(path), error.message);
            assert.ok(!error.message.includes(secret), error.message);
            return true;
        },
    );
});

test("modelsFileSignature reports a missing file and changes after a write", (t) => {
    const dir = tempDir(t);
    const path = join(dir, "models.json");
    assert.equal(modelsFileSignature(path), "missing");

    writeModelsDocument(path, { providers: {} });
    const before = modelsFileSignature(path);
    writeModelsDocument(path, { providers: { acme: PROVIDER } });

    assert.notEqual(before, "missing");
    assert.notEqual(modelsFileSignature(path), before);
});

test("ModelConfig.load reads comments and trailing commas", (t) => {
    const path = join(tempDir(t), "models.json");
    writeFileSync(
        path,
        `{
            "providers": {
                // trailing comma and comment
                "acme": { "baseUrl": "http://127.0.0.1:3425/v1", "api": "openai-completions" },
            },
        }\n`,
    );

    const config = ModelConfig.load(path);

    assert.equal(config.getError(), undefined);
    assert.deepEqual(config.getProviderIds(), ["acme"]);
    assert.equal(config.getProvider("acme")?.baseUrl, "http://127.0.0.1:3425/v1");
});

test("ModelConfig.load reports an invalid schema with the path and loads no provider", (t) => {
    const path = join(tempDir(t), "models.json");
    writeFileSync(
        path,
        JSON.stringify({ providers: { acme: { name: "Acme", models: [{ id: "" }] } } }),
    );

    const config = ModelConfig.load(path);

    assert.equal(config.getProvider("acme"), undefined);
    assert.deepEqual(config.getProviderIds(), []);
    const error = config.getError() ?? "";
    assert.match(error, /Invalid models\.json schema/u);
    assert.ok(error.includes(path), error);
});

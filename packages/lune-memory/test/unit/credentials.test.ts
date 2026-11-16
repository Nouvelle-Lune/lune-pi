import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { FileCredentialStore, setApiKey } from "../../src/dreaming/credentials.ts";

const FAKE_KEY = "test-key-not-real";

function tempStore(t: TestContext): FileCredentialStore {
    const dir = mkdtempSync(join(tmpdir(), "lune-memory-test-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return new FileCredentialStore(join(dir, "nested", "credentials.json"));
}

test("an API key is stored in a file with mode 0600 and read back", async (t) => {
    const store = tempStore(t);

    await setApiKey(store, "acme", `  ${FAKE_KEY}  `);

    const actual = await store.read("acme");
    assert.deepEqual(actual, { type: "api_key", key: FAKE_KEY });
    assert.equal(statSync(store.path).mode & 0o777, 0o600);
});

test("list returns provider ids and types, never the secret", async (t) => {
    const store = tempStore(t);
    await setApiKey(store, "acme", FAKE_KEY);
    await store.modify("oauth-co", async () => ({
        type: "oauth",
        refresh: "refresh-not-real",
        access: "access-not-real",
        expires: 1,
    }));

    const actual = await store.list();

    const expected = [
        { providerId: "acme", type: "api_key" },
        { providerId: "oauth-co", type: "oauth" },
    ];
    assert.deepEqual(actual, expected);
    const serialized = JSON.stringify(actual);
    for (const secret of [FAKE_KEY, "refresh-not-real", "access-not-real"]) {
        assert.ok(!serialized.includes(secret));
    }
});

test("an empty key removes the stored credential, and removing an unknown one is a no-op", async (t) => {
    const store = tempStore(t);
    await setApiKey(store, "acme", FAKE_KEY);
    await setApiKey(store, "other", FAKE_KEY);

    await setApiKey(store, "acme", "   ");
    await store.delete("missing");

    assert.deepEqual(await store.list(), [{ providerId: "other", type: "api_key" }]);
    assert.equal(await store.read("acme"), undefined);
});

test("delete removes one provider and keeps the file mode", async (t) => {
    const store = tempStore(t);
    await setApiKey(store, "acme", FAKE_KEY);
    await setApiKey(store, "other", FAKE_KEY);

    await store.delete("acme");

    assert.deepEqual(await store.list(), [{ providerId: "other", type: "api_key" }]);
    assert.equal(statSync(store.path).mode & 0o777, 0o600);
});

test("a missing file reads as empty", async (t) => {
    const store = tempStore(t);

    assert.deepEqual(await store.list(), []);
    assert.equal(await store.read("acme"), undefined);
});

test("invalid entries in the file are ignored and a corrupt file raises an error", async (t) => {
    const store = tempStore(t);
    await setApiKey(store, "seed", FAKE_KEY);
    writeFileSync(
        store.path,
        JSON.stringify({ good: { type: "api_key", key: FAKE_KEY }, bad: { type: "other" }, n: 3 }),
    );

    assert.deepEqual(await store.list(), [{ providerId: "good", type: "api_key" }]);

    writeFileSync(store.path, "{not json");
    await assert.rejects(async () => store.list(), /Cannot read/u);
});

test("concurrent modifications are serialized and none is lost", async (t) => {
    const store = tempStore(t);

    await Promise.all(["a", "b", "c", "d"].map((id) => setApiKey(store, id, `${FAKE_KEY}-${id}`)));

    const ids = (await store.list()).map((entry) => entry.providerId).sort();
    assert.deepEqual(ids, ["a", "b", "c", "d"]);
    assert.doesNotThrow(() => JSON.parse(readFileSync(store.path, "utf8")));
});

test("an aborted signal rejects before any change", async (t) => {
    const store = tempStore(t);
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(async () => store.read("acme", { signal: controller.signal }), /aborted/u);
    await assert.rejects(
        store.modify("acme", async () => ({ type: "api_key", key: FAKE_KEY }), {
            signal: controller.signal,
        }),
        /aborted/u,
    );
    assert.deepEqual(await store.list(), []);
});

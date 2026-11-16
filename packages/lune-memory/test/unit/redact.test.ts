import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { redact, safeErrorText, storedContent } from "../../src/ingest/redact.ts";

// Fake secrets are assembled at runtime so no literal credential sits in the source.
const fake = {
    anthropic: `sk-${"ant-"}${"a1B2c3D4".repeat(4)}`,
    aws: `AKIA${"ABCDEFGH12345678"}`,
    github: `ghp_${"A1b2C3d4E5".repeat(4)}`,
    slack: `xoxb-${"1234567890"}-${"abcdefghij"}`,
    npm: `npm_${"a1B2c3".repeat(6)}`,
};

describe("redact", () => {
    it("leaves normal text unchanged and counts nothing", () => {
        const input = "Run `npm test` in src/app.ts, token count is 5 and the password policy doc.";
        const actual = redact(input);
        assert.deepEqual(actual, { text: input, count: 0 });
    });

    for (const [name, secret] of Object.entries(fake)) {
        it(`replaces a ${name} key`, () => {
            const actual = redact(`value ${secret} end`);
            assert.equal(actual.text, "value [redacted] end");
            assert.equal(actual.count, 1);
        });
    }

    it("replaces a private key block", () => {
        const body = "MIIB\nabc123\n";
        const input = `a -----BEGIN RSA PRIVATE KEY-----\n${body}-----END RSA PRIVATE KEY----- b`;
        assert.equal(redact(input).text, "a [redacted private key] b");
    });

    it("keeps the scheme of a bearer header and hides the credential", () => {
        const actual = redact("Authorization: Bearer abcdef1234567890xyz");
        assert.ok(!actual.text.includes("abcdef1234567890xyz"));
        assert.ok(actual.count >= 1);
    });

    it("keeps the key name and hides the value of an assignment", () => {
        const expected = 'password = [redacted] and "api_key": [redacted]';
        const actual = redact('password = hunter2hunter2 and "api_key": "supersecretvalue"');
        assert.equal(actual.text, expected);
        assert.equal(actual.count, 2);
    });

    it("hides credentials embedded in a URL", () => {
        const actual = redact("clone https://user:pa55word@example.com/repo.git");
        assert.equal(actual.text, "clone https://[redacted]@example.com/repo.git");
    });

    it("counts each replacement", () => {
        const actual = redact(`${fake.github} and ${fake.aws}`);
        assert.equal(actual.count, 2);
    });
});

describe("safeErrorText", () => {
    it("redacts, joins lines and trims to 500 characters", () => {
        const long = `fail ${fake.github}\nsecond line ${"x".repeat(600)}`;
        const actual = safeErrorText(new Error(long));
        assert.ok(!actual.includes("ghp_"));
        assert.ok(!actual.includes("\n"));
        assert.equal(actual.length, 500);
        assert.ok(actual.endsWith("…"));
    });

    it("accepts a non-Error value", () => {
        assert.equal(safeErrorText("plain  text"), "plain text");
    });
});

describe("storedContent", () => {
    it("keeps text with a secret as written and counts no redaction", () => {
        const input = `token ${fake.github} and password = hunter2hunter2`;
        const actual = storedContent(input);
        assert.deepEqual(actual, { text: input, count: 0 });
    });
});

describe("error text keeps its redaction", () => {
    it("hides a secret in the error text of a failure", () => {
        const actual = safeErrorText(new Error(`request failed with ${fake.anthropic}`));
        assert.equal(actual, "request failed with [redacted]");
    });
});

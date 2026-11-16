import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeRemote } from "../../src/projects/git.ts";

describe("normalizeRemote default ports", () => {
    const cases: Array<[string, string, string | null]> = [
        ["ssh 22", "ssh://git@github.com:22/org/repo.git", "github.com/org/repo"],
        ["https 443", "https://github.com:443/org/repo.git", "github.com/org/repo"],
        ["http 80", "http://github.com:80/org/repo.git", "github.com/org/repo"],
        ["git 9418", "git://github.com:9418/org/repo.git", "github.com/org/repo"],
        ["git+ssh 22", "git+ssh://git@github.com:22/org/repo.git", "github.com/org/repo"],
        ["ssh+git 22", "ssh+git://git@github.com:22/org/repo.git", "github.com/org/repo"],
        ["no port", "https://github.com/org/repo.git", "github.com/org/repo"],
    ];
    for (const [name, url, expected] of cases) {
        it(`drops the default port: ${name}`, () => {
            assert.equal(normalizeRemote(url), expected);
        });
    }

    it("keeps a port that is not the default of its protocol", () => {
        assert.equal(
            normalizeRemote("ssh://git@host.example:2222/org/repo.git"),
            "host.example:2222/org/repo",
        );
        assert.equal(
            normalizeRemote("https://host.example:8443/org/repo"),
            "host.example:8443/org/repo",
        );
    });

    it("compares a port with the default of its own protocol, not of another one", () => {
        // 443 is the default for https, not for ssh. 22 is the default for ssh, not for https.
        assert.equal(
            normalizeRemote("ssh://git@host.example:443/org/repo"),
            "host.example:443/org/repo",
        );
        assert.equal(
            normalizeRemote("https://host.example:22/org/repo"),
            "host.example:22/org/repo",
        );
    });

    it("treats a git+ssh or ssh+git URL as ssh for a non-default port", () => {
        assert.equal(
            normalizeRemote("git+ssh://git@host.example:2222/o/r"),
            "host.example:2222/o/r",
        );
        assert.equal(
            normalizeRemote("ssh+git://git@host.example:2222/o/r"),
            "host.example:2222/o/r",
        );
    });

    it("treats scp syntax as ssh and keeps it equal to the ssh URL with port 22", () => {
        assert.equal(normalizeRemote("git@github.com:org/repo.git"), "github.com/org/repo");
        assert.equal(
            normalizeRemote("git@github.com:org/repo.git"),
            normalizeRemote("ssh://git@github.com:22/org/repo.git"),
        );
    });
});

describe("normalizeRemote host, user and suffix", () => {
    it("lowercases the host and keeps the case of the path", () => {
        assert.equal(normalizeRemote("https://GitHub.COM/Org/Repo.git"), "github.com/Org/Repo");
    });

    it("removes the user, the .git suffix and trailing slashes", () => {
        assert.equal(
            normalizeRemote("https://user@github.com/org/repo.git/"),
            "github.com/org/repo",
        );
        assert.equal(normalizeRemote("ssh://deploy@github.com/org/repo"), "github.com/org/repo");
    });

    it("gives the same result for the common forms of one remote", () => {
        const forms = [
            "git@GitHub.com:Org/Repo.git",
            "https://github.com/Org/Repo",
            "ssh://git@github.com:22/Org/Repo.git",
            "https://github.com:443/Org/Repo.git",
        ];
        assert.deepEqual(new Set(forms.map(normalizeRemote)), new Set(["github.com/Org/Repo"]));
    });

    it("gives null for local paths, file URLs and empty input", () => {
        for (const value of [
            "/srv/git/repo.git",
            "./repo",
            "../repo",
            "file:///srv/repo.git",
            "",
            "  ",
        ]) {
            assert.equal(normalizeRemote(value), null, value);
        }
    });

    it("gives null for a host with no path", () => {
        assert.equal(normalizeRemote("https://github.com"), null);
    });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { acquireSettings } from "@lune_99/pi-lune-extensions-core/settings/advanced";
import { Value } from "typebox/value";

import { DOCK_STYLES } from "../../src/dock-footer.ts";
import { SETTINGS_ID, dockSchema, dockSettings } from "../../src/dock-settings.ts";
import { createAgentFixture } from "../harness.ts";

const DEFAULTS = {
    enabled: true,
    displayMode: "detail",
    style: "ruled",
    showModel: true,
    showWorkspace: true,
    showUsage: true,
    hidden: [],
    order: {},
};

describe("dock settings schema", () => {
    it("is stored under the pi-dock namespace", () => {
        assert.equal(SETTINGS_ID, "pi-dock");
        assert.equal(dockSettings.id, "pi-dock");
    });

    it("defaults to an enabled, ruled dock showing everything", () => {
        const actual = Value.Create(dockSchema);

        assert.deepEqual(actual, DEFAULTS);
    });

    it("reads those defaults when nothing is stored", async (t) => {
        const { cwd } = await createAgentFixture(t);
        const lease = await acquireSettings(dockSettings, { cwd, projectTrusted: true });
        t.after(() => lease.release());

        const actual = lease.settings.snapshot();

        assert.deepEqual(actual, DEFAULTS);
    });

    it("accepts every dock style and rejects any other", () => {
        for (const style of DOCK_STYLES) {
            assert.equal(Value.Check(dockSchema, { ...DEFAULTS, style }), true, style);
        }
        assert.equal(Value.Check(dockSchema, { ...DEFAULTS, style: "neon" }), false);
    });

    it("accepts the three presentation levels and rejects any other", () => {
        for (const displayMode of ["base", "detail", "full"]) {
            assert.equal(Value.Check(dockSchema, { ...DEFAULTS, displayMode }), true, displayMode);
        }
        assert.equal(Value.Check(dockSchema, { ...DEFAULTS, displayMode: "tiny" }), false);
    });

    it("requires booleans for the switches", () => {
        for (const key of ["enabled", "showModel", "showWorkspace", "showUsage"]) {
            assert.equal(Value.Check(dockSchema, { ...DEFAULTS, [key]: "yes" }), false, key);
        }
    });

    it("accepts a list of unique, nonempty plugin ids as the hidden plugins", () => {
        assert.equal(Value.Check(dockSchema, { ...DEFAULTS, hidden: ["shell", "ask"] }), true);
        assert.equal(Value.Check(dockSchema, { ...DEFAULTS, hidden: ["shell", "shell"] }), false);
        assert.equal(Value.Check(dockSchema, { ...DEFAULTS, hidden: [""] }), false);
        assert.equal(Value.Check(dockSchema, { ...DEFAULTS, hidden: [1] }), false);
    });

    it("accepts integer positions per plugin and rejects fractions", () => {
        assert.equal(Value.Check(dockSchema, { ...DEFAULTS, order: { shell: -2, ask: 3 } }), true);
        assert.equal(Value.Check(dockSchema, { ...DEFAULTS, order: { shell: 1.5 } }), false);
        assert.equal(Value.Check(dockSchema, { ...DEFAULTS, order: { shell: "first" } }), false);
    });

    it("rejects an invalid stored value instead of falling back to the default", async (t) => {
        const { cwd, writeScope } = await createAgentFixture(t);
        await writeScope("global", { hidden: ["shell", "shell"] });

        await assert.rejects(
            acquireSettings(dockSettings, { cwd, projectTrusted: true }),
            /hidden/,
        );
    });
});

describe("stored dock settings", () => {
    it("are read by a real Core binding on top of the defaults", async (t) => {
        const { cwd, writeScope } = await createAgentFixture(t);
        await writeScope("global", {
            enabled: false,
            displayMode: "full",
            hidden: ["shell"],
            order: { shell: -2, ask: 7 },
        });

        const lease = await acquireSettings(dockSettings, { cwd, projectTrusted: true });
        t.after(() => lease.release());
        const actual = lease.settings.snapshot();

        assert.deepEqual(actual, {
            ...DEFAULTS,
            enabled: false,
            displayMode: "full",
            hidden: ["shell"],
            order: { shell: -2, ask: 7 },
        });
    });

    it("accept the base presentation level", async (t) => {
        const { cwd, writeScope } = await createAgentFixture(t);
        await writeScope("global", { displayMode: "base" });

        const lease = await acquireSettings(dockSettings, { cwd, projectTrusted: true });
        t.after(() => lease.release());

        assert.equal(lease.settings.get("displayMode"), "base");
    });

    it("reject a corrupt settings file and leave it untouched", async (t) => {
        const { cwd, writeRaw, readRaw, settingsPath } = await createAgentFixture(t);
        await writeRaw(settingsPath("global"), "{ corrupt");

        await assert.rejects(
            acquireSettings(dockSettings, { cwd, projectTrusted: true }),
            SyntaxError,
        );

        assert.equal(await readRaw(settingsPath("global")), "{ corrupt");
    });
});

import assert from "node:assert/strict";
import { test } from "node:test";
import * as sdk from "../../src/index.ts";
import * as settingsSdk from "../../src/settings/index.ts";
import * as advanced from "../../src/settings/advanced.ts";
import * as panel from "../../src/panel/index.ts";
import * as panelHost from "../../src/panel/host.ts";
import * as panelTui from "../../src/panel/tui.ts";
import * as testing from "../../src/testing/index.ts";

// @ts-expect-error Backend SPI types are available only from /settings/backend.
import type { SettingsBackend as RootBackend } from "../../src/index.ts";
// @ts-expect-error The consumer settings entry does not export backend SPI types.
import type { SettingsBackend as ConsumerBackend } from "../../src/settings/index.ts";

test("consumer entry points isolate low-level acquisition in the advanced entry", () => {
    for (const entry of [sdk, settingsSdk]) {
        assert.equal("acquireSettings" in entry, false);
        assert.equal(typeof entry.bindSettings, "function");
        assert.equal(typeof entry.defineSettings, "function");
    }
    assert.equal(typeof advanced.acquireSettings, "function");
});

test("test helpers live only in the dedicated testing entry", () => {
    assert.deepEqual(Object.keys(testing), ["createSettingsSandbox"]);
    for (const entry of [sdk, settingsSdk, advanced, panel])
        assert.equal("createSettingsSandbox" in entry, false);
});

test("root and domain entries expose only final consumer capabilities without removed framework APIs", () => {
    const expected = [
        "ResourceScope",
        "bindSettings",
        "createDockContribution",
        "defineSettings",
        "defineSettingsPanel",
        "readGlobalSettings",
        "registerSettingsPanel",
        "scopedExtension",
    ];
    assert.deepEqual(Object.keys(sdk).sort(), expected.sort());
    for (const entry of [sdk, settingsSdk, panel]) {
        for (const name of [
            "defineExtension",
            "installExtension",
            "listModels",
            "listAvailableModels",
            "findModel",
            "refreshModels",
        ])
            assert.equal(name in entry, false);
    }
    assert.equal("modelChoices" in sdk, false);
    assert.equal(typeof panel.modelChoices, "function");
    assert.equal("openSettingsPanel" in panel, false);
    assert.equal(typeof panelTui.openSettingsPanel, "function");
    for (const name of [
        "createSettingsSection",
        "createDefinedSettingsSection",
        "registerSettingsSection",
        "getSettingsPanelRegistry",
    ]) {
        assert.equal(name in panel, false);
        assert.equal(typeof panelHost[name as keyof typeof panelHost], "function");
    }
});

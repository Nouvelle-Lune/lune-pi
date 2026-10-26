import assert from "node:assert/strict";
import { test } from "node:test";

import type { ToolInfo } from "@earendil-works/pi-coding-agent";

import { addExtensionTools, type ToolCatalog } from "../../src/catalog.ts";
import { isSyntheticPath, listExtensionTools } from "../../src/extension-tools.ts";
import { SUBAGENT_TOOL_NAMES } from "../../src/tools/subagent-tools.ts";
import { toolInfo } from "./support.ts";

function list(tools: ToolInfo[], runTools: string[] = [], projectTrusted = true) {
    return listExtensionTools(tools, { runTools: new Set(runTools), projectTrusted });
}

test("a tool from an extension file is listed with its name, description and file", () => {
    const actual = list([toolInfo("ext_tool", { path: "/ext/a.ts" })]);

    assert.deepEqual(actual, [
        { name: "ext_tool", description: "The ext_tool tool.", path: "/ext/a.ts" },
    ]);
});

test("tools without an extension file are left out: builtin, inline and sdk paths", () => {
    const actual = list([
        toolInfo("a", { path: "builtin:read" }),
        toolInfo("b", { path: "<inline:1>" }),
        toolInfo("c", { path: "<sdk:x>" }),
    ]);

    assert.deepEqual(actual, []);
});

test("hidden tools are left out; other exposures are listed", () => {
    const actual = list([
        toolInfo("hidden_tool", { exposure: "hidden" }),
        toolInfo("deferred_tool", { exposure: "deferred" }),
        toolInfo("codemode_tool", { exposure: "codemode" }),
    ]).map((tool) => tool.name);

    assert.deepEqual(actual, ["deferred_tool", "codemode_tool"]);
});

test("a name the run has itself stays the run's, even when an extension replaces it", () => {
    const actual = list([toolInfo("bash"), toolInfo("ext_tool")], ["bash", "read"]).map(
        (tool) => tool.name,
    );

    assert.deepEqual(actual, ["ext_tool"]);
});

test("report, MCP tools and the four subagent tools are left out", () => {
    const actual = list([
        toolInfo("report"),
        toolInfo("mcp__server__tool"),
        ...SUBAGENT_TOOL_NAMES.map((name) => toolInfo(name)),
        toolInfo("ext_tool"),
    ]).map((tool) => tool.name);

    assert.deepEqual(actual, ["ext_tool"]);
});

test("project tools need a trusted project; user tools do not", () => {
    const tools = [toolInfo("project_tool", { scope: "project" }), toolInfo("user_tool")];

    assert.deepEqual(
        list(tools, [], true).map((tool) => tool.name),
        ["project_tool", "user_tool"],
    );
    assert.deepEqual(
        list(tools, [], false).map((tool) => tool.name),
        ["user_tool"],
    );
});

test("isSyntheticPath tells files from builtin and angle-bracket paths", () => {
    assert.equal(isSyntheticPath("builtin:mcp"), true);
    assert.equal(isSyntheticPath("<inline:1>"), true);
    assert.equal(isSyntheticPath("<sdk:x>"), true);
    assert.equal(isSyntheticPath("/ext/a.ts"), false);
});

test("addExtensionTools appends the tools with source extension and keeps the catalog", () => {
    const catalog: ToolCatalog = {
        tools: [{ name: "read", description: "Read files.", source: "native" }],
        errors: ["e"],
    } as ToolCatalog;
    const actual = addExtensionTools(catalog, [
        { name: "ext_tool", description: "Does it.", path: "/ext/a.ts" },
    ]);

    assert.deepEqual(actual.tools, [
        { name: "read", description: "Read files.", source: "native" },
        { name: "ext_tool", description: "Does it.", source: "extension" },
    ]);
    assert.deepEqual(actual.errors, ["e"]);
    assert.equal(catalog.tools.length, 1);
});

#!/usr/bin/env node
// node:sqlite prints an ExperimentalWarning on first use. It is expected here.
const emit = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
    const text = typeof warning === "string" ? warning : warning?.message;
    const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
    if (type === "ExperimentalWarning" && /SQLite/i.test(String(text))) return;
    return emit.call(process, warning, ...rest);
};
const { main } = await import("../dist/cli.js");
process.exitCode = await main(["daemon", ...process.argv.slice(2)]);

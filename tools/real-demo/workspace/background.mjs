import { existsSync } from "node:fs";
import { setTimeout } from "node:timers/promises";

const task = process.argv[2];
if (!["index", "assets"].includes(task)) throw new Error("Unknown background task: " + task);
console.log(
    task === "index"
        ? "Indexing local session transcripts"
        : "Building documentation preview assets",
);
for (let step = 1; step <= 120; step++) {
    await setTimeout(250);
    console.log(
        task +
            " · batch " +
            String(step).padStart(3, "0") +
            " · " +
            (task === "index" ? step * 16 + " records indexed" : step * 4 + " assets processed"),
    );
    if (existsSync("finish-background")) {
        console.log("Completed " + step + " batches.");
        break;
    }
}

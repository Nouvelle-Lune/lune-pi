import { retry, retryPolicy } from "./retry.mjs";

console.log("Retry policy: " + JSON.stringify(retryPolicy));
const result = await retry(async (attempt) => {
    if (attempt < 3) {
        console.log("Request " + attempt + ": temporary connection reset; retrying...");
        throw Object.assign(new Error("Temporary connection reset"), { transient: true });
    }
    console.log("Request " + attempt + ": connected");
    return { status: 200, message: "Session index is available" };
});
console.log(JSON.stringify(result, null, 2));

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";

const urlPattern = /https?:\/\/[^\s<>"'`|，。；：！？、」』】（）【】《》『』「」]+/g;
// A path needs a slash, so prose words and dotted code names never cost a file-system check.
// The lookbehind keeps `host:path` remotes and the tail of other URL schemes unlinked.
const pathPattern =
    /(?<![\w.@+~/:-])(?:~?(?:\/[\w.@+-]+)+|[\w.@+-]+(?:\/[\w.@+-]+)+)\/?(?::\d+(?:-\d+)?){0,2}/g;
const linkPattern = new RegExp(`${urlPattern.source}|${pathPattern.source}`, "g");
// File URLs cannot carry an editor location, so `:line[:column]` and `#anchor` suffixes are dropped.
const location = /(?::\d+(?:-\d+)?){1,2}$|#.*$/;

function trimUrl(value: string) {
    let url = value.replace(/[.,;:!?}"']+$/, "");
    for (const [open, close] of [
        ["(", ")"],
        ["[", "]"],
    ] as const) {
        while (url.endsWith(close) && url.split(close).length > url.split(open).length)
            url = url.slice(0, -1);
    }
    return url;
}

/** Without OSC 8 support Pi prints a link's target beside its text, so paths stay unlinked. */
export function hyperlinksEnabled(): boolean {
    return getCapabilities().hyperlinks;
}

/** A file URL for an existing file or directory, resolved from `cwd`. */
export function fileHref(path: string, cwd: string): string | undefined {
    const target = path.replace(location, "");
    // A bare `/` or `~` is punctuation in prose far more often than a link to the root.
    if (!/\w/.test(target)) return undefined;
    const absolute = target.startsWith("~/")
        ? join(homedir(), target.slice(1))
        : resolve(cwd, target);
    return existsSync(absolute) ? pathToFileURL(absolute).href : undefined;
}

/**
 * Replace each URL in plain text, and each existing path when `cwd` is given. `text` excludes
 * trailing punctuation, which stays outside the replacement.
 */
export function replaceLinks(
    value: string,
    cwd: string | undefined,
    render: (text: string, href: string) => string,
): string {
    return value.replace(linkPattern, (match) => {
        const url = /^https?:\/\//.test(match);
        const text = url ? trimUrl(match) : match.replace(/\.+$/, "");
        if (!text) return match;
        const href = url ? text : cwd === undefined ? undefined : fileHref(text, cwd);
        return href ? render(text, href) + match.slice(text.length) : match;
    });
}

/** Plain text gains OSC 8 links for URLs and existing paths, so Cmd+click opens them. */
export function linkText(value: string, cwd: string): string {
    return hyperlinksEnabled() ? replaceLinks(value, cwd, hyperlink) : value;
}

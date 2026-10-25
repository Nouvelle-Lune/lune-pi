import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";

const urlPattern = /https?:\/\/[^\s<>"'`|，。；：！？、」』】（）【】《》『』「」]+/g;
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

/** A file URL for an explicit local reference to an existing file or directory. */
export function fileHref(path: string, cwd: string): string | undefined {
    const target = path.replace(location, "");
    // URI schemes, scp targets and network shares must not become local existence checks.
    if (
        !/\w/.test(target) ||
        /^[\\/]{2}/.test(path) ||
        /^[^/\\]*@[^/\\]*:/.test(path) ||
        (/^[^/\\]*:/.test(target) && !isAbsolute(target)) ||
        /[\u0000-\u001f\u007f]/.test(path)
    )
        return undefined;
    const absolute = target.startsWith("~/")
        ? join(homedir(), target.slice(1))
        : resolve(cwd, target);
    return existsSync(absolute) ? pathToFileURL(absolute).href : undefined;
}

/** Replace HTTP(S) URLs in plain text, leaving trailing punctuation outside the replacement. */
export function replaceLinks(
    value: string,
    render: (text: string, href: string) => string,
): string {
    return value.replace(urlPattern, (match) => {
        const text = trimUrl(match);
        return text ? render(text, text) + match.slice(text.length) : match;
    });
}

/** Plain text gains OSC 8 links only for HTTP(S) URLs. */
export function linkText(value: string): string {
    return hyperlinksEnabled() ? replaceLinks(value, hyperlink) : value;
}

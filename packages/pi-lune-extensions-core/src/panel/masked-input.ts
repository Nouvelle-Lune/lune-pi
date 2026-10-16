/**
 * Single-line input for secret settings; the typed text is never rendered.
 *
 * It starts empty and is never seeded with the stored value, so a secret cannot be
 * revealed or partially edited. Cursor movement is intentionally absent: with the
 * text hidden, editing anywhere but the end could not be verified by the user.
 */
import {
    CURSOR_MARKER,
    decodeKittyPrintable,
    matchesKey,
    truncateToWidth,
    visibleWidth,
    type Component,
    type Focusable,
} from "@earendil-works/pi-tui";

const PROMPT = "> ";
const MASK = "•";
const PLACEHOLDER = "Type a new value";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export class MaskedInput implements Component, Focusable {
    focused = false;
    onSubmit?: (value: string) => void;
    onEscape?: () => void;
    private value = "";
    private pasteBuffer = "";
    private isInPaste = false;
    private readonly dim: (text: string) => string;

    constructor(dim: (text: string) => string) {
        this.dim = dim;
    }

    getValue(): string {
        return this.value;
    }

    handleInput(data: string): void {
        if (data.includes(PASTE_START)) {
            this.isInPaste = true;
            this.pasteBuffer = "";
            data = data.replace(PASTE_START, "");
        }
        if (this.isInPaste) {
            this.pasteBuffer += data;
            const end = this.pasteBuffer.indexOf(PASTE_END);
            if (end === -1) return;
            const pasted = this.pasteBuffer.slice(0, end);
            const remaining = this.pasteBuffer.slice(end + PASTE_END.length);
            this.isInPaste = false;
            this.pasteBuffer = "";
            this.value += pasted.replace(/[\r\n]/g, "");
            if (remaining) this.handleInput(remaining);
            return;
        }
        if (matchesKey(data, "escape")) {
            this.onEscape?.();
        } else if (matchesKey(data, "enter") || data === "\n") {
            this.onSubmit?.(this.value);
        } else if (matchesKey(data, "backspace")) {
            const graphemes = [...segmenter.segment(this.value)];
            const last = graphemes[graphemes.length - 1];
            if (last) this.value = this.value.slice(0, last.index);
        } else if (matchesKey(data, "ctrl+u")) {
            this.value = "";
        } else {
            const printable = decodeKittyPrintable(data);
            if (printable !== undefined) {
                this.value += printable;
                return;
            }
            // Escape sequences and other control input must not leak into the secret.
            const hasControlChars = [...data].some((char) => {
                const code = char.charCodeAt(0);
                return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
            });
            if (!hasControlChars) this.value += data;
        }
    }

    render(width: number): string[] {
        const available = width - visibleWidth(PROMPT);
        if (available <= 0) return [truncateToWidth(PROMPT, width, "")];
        const marker = this.focused ? CURSOR_MARKER : "";
        const cursor = `${marker}\x1b[7m \x1b[27m`;
        let text: string;
        if (this.value) {
            const count = [...segmenter.segment(this.value)].length;
            // The last column is reserved for the cursor.
            text = MASK.repeat(Math.min(count, available - 1)) + cursor;
        } else {
            text = cursor + this.dim(truncateToWidth(PLACEHOLDER, available - 1, ""));
        }
        return [PROMPT + text + " ".repeat(Math.max(0, available - visibleWidth(text)))];
    }

    invalidate(): void {}
}

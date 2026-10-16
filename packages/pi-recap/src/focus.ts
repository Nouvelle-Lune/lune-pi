import { StdinBuffer } from "@earendil-works/pi-tui";

export interface TerminalInputSource {
    on(event: "data", listener: (data: string | Buffer) => void): unknown;
    removeListener(event: "data", listener: (data: string | Buffer) => void): unknown;
}

export function observeTerminalFocus(
    source: TerminalInputSource,
    onFocus: (focus: "in" | "out") => void,
): () => void {
    // StdinBuffer reassembles reports that arrive split across reads.
    const buffer = new StdinBuffer();
    buffer.on("data", (data) => {
        if (data === "\x1b[I") onFocus("in");
        else if (data === "\x1b[O") onFocus("out");
    });
    // Fullscreen consumes these before extension listeners; observing stdin preserves host handling.
    const input = (data: string | Buffer) => buffer.process(data);
    source.on("data", input);
    // Release is idempotent because settings and session changes both detach the listener.
    let disposed = false;
    return () => {
        if (disposed) return;
        disposed = true;
        source.removeListener("data", input);
        buffer.destroy();
    };
}

import { copyToClipboard, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { TextPanel } from "./text-panel.ts";

export type OutputContent = () => string | Promise<string>;

/** The active renderer session owns one output overlay and closes it during reload or deactivation. */
export function createOutputBrowser(context: Pick<ExtensionContext, "ui">) {
    let disposed = false;
    let active: { close?: () => void } | undefined;
    return {
        open(title: string, content: OutputContent) {
            if (disposed || active) return;
            const entry: { close?: () => void } = {};
            active = entry;
            void context.ui
                .custom<void>(
                    (tui, _theme, _keys, done) => {
                        let closed = false;
                        const finish = () => {
                            if (closed) return;
                            closed = true;
                            if (active === entry) active = undefined;
                            done();
                        };
                        entry.close = finish;
                        let panel: TextPanel | undefined;
                        void Promise.resolve()
                            .then(content)
                            .then((text) => {
                                if (closed || disposed) return;
                                panel = new TextPanel({
                                    title,
                                    items: [{ label: "Full output", content: text }],
                                    theme: () => context.ui.theme,
                                    rows: () => tui.terminal.rows,
                                    repaint: () => tui.requestRender(),
                                    close: finish,
                                    copy: copyToClipboard,
                                    notify: (message, level) => context.ui.notify(message, level),
                                });
                                tui.requestRender();
                            })
                            .catch((error) => {
                                if (closed || disposed) return;
                                context.ui.notify(`Full output: ${String(error)}`, "error");
                                finish();
                            });
                        if (disposed) queueMicrotask(finish);
                        return {
                            render: (width: number) =>
                                panel?.render(width) ?? [
                                    truncateToWidth(
                                        context.ui.theme.fg("dim", "Loading full output…"),
                                        width,
                                    ),
                                ],
                            invalidate: () => panel?.invalidate(),
                            handleInput(data: string) {
                                if (matchesKey(data, Key.escape)) finish();
                                else panel?.handleInput(data);
                            },
                            handleMouse: (event: TuiMouseEvent) => panel?.handleMouse(event),
                        };
                    },
                    {
                        overlay: true,
                        overlayOptions: { width: "94%", maxHeight: "94%", anchor: "center" },
                    },
                )
                .catch((error) => {
                    if (!disposed) context.ui.notify(`Full output: ${String(error)}`, "error");
                })
                .finally(() => {
                    if (active === entry) active = undefined;
                });
        },
        dispose() {
            disposed = true;
            active?.close?.();
        },
    };
}

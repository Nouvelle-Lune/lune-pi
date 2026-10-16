/**
 * Pi themes color text and cards only; the rest of the screen is the terminal's own background,
 * so a light palette on a dark terminal is dark text on black and vice versa. OSC 11/10 set the
 * terminal's default background and foreground to the palette's; OSC 111/110 return the profile's.
 *
 * The painted state belongs to the terminal, not to an extension instance: it outlives `/reload`
 * and session replacement, and the process exit hook must reset it whichever instance painted.
 */
export interface TerminalWriter {
    write(data: string): void;
}

export interface TerminalColors {
    readonly background: string;
    readonly foreground: string;
}

interface Painted {
    readonly terminal: TerminalWriter;
    readonly key: string;
}
interface Slot {
    painted?: Painted;
    exitHook?: boolean;
}

const SLOT = Symbol.for("nouvelle-lune.pi-core-theme.terminal-background");
const slot: Slot = ((globalThis as Record<symbol, Slot | undefined>)[SLOT] ??= {});
const RESET = "\x1b]111\x07\x1b]110\x07";

const resetOnExit = () => {
    const painted = slot.painted;
    slot.painted = undefined;
    try {
        painted?.terminal.write(RESET);
    } catch {
        // The terminal may already be gone; there is nothing left to restore.
    }
};

/**
 * Paint `colors` as the terminal's defaults, or restore the profile's colors when undefined.
 * Without a `terminal`, the one that painted last is reused, so a restore works from an instance
 * that never mounted a widget.
 */
export function setTerminalColors(terminal: TerminalWriter | undefined, colors?: TerminalColors) {
    const key = colors && `${colors.background}/${colors.foreground}`;
    if (key === slot.painted?.key) return;
    const target = terminal ?? slot.painted?.terminal;
    if (!target) return;
    target.write(
        colors ? `\x1b]11;${colors.background}\x07\x1b]10;${colors.foreground}\x07` : RESET,
    );
    slot.painted = key ? { terminal: target, key } : undefined;
    // Pi's own terminal restore does not know about these colors; without this the shell keeps them.
    if (key && !slot.exitHook) {
        slot.exitHook = true;
        process.once("exit", resetOnExit);
    }
}

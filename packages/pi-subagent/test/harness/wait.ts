/** Rejects after `ms`, so a hang fails fast with a name instead of the runner's timeout. */
export async function within<T>(promise: Promise<T>, what: string, ms = 20_000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms: ${what}`)), ms);
    });

    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

export interface Gate {
    readonly opened: Promise<void>;
    open(): void;
}

export function createGate(): Gate {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
        open = resolve;
    });

    return { opened, open };
}

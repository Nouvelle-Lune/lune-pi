import { existsSync, readFileSync } from "node:fs";

import type {
    AuthOperationOptions,
    Credential,
    CredentialInfo,
    CredentialStore,
} from "@earendil-works/pi-ai";

import { writeFileAtomic } from "../core/util.ts";
import { validateApiKey } from "./http-headers.ts";

const FILE_MODE = 0o600;

function isCredential(value: unknown): value is Credential {
    if (!value || typeof value !== "object") return false;
    const type = (value as { type?: unknown }).type;
    return type === "api_key" || type === "oauth";
}

function checkSignal(options?: AuthOperationOptions): void {
    if (options?.signal?.aborted) throw new Error("Credential operation aborted");
}

/**
 * Credential store of the Dreaming model in one JSON file with mode 0600. It is separate from
 * the credentials of the harnesses. Writes are serialized, so an OAuth refresh cannot race.
 */
export class FileCredentialStore implements CredentialStore {
    readonly path: string;
    private chain: Promise<unknown> = Promise.resolve();

    constructor(path: string) {
        this.path = path;
    }

    private readAll(): Record<string, Credential> {
        if (!existsSync(this.path)) return {};
        let raw: unknown;
        try {
            raw = JSON.parse(readFileSync(this.path, "utf8"));
        } catch (error) {
            throw new Error(`Cannot read ${this.path}: ${(error as Error).message}`, {
                cause: error,
            });
        }
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
        const result: Record<string, Credential> = {};
        for (const [providerId, value] of Object.entries(raw as Record<string, unknown>)) {
            if (isCredential(value)) result[providerId] = value;
        }
        return result;
    }

    private writeAll(credentials: Record<string, Credential>): void {
        writeFileAtomic(this.path, `${JSON.stringify(credentials, null, 2)}\n`, FILE_MODE);
    }

    private enqueue<T>(task: () => Promise<T>): Promise<T> {
        const next = this.chain.then(task, task);
        this.chain = next.catch(() => undefined);
        return next;
    }

    /** Errors reject the promise. They do not throw synchronously. */
    read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
        return Promise.resolve().then(() => {
            checkSignal(options);
            return this.readAll()[providerId];
        });
    }

    list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
        return Promise.resolve().then(() => {
            checkSignal(options);
            return Object.entries(this.readAll()).map(([providerId, credential]) => ({
                providerId,
                type: credential.type,
            }));
        });
    }

    modify(
        providerId: string,
        fn: (current: Credential | undefined) => Promise<Credential | undefined>,
        options?: AuthOperationOptions,
    ): Promise<Credential | undefined> {
        return this.enqueue(async () => {
            checkSignal(options);
            const current = this.readAll()[providerId];
            const next = await fn(current);
            checkSignal(options);
            const all = this.readAll();
            if (next) all[providerId] = next;
            else delete all[providerId];
            this.writeAll(all);
            return next;
        });
    }

    delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
        return this.enqueue(async () => {
            checkSignal(options);
            const all = this.readAll();
            if (!(providerId in all)) return;
            delete all[providerId];
            this.writeAll(all);
        });
    }
}

/** Validate before persisting a key or its provider; transport errors can echo invalid values. */
export function normalizeApiKey(key: string): string {
    const value = key.trim();
    validateApiKey(value);
    return value;
}

/** Store an API key for a provider. An empty key removes the credential. */
export async function setApiKey(
    store: CredentialStore,
    providerId: string,
    key: string,
): Promise<void> {
    const value = normalizeApiKey(key);
    if (!value) {
        await store.delete(providerId);
        return;
    }
    await store.modify(providerId, async () => ({ type: "api_key", key: value }));
}

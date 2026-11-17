import { validateHeaderName, validateHeaderValue } from "node:http";

import type { ProviderHeaders } from "@earendil-works/pi-ai";

import { MemoryOperationError } from "../core/errors.ts";

/** SDK header errors can include the value, so reject invalid secrets before handing them off. */
export function validateApiKey(key: string): void {
    if (/[\r\n]/u.test(key)) throw new MemoryOperationError("The key must be a single line");
    try {
        validateHeaderValue("Authorization", key);
    } catch {
        throw new MemoryOperationError("The key is not a valid HTTP header value");
    }
}

export function validateRequestHeaders(headers: ProviderHeaders | undefined): void {
    for (const [name, value] of Object.entries(headers ?? {})) {
        try {
            validateHeaderName(name);
            if (value !== null) validateHeaderValue(name, value);
        } catch {
            throw new MemoryOperationError("The request has an invalid HTTP header");
        }
    }
}

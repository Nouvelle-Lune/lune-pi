/**
 * Clipboard paste for the answer editor, in the order pi's own editor uses for
 * `app.clipboard.pasteImage`: copied files paste as their paths, an image is saved to a
 * temporary file and pastes as that path, and plain text comes last. The model reads a pasted
 * image through its path, as it does after a paste into pi's editor.
 *
 * pi does not export its clipboard reader, so this reads pi-tui's native clipboard, which is
 * the reader pi itself uses for images and files on macOS and Windows.
 */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { convertToPng } from "@earendil-works/pi-coding-agent";
import { getNativeClipboard } from "@earendil-works/pi-tui";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

export interface ClipboardPaste {
    text: string;
    /** A path has to be kept apart from the words around it; text is inserted as copied. */
    isPath: boolean;
}

/** `undefined` when the clipboard holds nothing to paste; a failed read rejects. */
export async function readClipboardPaste(): Promise<ClipboardPaste | undefined> {
    const clipboard = getNativeClipboard();

    if (!clipboard) {
        throw new Error("no native clipboard is available on this system");
    }

    const paths = await clipboard.getFilePaths?.();

    if (paths && paths.length > 0) {
        // The path becomes answer text that the terminal draws, so a control character in a
        // file name could rewrite what the panel shows.
        if (paths.some((path) => /\p{Cc}/u.test(path))) {
            throw new Error("a copied file path contains control characters");
        }

        return { text: paths.join("\n"), isPath: true };
    }

    const image = await clipboard.getImage();

    if (image && image.length > 0) {
        return { text: await saveClipboardImage(image), isPath: true };
    }

    const text = await clipboard.getText();

    return text ? { text, isPath: false } : undefined;
}

async function saveClipboardImage(bytes: Uint8Array): Promise<string> {
    let extension = imageExtension(bytes);
    let data = bytes;

    if (extension === undefined) {
        // A clipboard can hold formats a model cannot read, such as the BMP that Windows puts
        // there; pi converts those to PNG as well.
        const png = await convertToPng(
            Buffer.from(bytes).toString("base64"),
            "application/octet-stream",
        );

        if (!png) {
            throw new Error("the clipboard image format is not supported");
        }

        data = Buffer.from(png.data, "base64");
        extension = "png";
    }

    const path = join(tmpdir(), `pi-clipboard-${randomUUID()}.${extension}`);

    await writeFile(path, data);

    return path;
}

/** The image formats a model receives without conversion. */
function imageExtension(bytes: Uint8Array): string | undefined {
    if (startsWithBytes(bytes, PNG_SIGNATURE)) {
        return "png";
    }

    if (startsWithBytes(bytes, JPEG_SIGNATURE)) {
        return "jpg";
    }

    if (startsWithAscii(bytes, 0, "GIF87a") || startsWithAscii(bytes, 0, "GIF89a")) {
        return "gif";
    }

    if (startsWithAscii(bytes, 0, "RIFF") && startsWithAscii(bytes, 8, "WEBP")) {
        return "webp";
    }

    return undefined;
}

function startsWithBytes(bytes: Uint8Array, signature: readonly number[]): boolean {
    return (
        bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte)
    );
}

function startsWithAscii(bytes: Uint8Array, offset: number, text: string): boolean {
    if (bytes.length < offset + text.length) {
        return false;
    }

    for (let index = 0; index < text.length; index++) {
        if (bytes[offset + index] !== text.charCodeAt(index)) {
            return false;
        }
    }

    return true;
}

const ANSI_16_RGB: readonly [number, number, number][] = [
    [0, 0, 0],
    [128, 0, 0],
    [0, 128, 0],
    [128, 128, 0],
    [0, 0, 128],
    [128, 0, 128],
    [0, 128, 128],
    [192, 192, 192],
    [128, 128, 128],
    [255, 0, 0],
    [0, 255, 0],
    [255, 255, 0],
    [0, 0, 255],
    [255, 0, 255],
    [0, 255, 255],
    [255, 255, 255],
];
export function ansi16ToRgb(index: number): [number, number, number] {
    return ANSI_16_RGB[index] ?? [255, 255, 255];
}
export function ansi256ToRgb(code: number): [number, number, number] {
    if (!Number.isFinite(code)) return [0, 0, 0];
    code = Math.min(255, Math.max(0, Math.trunc(code)));
    if (code < 16) return ansi16ToRgb(code);
    if (code >= 232) {
        const gray = 8 + (code - 232) * 10;
        return [gray, gray, gray];
    }
    const cubeIndex = code - 16;
    const levels = [0, 95, 135, 175, 215, 255];
    return [
        levels[Math.floor(cubeIndex / 36)]!,
        levels[Math.floor((cubeIndex % 36) / 6)]!,
        levels[cubeIndex % 6]!,
    ];
}

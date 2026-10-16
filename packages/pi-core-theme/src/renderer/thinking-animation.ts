import type { Theme } from "@earendil-works/pi-coding-agent";
import { foregroundAnsi, mixColors } from "@earendil-works/pi-tui";

// Every frame re-renders the whole transcript, so long sessions pay this rate in CPU while thinking.
export const THINKING_FPS = 30;
export const THINKING_FRAME_MS = 1000 / THINKING_FPS;
export const thinkingFrame = () => Math.floor(Date.now() / THINKING_FRAME_MS);
const stars = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];

// Only the thinking heading animates; cached Markdown rows never participate in these color frames.
export class ThinkingAnimation {
    private colors?: Theme["colors"];
    private palette: string[] = [];
    private color(theme: Theme, amount: number): string {
        if (this.colors !== theme.colors) {
            this.colors = theme.colors;
            this.palette = Array.from({ length: 64 }, (_, index) =>
                foregroundAnsi(
                    mixColors(theme.colors.thinkingText, theme.colors.accent, index / 63, "srgb"),
                    theme.getColorMode(),
                ),
            );
        }
        return this.palette[Math.round(amount * 63)]!;
    }
    render(theme: Theme, now: number): string {
        const phase = now / 900;
        const star = stars[Math.floor(now / 120) % stars.length]!;
        const mark = this.color(theme, (Math.sin(phase * Math.PI * 2) + 1) / 2) + star;
        const title = [..."Thinking"]
            .map(
                (char, index) =>
                    this.color(theme, (Math.cos(phase * Math.PI * 2 - index * 0.6) + 1) / 2) + char,
            )
            .join("");
        return `${mark}\x1b[39m ${title}\x1b[39m`;
    }
}

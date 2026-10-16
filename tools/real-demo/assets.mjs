import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function updatePackageImages(root, captures, themes) {
    const images = {
        "workspace-dark.png": ["pi-core-theme/docs/theme-overview.png"],
        "workspace-light.png": ["pi-core-theme/docs/theme-light.png"],
        "tools-expanded.png": ["pi-core-theme/docs/theme-diff.png"],
        "ask-question.png": ["pi-ask-question/docs/question-panel.png"],
        "question-answered.png": ["pi-ask-question/docs/question-answer-row.png"],
        "shell-inspector.png": ["pi-shell-inspector/assets/preview.png"],
        "dock-focus.png": ["pi-dock/docs/dock-overview.png"],
        "dock-styles.png": ["pi-dock/docs/dock-styles.png"],
        "compaction.png": ["pi-compaction/docs/compaction-settings.png"],
        "recap.png": ["pi-recap/docs/recap-widget.png"],
        "recap-settings.png": ["pi-recap/docs/recap-settings.png"],
    };
    for (const theme of themes) images[theme + ".png"] = ["pi-core-theme/docs/palettes/" + theme + ".png"];
    for (const [source, targets] of Object.entries(images)) {
        for (const relative of targets) {
            const destination = join(root, "packages", relative);
            await mkdir(dirname(destination), { recursive: true });
            await cp(join(captures, source), destination);
        }
    }
}

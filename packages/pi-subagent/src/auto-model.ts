import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
    getSupportedThinkingLevels,
    type Api,
    type ClassifierAnswer,
    type ClassifierApi,
    type ClassifierBoolQuestion,
    type ClassifierChoiceQuestion,
    type ClassifierContext,
    type ClassifierModel,
    type JsonObject,
    type Model,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AgentDefinition } from "./definitions.ts";
import { allowedModels, formatModelRef, type ModelRef } from "./models.ts";
import {
    AUTO_TIERS,
    type AutoModelChoice,
    type AutoRating,
    type AutoRisk,
    type AutoTier,
    type Isolation,
} from "./run/types.ts";

/** The Lune settings that `model: auto` reads at each start. */
export interface AutoModelSettings {
    /** Without a classifier, auto runs use the main agent's model and thinking. */
    classifier: ModelRef | null;
    /** The model of each tier; a task whose tier has none uses the next tier up that has one. */
    tiers: Readonly<Record<AutoTier, ModelRef | null>>;
    /** The lowest tier whose model a high-risk task may use; null leaves the model as rated. */
    riskFloor: AutoTier | null;
    /** The high-risk probability from which a task counts as high risk. */
    riskThreshold: number;
}

export const DEFAULT_AUTO_MODEL_SETTINGS: AutoModelSettings = {
    classifier: null,
    tiers: { light: null, standard: null, complex: null, deep: null },
    // A missed high-risk task costs more than a false alarm, so the default is below one half.
    riskFloor: "deep",
    riskThreshold: 0.4,
};

/** Below this confidence the classifier is unsure, and the run uses the next level up. */
const UNSURE_CONFIDENCE = 0.5;

// The classifier's window counts tokens of a tokenizer that the code does not know. A byte-level
// tokenizer gives each token at least one byte, so the request's UTF-8 bytes bound its tokens.

/** A rating needs the task's goal, not all of its text, and a shorter request is faster. */
const MAX_REQUEST_BYTES = 32_768;

/** Room in the window for the prompt that the classifier puts around the request, in tokens. */
const TEMPLATE_TOKENS = 512;

/** Less of the task and the instructions than this is too little to rate, so the start fails. */
const MIN_TEXT_BYTES = 1_024;

const EDIT_TOOLS = new Set(["edit", "write"]);
const COMMAND_TOOLS = new Set(["bash"]);

// The classifier knows nothing about models, so it rates the task and the code picks the model.
// Difficulty, reasoning and risk are separate questions; each criterion names traits that can be
// checked in the task and says what the option is not for.
const TIER_QUESTION = {
    type: "choice",
    instructions:
        "Rate the least model capability that this delegated coding task needs: how hard the " +
        "thinking is for the agent that will run it. The agent starts with only the task text, " +
        "its role and its tools from the state. Judge the difficulty, not the risk, the number " +
        "of files or steps, or the length of the text.",
    criteria: {
        light:
            "Mechanical, deterministic work with almost no inference of its own: lookups, " +
            "extraction, running given checks and reporting the results, or exactly specified " +
            "edits, also across many files. Not for: changes that need judgment.",
        standard:
            "Routine features, local fixes, ordinary tests and local reviews, where the " +
            "requirements and the acceptance criteria are clear and the path is known. Not for: " +
            "unclear causes, open design choices, or work across components.",
        complex:
            "Multi-step analysis, work across components, a non-trivial implementation, or " +
            "finding the cause of a failure that can be reproduced. The goal is clear, and the " +
            "approach and the way to check it are stable. Not for: unknown causes or open " +
            "trade-offs.",
        deep:
            "Uncertainty in the thinking: an unknown root cause, competing hypotheses, subtle " +
            "concurrency or security defects, architectural trade-offs, complex invariants, or " +
            "new solutions that need difficult judgment. Not for: work that is only large or has " +
            "many steps.",
    } satisfies Record<AutoTier, string>,
} satisfies ClassifierChoiceQuestion;

const THINKING_INSTRUCTIONS =
    "Rate the reasoning that the agent must do, before and between its steps, to finish this " +
    "task correctly and safely. Use the least level that is clearly enough, but raise it for " +
    "work whose mistakes are hard to detect or whose correctness cannot be shown by running " +
    "the result. The options are thinking levels from least to most. Judge the reasoning, not " +
    "the amount of work: many files or steps need no more thinking, and a subtle race condition " +
    "in one function can need a lot.";

// A model-routing signal only: it never grants or blocks a tool, an approval or a permission.
const RISK_QUESTION = {
    type: "bool",
    instructions:
        "Judge the task as the agent gets it, with normal, trusted execution and the intended use " +
        "of its result. If the agent acts wrongly, writes wrong code, or gives a wrong conclusion " +
        "that others rely on, can that seriously harm security, privacy, data integrity, money, " +
        "production services or permission boundaries, or do other damage that is hard to undo? " +
        "Weigh how far the harm reaches, where the work runs and how easily it is undone. Do not " +
        "answer true only because of domain words, many files, much code, difficulty, or a worst " +
        "case that is only possible in theory. Read-only work counts by what its result is used " +
        "for. A missing detail is not by itself a risk.",
    criteria: {
        true:
            "A mistake can do serious harm that is hard to undo. Examples: changes to " +
            "authentication, authorization, credentials, keys or data isolation; a security audit " +
            "that a release decision relies on; leaking, sending, deleting or opening access to " +
            "personal data, keys or protected code; payment, balance, accounting, billing or tax " +
            "logic; deployments, schema or data migrations, cloud permissions, network policies, " +
            "backups or shared service configuration; deleting important data, rewriting history, " +
            "or publishing what cannot be withdrawn.",
        false:
            "A mistake is found and undone at low cost. Examples: finding references or running " +
            "existing tests and reporting the results; ordinary changes in a local sandbox or test " +
            "code that can be rolled back and checked; renames, formatting or styles that do not " +
            "change critical behavior, also in sensitive modules; local or experimental failures, " +
            "even with an unknown cause; work that is only large, long or difficult.",
    },
} satisfies ClassifierBoolQuestion;

/** Every Pi thinking level; a request offers only the levels that the run's model supports. */
const THINKING_CRITERIA = {
    off:
        "No reasoning: each step is stated or obvious, such as running a given command, reading " +
        "named files or applying an exact edit.",
    minimal: "A quick look before acting; the steps follow directly from the task.",
    low: "Brief planning over a few dependent steps, such as finding where a described change goes.",
    medium:
        "Plan several dependent steps and check the results along the way, such as tracing a " +
        "call path, fitting a change into existing code or fixing a failure whose cause is " +
        "stated.",
    high:
        "Investigate a failure that reproduces to find its cause, weigh a few approaches for a " +
        "contained change, or confirm that a change meets its stated requirements. Not for: a " +
        "cause that no reproduction shows, an open design trade-off, or correctness that tests " +
        "cannot show.",
    xhigh:
        "Find the cause of a failure that does not reproduce, argue that a risky change is safe, " +
        "or plan a change that spans unfamiliar components. Not for: a failure that reproduces, " +
        "or work that only needs care.",
    max:
        "Reason about correctness that is hard to check, where a mistake is costly and easy to " +
        "miss: subtle concurrency, state or data-loss defects, security or privacy boundaries, " +
        "migrations or algorithms with invariants, or design trade-offs between constraints. " +
        "Not for: work that is only large, or hard only because the code is unfamiliar.",
} satisfies Record<ThinkingLevel, string>;

export interface AutoModelInput {
    ctx: ExtensionContext;
    settings: AutoModelSettings;
    task: string;
    definition?: AgentDefinition;
    /** The selected task tools; undefined for the defaultTools selection. */
    tools?: readonly string[];
    isolation: Isolation;
    /** The call or the definition set the thinking level, so the rating must not. */
    thinkingSet: boolean;
    signal?: AbortSignal;
}

/** What the request size depends on. */
export type AutoClassifier = Pick<
    ClassifierModel<ClassifierApi>,
    "provider" | "id" | "api" | "contextWindow"
>;

export interface AutoModelResult {
    ref: ModelRef;
    choice: AutoModelChoice;
    /** From the thinking rating, when the start set no thinking level. */
    thinking?: ThinkingLevel;
}

/**
 * Resolve `model: auto`. The classifier rates the task's tier and whether it is high risk; the
 * tier's model, or the next tier up that has one, runs it, and the main agent's model is the
 * ceiling. A high-risk task gets at least the floor tier's model, but keeps its rated tier, so the
 * difficulty and the risk stay apart. Unless the start set the
 * thinking, the classifier also rates it among the levels that Pi says the run's model supports:
 * in the same request when every model that the tier can lead to supports the same levels, else
 * in a second request once the model is known. When the classifier fails, the run gets the main
 * agent's model and thinking, and the choice records why. A tier model outside the allowed set is
 * a settings error and fails the start.
 */
export async function chooseAutoModel(input: AutoModelInput): Promise<AutoModelResult> {
    const { ctx, settings, signal } = input;

    if (!settings.classifier) {
        return { ref: modelRef(mainModel(ctx)), choice: { by: "no-classifier" } };
    }

    // With no tier model, the rating could only set the thinking, and the start already did.
    if (input.thinkingSet && AUTO_TIERS.every((tier) => settings.tiers[tier] === null)) {
        return { ref: modelRef(mainModel(ctx)), choice: { by: "nothing-to-rate" } };
    }

    const classifierRef = formatModelRef(settings.classifier);
    const failed = (error: unknown): AutoModelResult => {
        // A cancelled start stops; any other failure leaves the run the main agent's settings.
        if (signal?.aborted) {
            throw error;
        }

        return {
            ref: modelRef(mainModel(ctx)),
            choice: {
                by: "classifier-failed",
                classifier: classifierRef,
                error: error instanceof Error ? error.message : String(error),
            },
        };
    };
    // Undefined when the levels depend on the tier's model, so a second request asks for them.
    const levels = input.thinkingSet ? [] : sharedLevels(ctx, settings);
    let classifier: ClassifierModel<ClassifierApi>;
    let tier: AutoRating<AutoTier>;
    let thinking: AutoRating<ThinkingLevel> | undefined;
    let risk: AutoRisk;

    try {
        classifier = await findClassifier(input, settings.classifier);

        const answers = await classifyTask(input, classifier, {
            tier: TIER_QUESTION,
            risk: RISK_QUESTION,
            ...(levels && levels.length > 1 ? { thinking: thinkingQuestion(levels) } : {}),
        });

        tier = rating(answers.tier, AUTO_TIERS, `${classifierRef} gave no valid tier`);
        risk = riskRating(answers.risk, tier.used, settings, `${classifierRef} gave no valid risk`);
        thinking =
            levels && levels.length > 1
                ? rating(answers.thinking, levels, `${classifierRef} gave no valid thinking level`)
                : undefined;
    } catch (error) {
        return failed(error);
    }

    const modelFrom =
        AUTO_TIERS.slice(AUTO_TIERS.indexOf(risk.floor ?? tier.used)).find(
            (level) => settings.tiers[level] !== null,
        ) ?? "main";
    const model =
        modelFrom === "main"
            ? mainModel(ctx)
            : tierModel(ctx, modelFrom, settings.tiers[modelFrom]!);
    const supported = getSupportedThinkingLevels(model);

    if (!levels && supported.length > 1) {
        try {
            const answers = await classifyTask(input, classifier, {
                thinking: thinkingQuestion(supported),
            });

            thinking = rating(
                answers.thinking,
                supported,
                `${classifierRef} gave no valid thinking level`,
            );
        } catch (error) {
            return failed(error);
        }
    }

    return {
        ref: modelRef(model),
        choice: {
            by: "rating",
            classifier: classifierRef,
            tier,
            modelFrom,
            ...(thinking ? { thinking } : {}),
            risk,
        },
        ...(thinking ? { thinking: thinking.used } : {}),
    };
}

/**
 * The thinking levels that every model the tier can lead to supports, or undefined when they
 * differ. The main agent's model is one of those models while the deep tier has none.
 */
function sharedLevels(
    ctx: ExtensionContext,
    settings: AutoModelSettings,
): readonly ThinkingLevel[] | undefined {
    const allowed = allowedModels(ctx);
    // A model that the scope no longer allows fails the start if the tier leads to it.
    const models = AUTO_TIERS.flatMap((tier) => {
        const ref = settings.tiers[tier];
        const model = ref && allowed.find((each) => sameModel(each, ref));

        return model ? [model] : [];
    });

    if (settings.tiers.deep === null && ctx.model) {
        models.push(ctx.model);
    }

    const [first, ...rest] = models.map((model) => getSupportedThinkingLevels(model));

    return first && rest.every((levels) => levels.join() === first.join()) ? first : undefined;
}

function thinkingQuestion(levels: readonly ThinkingLevel[]): ClassifierChoiceQuestion {
    return {
        type: "choice",
        instructions: THINKING_INSTRUCTIONS,
        criteria: Object.fromEntries(levels.map((level) => [level, THINKING_CRITERIA[level]])),
    };
}

async function findClassifier(
    input: AutoModelInput,
    ref: ModelRef,
): Promise<ClassifierModel<ClassifierApi>> {
    const { ctx, signal } = input;

    signal?.throwIfAborted();

    const classifier = (
        await ctx.modelRegistry.getAvailableOfType("classifier", undefined, { signal })
    ).find((model) => sameModel(model, ref));

    if (!classifier) {
        throw new Error(
            `The auto classifier ${formatModelRef(ref)} is unavailable. Configure its provider in ` +
                "Pi, or select another classifier in the Subagents section of /lune-core-settings.",
        );
    }

    return classifier;
}

/** One classifier request about the task; it throws when the classifier fails. */
async function classifyTask(
    input: AutoModelInput,
    classifier: ClassifierModel<ClassifierApi>,
    questions: Record<string, ClassifierChoiceQuestion | ClassifierBoolQuestion>,
): Promise<Record<string, ClassifierAnswer>> {
    const { ctx, signal } = input;
    const result = await ctx.modelRegistry.classify(
        classifier,
        autoModelRequest(input, classifier, questions),
        { signal },
    );

    signal?.throwIfAborted();

    if (result.stopReason !== "stop") {
        throw new Error(
            `The auto classifier ${formatModelRef(classifier)} failed: ` +
                `${result.errorMessage ?? result.stopReason}.`,
        );
    }

    return result.answers;
}

/**
 * The task, the agent's role and what its tools allow; no model names, which the code maps. When
 * the task and the agent's instructions do not fit the classifier, both are shortened, and the
 * instructions get at most a quarter of the room unless the task leaves more.
 */
export function autoModelRequest(
    input: Pick<AutoModelInput, "task" | "definition" | "tools" | "isolation">,
    classifier: AutoClassifier,
    questions: Record<string, ClassifierChoiceQuestion | ClassifierBoolQuestion>,
): ClassifierContext {
    const state: JsonObject = { task: "" };
    const instructions = input.definition?.body ?? "";
    const agent = input.definition && {
        name: input.definition.name,
        description: input.definition.description,
        instructions: "",
    };

    if (agent) {
        state.agent = agent;
    }

    if (input.tools) {
        state.access = access(input.tools);
        state.tools = [...input.tools];
    } else {
        state.tools = "the default tool selection";
    }

    state.workspace =
        input.isolation === "worktree" ? "its own Git worktree" : "the user's working directory";

    const request = { state, questions };
    const room = requestLimit(classifier) - Buffer.byteLength(JSON.stringify(request));
    const taskBytes = textBytes(input.task);

    if (taskBytes + textBytes(instructions) <= room) {
        state.task = input.task;

        if (agent) {
            agent.instructions = instructions;
        }

        return request;
    }

    if (room < MIN_TEXT_BYTES) {
        throw new Error(
            `The auto classifier ${formatModelRef(classifier)} has a context window of ` +
                `${classifier.contextWindow} tokens, too small for this task. Select a classifier ` +
                "with a larger window in the Subagents section of /lune-core-settings.",
        );
    }

    const shortInstructions = shorten(
        instructions,
        Math.max(Math.floor(room / 4), room - taskBytes),
    );

    state.task = shorten(input.task, room - textBytes(shortInstructions));

    if (agent) {
        agent.instructions = shortInstructions;
    }

    return request;
}

/** The most bytes the request may have for the classifier's window. */
function requestLimit(classifier: AutoClassifier): number {
    // Pi's llama.cpp classifier shows the state and the questions twice in its prompt.
    const copies = classifier.api === "llama-cpp-classify" ? 2 : 1;

    return Math.min(
        MAX_REQUEST_BYTES,
        Math.floor((classifier.contextWindow - TEMPLATE_TOKENS) / copies),
    );
}

function access(tools: readonly string[]): string {
    const edits = tools.some((tool) => EDIT_TOOLS.has(tool));
    const commands = tools.some((tool) => COMMAND_TOOLS.has(tool));

    return edits && commands
        ? "can edit files and run commands"
        : edits
          ? "can edit files"
          : commands
            ? "can run commands"
            : "read-only";
}

/** The high-risk answer, and the floor when it raises the tier that the model comes from. */
function riskRating(
    answer: ClassifierAnswer | undefined,
    tier: AutoTier,
    settings: AutoModelSettings,
    invalid: string,
): AutoRisk {
    if (answer?.type !== "bool" || !Number.isFinite(answer.probability)) {
        throw new Error(`The auto classifier ${invalid}.`);
    }

    const high = answer.probability >= settings.riskThreshold;
    const floor = settings.riskFloor;

    return {
        probability: answer.probability,
        threshold: settings.riskThreshold,
        high,
        ...(high && floor && AUTO_TIERS.indexOf(floor) > AUTO_TIERS.indexOf(tier) ? { floor } : {}),
    };
}

/** One rating; an unsure answer moves up one level, since too little costs more than too much. */
function rating<T extends string>(
    answer: ClassifierAnswer | undefined,
    levels: readonly T[],
    invalid: string,
): AutoRating<T> {
    if (answer?.type !== "choice" || !levels.includes(answer.choice as T)) {
        throw new Error(`The auto classifier ${invalid}.`);
    }

    const rated = answer.choice as T;

    return {
        rated,
        used:
            answer.confidence < UNSURE_CONFIDENCE
                ? levels[Math.min(levels.indexOf(rated) + 1, levels.length - 1)]!
                : rated,
        confidence: answer.confidence,
        probabilities: Object.fromEntries(
            levels.flatMap((level) => {
                const probability = answer.probabilities[level];

                return typeof probability === "number" && Number.isFinite(probability)
                    ? [[level, probability]]
                    : [];
            }),
        ) as Partial<Record<T, number>>,
    };
}

function mainModel(ctx: ExtensionContext): Model<Api> {
    if (!ctx.model) {
        throw new Error("The main agent has no current model for the auto run to use.");
    }

    return ctx.model;
}

/** A tier's model must still be one the parent allows; the scope can change after it was set. */
function tierModel(ctx: ExtensionContext, tier: AutoTier, ref: ModelRef): Model<Api> {
    const allowed = allowedModels(ctx);
    const model = allowed.find((each) => sameModel(each, ref));

    if (!model) {
        const refs = allowed.map((each) => formatModelRef(each));

        throw new Error(
            `The ${tier} auto tier uses ${formatModelRef(ref)}, which is not in the allowed set` +
                (refs.length > 0 ? `: ${refs.join(", ")}.` : "; no models are available.") +
                " Select another model under Auto tiers in the Subagents section of " +
                "/lune-core-settings.",
        );
    }

    return model;
}

function sameModel(model: ModelRef, ref: ModelRef): boolean {
    return model.provider === ref.provider && model.id === ref.id;
}

function modelRef(model: ModelRef): ModelRef {
    return { provider: model.provider, id: model.id };
}

/** The UTF-8 bytes of `text` in a JSON string, escapes included. */
function textBytes(text: string): number {
    return Buffer.byteLength(JSON.stringify(text)) - 2;
}

/**
 * `text` in at most `maxBytes`: its start and its end, which usually state the goal and what to
 * deliver, around a note of how much was left out.
 */
function shorten(text: string, maxBytes: number): string {
    if (textBytes(text) <= maxBytes) {
        return text;
    }

    const chars = [...text];
    // The note's count is less than the text's length, so the note takes at most this room.
    const room = maxBytes - textBytes(omitted(chars.length));
    const startCount = fitting(chars, Math.floor((room * 3) / 4));
    const start = chars.slice(0, startCount).join("");
    const rest = chars.slice(startCount);
    const endCount = fitting(rest.toReversed(), room - textBytes(start));

    return start + omitted(rest.length - endCount) + rest.slice(rest.length - endCount).join("");
}

function omitted(count: number): string {
    return `\n[${count} characters not shown]\n`;
}

/** How many of `chars`, from the first, fit in `maxBytes`. */
function fitting(chars: readonly string[], maxBytes: number): number {
    let bytes = 0;
    let count = 0;

    for (const char of chars) {
        bytes += textBytes(char);

        if (bytes > maxBytes) {
            break;
        }

        count++;
    }

    return count;
}

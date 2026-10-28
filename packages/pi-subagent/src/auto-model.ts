import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
    ClassifierAnswer,
    ClassifierApi,
    ClassifierChoiceQuestion,
    ClassifierContext,
    ClassifierModel,
    JsonObject,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AgentDefinition } from "./definitions.ts";
import { allowedModelRefs, formatModelRef, type ModelRef } from "./models.ts";
import {
    AUTO_REASONING,
    AUTO_TIERS,
    type AutoModelChoice,
    type AutoRating,
    type AutoReasoning,
    type AutoTier,
    type Isolation,
} from "./run/types.ts";

/** The Lune settings that `model: auto` reads at each start. */
export interface AutoModelSettings {
    /** Without a classifier, auto runs use the main agent's model and thinking. */
    classifier: ModelRef | null;
    /** The model of each tier; a task whose tier has none uses the next tier up that has one. */
    tiers: Readonly<Record<AutoTier, ModelRef | null>>;
}

export const DEFAULT_AUTO_MODEL_SETTINGS: AutoModelSettings = {
    classifier: null,
    tiers: { light: null, standard: null, complex: null, deep: null },
};

/** The thinking level of each reasoning rating; Pi lowers one that the model does not support. */
export const REASONING_THINKING: Readonly<Record<AutoReasoning, ThinkingLevel>> = {
    none: "minimal",
    light: "low",
    moderate: "medium",
    heavy: "high",
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
// Each criterion names traits that can be checked in the task and says what the option is not for.
const TIER_QUESTION = {
    type: "choice",
    instructions:
        "Rate how demanding this delegated coding task is for the agent that will run it. The " +
        "agent starts with only the task text, its role and its tools from the state. Judge the " +
        "work that the task asks for, not the length of its text.",
    criteria: {
        light:
            "Find, read or run something, then report what it shows. The answer is in the code, " +
            "the docs or command output, and nothing needs changing beyond trivial edits. " +
            "Examples: search for usages, read a config, list files, run the tests and report " +
            "the failures, summarize a module. Not for: changes that need judgment.",
        standard:
            "A clear, well-specified change or check with a known path, in one or a few places. " +
            "Examples: add a test for a described behavior, rename a symbol, fix a named lint or " +
            "type error, update docs to match the code, apply a described edit. Not for: unclear " +
            "causes, open design choices, or work across many files.",
        complex:
            "Several steps across files or sources toward a clear goal. Examples: implement a " +
            "described feature, debug a failure that can be reproduced, trace a behavior through " +
            "code, logs and tool output, update many call sites after an API change. Not for: open " +
            "design questions, trade-offs, or reviews for subtle bugs.",
        deep:
            "Judgment under uncertainty. Examples: design or architecture decisions, weighing " +
            "trade-offs, unclear or intermittent failures, reviewing code for subtle bugs or " +
            "security problems, large or risky refactors, ambiguous requirements. Not for: work " +
            "that needs only care or many steps.",
    } satisfies Record<AutoTier, string>,
} satisfies ClassifierChoiceQuestion;

const REASONING_QUESTION = {
    type: "choice",
    instructions:
        "Rate how much step-by-step reasoning the agent must do to complete this task correctly.",
    criteria: {
        none:
            "Each step is obvious from the task, such as running a given command or reading " +
            "named files.",
        light: "Brief planning over a few dependent steps.",
        moderate:
            "Plan several dependent steps and check the results along the way, such as tracing " +
            "a call path or fitting a change into existing code.",
        heavy:
            "Weigh alternatives, form and test hypotheses, or reason about correctness, such as " +
            "finding a root cause or showing that a change is safe.",
    } satisfies Record<AutoReasoning, string>,
} satisfies ClassifierChoiceQuestion;

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
    /** From the reasoning rating, when the start set no thinking level. */
    thinking?: ThinkingLevel;
}

/**
 * Resolve `model: auto`. The classifier rates the task's tier and reasoning in one request; the
 * tier's model, or the next tier up that has one, runs it, and the main agent's model is the
 * ceiling. When the classifier fails, the run gets the main agent's model and thinking, and the
 * choice records why. A tier model outside the allowed set is a settings error and fails the start.
 */
export async function chooseAutoModel(input: AutoModelInput): Promise<AutoModelResult> {
    const { ctx, settings, signal } = input;

    if (!settings.classifier) {
        return { ref: mainModel(ctx), choice: { by: "no-classifier" } };
    }

    // With no tier model, the rating could only set the thinking, and the start already did.
    if (input.thinkingSet && AUTO_TIERS.every((tier) => settings.tiers[tier] === null)) {
        return { ref: mainModel(ctx), choice: { by: "nothing-to-rate" } };
    }

    const classifierRef = formatModelRef(settings.classifier);
    let tier: AutoRating<AutoTier>;
    let reasoning: AutoRating<AutoReasoning>;

    try {
        ({ tier, reasoning } = await rateTask(input, settings.classifier));
    } catch (error) {
        // A cancelled start stops; any other failure leaves the run the main agent's settings.
        if (signal?.aborted) {
            throw error;
        }

        return {
            ref: mainModel(ctx),
            choice: {
                by: "classifier-failed",
                classifier: classifierRef,
                error: error instanceof Error ? error.message : String(error),
            },
        };
    }

    const modelFrom =
        AUTO_TIERS.slice(AUTO_TIERS.indexOf(tier.used)).find(
            (level) => settings.tiers[level] !== null,
        ) ?? "main";

    return {
        ref:
            modelFrom === "main"
                ? mainModel(ctx)
                : tierModel(ctx, modelFrom, settings.tiers[modelFrom]!),
        choice: { by: "rating", classifier: classifierRef, tier, modelFrom, reasoning },
        ...(input.thinkingSet ? {} : { thinking: REASONING_THINKING[reasoning.used] }),
    };
}

/** One classifier request for the task's tier and reasoning; it throws when the classifier fails. */
async function rateTask(
    input: AutoModelInput,
    classifierRef: ModelRef,
): Promise<{ tier: AutoRating<AutoTier>; reasoning: AutoRating<AutoReasoning> }> {
    const { ctx, signal } = input;
    const ref = formatModelRef(classifierRef);

    signal?.throwIfAborted();

    const classifier = (
        await ctx.modelRegistry.getAvailableOfType("classifier", undefined, { signal })
    ).find((model) => model.provider === classifierRef.provider && model.id === classifierRef.id);

    if (!classifier) {
        throw new Error(
            `The auto classifier ${ref} is unavailable. Configure its provider in Pi, or select ` +
                "another classifier in the Subagents section of /lune-core-settings.",
        );
    }

    const result = await ctx.modelRegistry.classify(
        classifier,
        autoModelRequest(input, classifier),
        { signal },
    );

    signal?.throwIfAborted();

    if (result.stopReason !== "stop") {
        throw new Error(
            `The auto classifier ${ref} failed: ${result.errorMessage ?? result.stopReason}.`,
        );
    }

    return {
        tier: rating(result.answers.tier, AUTO_TIERS, `${ref} gave no valid tier`),
        reasoning: rating(
            result.answers.reasoning,
            AUTO_REASONING,
            `${ref} gave no valid reasoning rating`,
        ),
    };
}

/**
 * The task, the agent's role and what its tools allow; no model names, which the code maps. When
 * the task and the agent's instructions do not fit the classifier, both are shortened, and the
 * instructions get at most a quarter of the room unless the task leaves more.
 */
export function autoModelRequest(
    input: Pick<AutoModelInput, "task" | "definition" | "tools" | "isolation">,
    classifier: AutoClassifier,
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

    const request = { state, questions: { tier: TIER_QUESTION, reasoning: REASONING_QUESTION } };
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

function mainModel(ctx: ExtensionContext): ModelRef {
    if (!ctx.model) {
        throw new Error("The main agent has no current model for the auto run to use.");
    }

    return { provider: ctx.model.provider, id: ctx.model.id };
}

/** A tier's model must still be one the parent allows; the scope can change after it was set. */
function tierModel(ctx: ExtensionContext, tier: AutoTier, model: ModelRef): ModelRef {
    const ref = formatModelRef(model);
    const allowed = allowedModelRefs(ctx);

    if (!allowed.includes(ref)) {
        throw new Error(
            `The ${tier} auto tier uses ${ref}, which is not in the allowed set` +
                (allowed.length > 0 ? `: ${allowed.join(", ")}.` : "; no models are available.") +
                " Select another model under Auto tiers in the Subagents section of " +
                "/lune-core-settings.",
        );
    }

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

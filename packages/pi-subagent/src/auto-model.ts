import type { Api, ClassifierContext, JsonObject, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AgentDefinition } from "./definitions.ts";
import { allowedModelRefs, formatModelRef, parseModelRef, type ModelRef } from "./models.ts";
import type { AutoModelChoice, Isolation } from "./run/types.ts";

/** The Lune settings that `model: auto` reads at each start. */
export interface AutoModelSettings {
    /** Without a classifier, auto runs use the main agent's model. */
    classifier: ModelRef | null;
    /** The models the classifier may choose; empty means every allowed model. */
    candidates: readonly ModelRef[];
}

export const DEFAULT_AUTO_MODEL_SETTINGS: AutoModelSettings = { classifier: null, candidates: [] };

const QUESTION_ID = "model";

/** A task longer than this share of the classifier's window, in characters, is shortened. */
const TASK_CHARS_PER_TOKEN = 2;

const INSTRUCTIONS =
    "Choose the model that should run this delegated coding-agent task. The task text is the " +
    "run's only context; the agent role and tools, when given, show what the run may do. Prefer " +
    "the cheapest model that can complete the task reliably on its first attempt. Cheaper models " +
    "suit well-specified, mechanical work: searching and reading code, collecting facts, " +
    "summarizing, running commands and reporting their results, and small, clearly described " +
    "edits. More capable models suit work that needs judgment: designing changes, debugging " +
    "unclear failures, reviewing code for subtle bugs, large or risky refactors, and tasks with " +
    "ambiguous requirements.";

export interface AutoModelInput {
    ctx: ExtensionContext;
    settings: AutoModelSettings;
    task: string;
    definition?: AgentDefinition;
    /** The selected task tools; undefined for the defaultTools selection. */
    tools?: readonly string[];
    isolation: Isolation;
    signal?: AbortSignal;
}

/**
 * Resolve `model: auto`. Only a missing classifier falls back, to the main agent's model, as the
 * settings describe; an unavailable classifier or a failed request is an error, so the main agent
 * can start the run with an explicit model instead.
 */
export async function chooseAutoModel(
    input: AutoModelInput,
): Promise<{ ref: ModelRef; choice: AutoModelChoice }> {
    const { ctx, settings, signal } = input;

    if (!settings.classifier) {
        if (!ctx.model) {
            throw new Error(
                "No auto classifier is selected, and the main agent has no current model to use instead.",
            );
        }

        return {
            ref: { provider: ctx.model.provider, id: ctx.model.id },
            choice: { by: "no-classifier" },
        };
    }

    const candidates = autoCandidates(ctx, settings);

    if (candidates.length === 1) {
        return {
            ref: parseModelRef(candidates[0]!)!,
            choice: { by: "only-candidate", candidates },
        };
    }

    const classifierRef = formatModelRef(settings.classifier);

    signal?.throwIfAborted();

    const classifier = (
        await ctx.modelRegistry.getAvailableOfType("classifier", undefined, { signal })
    ).find(
        (model) =>
            model.provider === settings.classifier!.provider &&
            model.id === settings.classifier!.id,
    );

    if (!classifier) {
        throw new Error(
            `The auto classifier ${classifierRef} is unavailable. Configure its provider in Pi, or ` +
                "select another classifier in the Subagents section of /lune-core-settings.",
        );
    }

    const request = autoModelRequest(
        input,
        candidates,
        Math.max(4_000, classifier.contextWindow * TASK_CHARS_PER_TOKEN),
    );
    const result = await ctx.modelRegistry.classify(classifier, request, { signal });

    signal?.throwIfAborted();

    if (result.stopReason !== "stop") {
        throw new Error(
            `The auto classifier ${classifierRef} failed: ${result.errorMessage ?? result.stopReason}.`,
        );
    }

    const answer = result.answers[QUESTION_ID];

    if (answer?.type !== "choice" || !candidates.includes(answer.choice)) {
        throw new Error(`The auto classifier ${classifierRef} returned no valid model choice.`);
    }

    return {
        ref: parseModelRef(answer.choice)!,
        choice: {
            by: "classifier",
            classifier: classifierRef,
            confidence: answer.confidence,
            candidates,
        },
    };
}

/**
 * The selected candidates that the parent still allows, in selection order, or every allowed
 * model when none is selected. A selection that the scope has left entirely is an error.
 */
export function autoCandidates(ctx: ExtensionContext, settings: AutoModelSettings): string[] {
    const allowed = allowedModelRefs(ctx);

    if (settings.candidates.length === 0) {
        if (allowed.length === 0) {
            throw new Error("No models are available for an auto run.");
        }

        return allowed;
    }

    const selected = [...new Set(settings.candidates.map((ref) => formatModelRef(ref)))];
    const candidates = selected.filter((ref) => allowed.includes(ref));

    if (candidates.length === 0) {
        throw new Error(
            `None of the auto candidates (${selected.join(", ")}) is in the allowed set` +
                (allowed.length > 0 ? `: ${allowed.join(", ")}.` : "; no models are available.") +
                " Select other candidates in the Subagents section of /lune-core-settings.",
        );
    }

    return candidates;
}

/** One choice question whose answers are the candidates' `provider/id` references. */
export function autoModelRequest(
    input: Pick<AutoModelInput, "ctx" | "task" | "definition" | "tools" | "isolation">,
    candidates: readonly string[],
    maxChars: number,
): ClassifierContext {
    const models = candidates.map((ref) => {
        const parsed = parseModelRef(ref)!;

        return { ref, model: input.ctx.modelRegistry.find(parsed.provider, parsed.id) };
    });
    // A price of 0 means Pi lists none, so such a model gets no rank rather than the first.
    const prices = [
        ...new Set(
            models.flatMap(({ model }) => (model && price(model) > 0 ? [price(model)] : [])),
        ),
    ].sort((a, b) => a - b);
    const state: JsonObject = {
        task: shorten(input.task, maxChars),
        tools: input.tools ? [...input.tools] : "the default tool selection",
        isolation: input.isolation,
    };

    if (input.definition) {
        state.agent = {
            name: input.definition.name,
            description: input.definition.description,
            instructions: shorten(input.definition.body, Math.floor(maxChars / 4)),
        };
    }

    return {
        state,
        questions: {
            [QUESTION_ID]: {
                type: "choice",
                instructions: INSTRUCTIONS,
                criteria: Object.fromEntries(
                    models.map(({ ref, model }) => [
                        ref,
                        model
                            ? describeModel(ref, model, prices)
                            : `${ref}. Pi lists no details for this model.`,
                    ]),
                ),
            },
        },
    };
}

function describeModel(ref: string, model: Model<Api>, prices: readonly number[]): string {
    const cost =
        price(model) === 0
            ? "Pi lists no price for it"
            : `it costs $${model.cost.input} per million input tokens and $${model.cost.output} ` +
              `per million output tokens, price rank ${prices.indexOf(price(model)) + 1} of ` +
              `${prices.length} from the cheapest`;

    return (
        `${model.name} (${ref}): ${cost}. ` +
        `${model.reasoning ? "It supports extended reasoning" : "It has no extended reasoning"}, ` +
        `with a context window of ${model.contextWindow.toLocaleString("en-US")} tokens.`
    );
}

function price(model: Model<Api>): number {
    return model.cost.input + model.cost.output;
}

function shorten(text: string, maxChars: number): string {
    return text.length <= maxChars
        ? text
        : `${text.slice(0, maxChars)}\n[${text.length - maxChars} more characters not shown]`;
}

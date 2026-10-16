import test from "node:test";
import assert from "node:assert/strict";
import type {
    ClassifierModel,
    Model,
    ModelsRefreshOptions,
    ModelsRefreshResult,
} from "@earendil-works/pi-ai";
import type { ExtensionContext, ScopedModel } from "@earendil-works/pi-coding-agent";
import type { ModelReference, SettingsChoiceContext } from "@lune_99/pi-lune-extensions-core/panel";
import { classifierChoices, summaryModelChoices } from "../../src/settings/section.ts";

function chatModel(
    id: string,
    options: {
        provider?: string;
        api?: string;
        reasoning?: boolean;
        contextWindow?: number;
        maxTokens?: number;
    } = {},
): Model<string> {
    return {
        id,
        name: id,
        api: options.api ?? "faux",
        provider: options.provider ?? "chat-provider",
        baseUrl: "http://localhost:0",
        input: ["text"],
        reasoning: options.reasoning ?? false,
        contextWindow: options.contextWindow ?? 128_000,
        maxTokens: options.maxTokens ?? 4_096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
}

function classifierModel(id: string, api = "typesafe-system-one"): ClassifierModel<string> {
    return {
        type: "classifier",
        id,
        name: id,
        api,
        provider: "typesafe",
        baseUrl: "http://localhost:0",
        input: ["text"],
        contextWindow: 8_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } as unknown as ClassifierModel<string>;
}

interface RegistryOptions {
    readonly available?: Model<string>[];
    readonly scoped?: ScopedModel[];
    readonly classifiers?: ClassifierModel<string>[];
    readonly providerNames?: Record<string, string>;
    readonly refresh?: (options: ModelsRefreshOptions) => Promise<ModelsRefreshResult>;
}

function contextFor(options: RegistryOptions = {}): {
    context: ExtensionContext;
    modelTypes: string[];
    refreshCalls: ModelsRefreshOptions[];
} {
    const modelTypes: string[] = [];
    const refreshCalls: ModelsRefreshOptions[] = [];
    const available = options.available ?? [];
    return {
        context: {
            scopedModels: options.scoped ?? [],
            modelRegistry: {
                getAvailable: () => available,
                getProviderDisplayName: (provider: string) =>
                    options.providerNames?.[provider] ?? provider,
                getAvailableOfType: async (type: string) => {
                    modelTypes.push(type);
                    if (type === "classifier") return options.classifiers ?? [];
                    throw new Error(`Unexpected typed model query: ${type}`);
                },
                find: (provider: string, id: string) =>
                    available.find((model) => model.provider === provider && model.id === id),
                refresh: (refreshOptions: ModelsRefreshOptions) => {
                    refreshCalls.push(refreshOptions);
                    return options.refresh
                        ? options.refresh(refreshOptions)
                        : Promise.resolve({ aborted: false, errors: new Map() });
                },
            },
        } as unknown as ExtensionContext,
        modelTypes,
        refreshCalls,
    };
}

function loadContext(
    context: ExtensionContext,
    candidateScope?: "scoped" | "all",
): SettingsChoiceContext & { candidateScope?: "scoped" | "all"; signal: AbortSignal } {
    return {
        context,
        values: undefined,
        scope: "global",
        candidateScope,
        signal: new AbortController().signal,
    };
}

function references(
    choices: Awaited<ReturnType<typeof summaryModelChoices.load>>,
): ModelReference[] {
    return choices
        .filter((choice) => choice.value !== null)
        .map((choice) => {
            assert.ok(choice.value, "a model choice must save the Pi provider/id identity");
            return choice.value;
        });
}

test("summary choices preserve Pi identities and include virtual models for direct routing", async () => {
    // Selecting a scope changes only the registry query; stored choices remain provider-qualified identities.
    const first = chatModel("shared-id", { provider: "provider-a", reasoning: true });
    const second = chatModel("shared-id", { provider: "provider-b" });
    const virtual = chatModel("virtual", {
        provider: "pi-virtual-provider",
        api: "pi-virtual",
        contextWindow: 0,
        maxTokens: 0,
    });
    const { context } = contextFor({
        available: [first, second, virtual],
        scoped: [{ model: second, thinkingLevel: "high" }],
    });

    assert.deepEqual(summaryModelChoices.scopes, ["scoped", "all"]);
    assert.equal(summaryModelChoices.defaultScope?.(context), "scoped");
    assert.deepEqual(references(await summaryModelChoices.load(loadContext(context, "scoped"))), [
        { provider: "provider-b", id: "shared-id" },
    ]);

    const allChoices = await summaryModelChoices.load(loadContext(context, "all"));
    assert.equal(allChoices[0]!.value, null);
    assert.equal(allChoices[0]!.label, "Follow session model");
    assert.deepEqual(references(allChoices), [
        { provider: "provider-a", id: "shared-id" },
        { provider: "provider-b", id: "shared-id" },
        { provider: "pi-virtual-provider", id: "virtual" },
    ]);
    assert.equal(allChoices[2]!.description?.includes("scoped thinking: high"), true);
    assert.equal(allChoices[3]!.disabled, undefined);
});

test("classifier choices use only available typed models and include automatic mode", async () => {
    const { context, modelTypes } = contextFor({
        classifiers: [
            classifierModel("jev-latest"),
            classifierModel("gpt-6-luna", "openai-decisions"),
        ],
        providerNames: { typesafe: "TypeSafe" },
    });
    const choices = await classifierChoices.load(loadContext(context));
    assert.deepEqual(modelTypes, ["classifier"]);
    assert.deepEqual(
        choices.map(({ value }) => value),
        [
            null,
            { provider: "typesafe", id: "jev-latest" },
            { provider: "typesafe", id: "gpt-6-luna" },
        ],
    );
    assert.equal(choices[1]!.searchText, "typesafe/jev-latest jev-latest TypeSafe");
});

test("summary model refresh forwards cancellation and reports provider failures", async () => {
    // A failed Pi refresh must be visible to the settings choice source instead of leaving stale candidates silently.
    const controller = new AbortController();
    const failure = new Error("provider refresh failed");
    const { context, refreshCalls } = contextFor({
        refresh: async () => ({
            aborted: false,
            errors: new Map([["provider-a", failure]]),
        }),
    });

    await assert.rejects(
        summaryModelChoices.refresh!({
            ...loadContext(context),
            signal: controller.signal,
        }),
        (error: unknown) => {
            assert.ok(error instanceof AggregateError);
            assert.deepEqual(error.errors, [failure]);
            assert.match(error.message, /provider-a: provider refresh failed/);
            return true;
        },
    );
    assert.equal(refreshCalls.length, 1);
    assert.equal(refreshCalls[0]!.signal, controller.signal);

    const cancelledController = new AbortController();
    const cancelled = contextFor({
        refresh: async () => ({ aborted: true, errors: new Map() }),
    });
    await assert.rejects(
        summaryModelChoices.refresh!({
            ...loadContext(cancelled.context),
            signal: cancelledController.signal,
        }),
        (error: unknown) => error instanceof DOMException && error.name === "AbortError",
    );
    assert.equal(cancelled.refreshCalls[0]!.signal, cancelledController.signal);
});

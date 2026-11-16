// Settings page of the local lune-memory daemon. Plain ES module without a build step.
// The daemon serves it with a strict CSP: no inline script or style, and no external hosts.
// Data goes into the DOM through textContent only.

const TOKEN_KEY = "lune-memory-token";

const SECTIONS = [
    {
        id: "overview",
        label: "Overview",
        lede: "The state of the memory index, the last Dreaming pass and live activity.",
    },
    {
        id: "sources",
        label: "Sources",
        lede: "The harnesses whose sessions lune-memory imports, and how often it looks.",
    },
    {
        id: "dreaming",
        label: "Dreaming",
        lede: "The model that turns sessions into memory, and the limits of each pass.",
    },
    {
        id: "models",
        label: "Models & keys",
        lede: "API keys for the model providers. Keys stay in the local credential file.",
    },
    {
        id: "projects",
        label: "Projects",
        lede: "Projects group sessions from clones and worktrees of the same code.",
    },
    {
        id: "sessions",
        label: "Sessions",
        lede: "Imported sessions and their Dreaming state.",
    },
    {
        id: "runs",
        label: "Runs",
        lede: "Each commit of a Dreaming pass. A revert undoes the memory changes of one run.",
    },
    {
        id: "storage",
        label: "Storage",
        lede: "Where memory lives on disk, and how long old data stays.",
    },
];

const CONFIG_SECTIONS = new Set(["sources", "dreaming", "storage"]);
const HARNESS_NAMES = { pi: "Pi", claude: "Claude Code", codex: "Codex" };
const HARNESSES = ["pi", "claude", "codex"];
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"];
const LOCATOR_NAMES = { git_common_dir: "Git repository", remote: "Remote", path: "Path" };
const UNASSIGNED = "_unassigned";
const NOTE_ACTIONS = {
    note_write: "Note written",
    note_update: "Note updated",
    note_retract: "Note retracted",
};
const ACTIVITY_LIMIT = 60;

const state = {
    token: null,
    section: "overview",
    status: null,
    config: null,
    draft: null,
    invalid: new Set(),
    providers: null,
    credentials: [],
    projects: [],
    showMerged: false,
    sessions: [],
    sessionProject: "",
    runs: [],
    activity: [],
    providerFilter: "",
    connected: false,
    version: null,
};

// DOM helpers --------------------------------------------------------------------------------

const PROPS = new Set([
    "value",
    "checked",
    "selected",
    "disabled",
    "hidden",
    "open",
    "indeterminate",
]);

/** Create an element. Strings become text nodes, so data is never parsed as HTML. */
function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props ?? {})) {
        if (value === undefined || value === null || value === false) continue;
        if (key === "class") el.className = value;
        else if (key.startsWith("on") && typeof value === "function") {
            el.addEventListener(key.slice(2), value);
        } else if (PROPS.has(key)) el[key] = value;
        else el.setAttribute(key, value === true ? "" : String(value));
    }
    append(el, children);
    return el;
}

function append(el, children) {
    for (const child of children) {
        if (child === undefined || child === null || child === false) continue;
        if (Array.isArray(child)) append(el, child);
        else el.append(child instanceof Node ? child : String(child));
    }
}

function $(id) {
    return document.getElementById(id);
}

// Formatting ---------------------------------------------------------------------------------

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const numberFormat = new Intl.NumberFormat();

function timeOf(value) {
    if (value === null || value === undefined) return null;
    const date = new Date(typeof value === "number" ? value : String(value));
    return Number.isNaN(date.getTime()) ? null : date;
}

function ago(value) {
    const date = timeOf(value);
    if (!date) return "never";
    const seconds = Math.round((date.getTime() - Date.now()) / 1000);
    const steps = [
        [60, "second"],
        [60, "minute"],
        [24, "hour"],
        [7, "day"],
        [4.35, "week"],
        [12, "month"],
        [Infinity, "year"],
    ];
    let amount = seconds;
    for (const [size, unit] of steps) {
        if (Math.abs(amount) < size) return relative.format(Math.round(amount), unit);
        amount /= size;
    }
    return date.toLocaleString();
}

function stamp(value) {
    const date = timeOf(value);
    return h("time", { datetime: date?.toISOString(), title: date?.toLocaleString() }, ago(value));
}

function duration(start, end) {
    const a = timeOf(start);
    const b = timeOf(end);
    if (!a || !b) return "";
    const seconds = Math.max(0, Math.round((b.getTime() - a.getTime()) / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${seconds % 60}s`;
}

function count(value) {
    return numberFormat.format(Number(value) || 0);
}

/** Folder name of a projection generation. The daemon gives its full path. */
function generationName(value) {
    return value ? String(value).split(/[\\/]/).pop() : "none";
}

function plural(n, one, many = `${one}s`) {
    return `${count(n)} ${n === 1 ? one : many}`;
}

function shortId(value) {
    const text = String(value ?? "");
    return text.length > 14 ? `${text.slice(0, 8)}…${text.slice(-4)}` : text;
}

function usageText(usage) {
    if (!usage || typeof usage !== "object") return "";
    const parts = [];
    if (usage.calls) parts.push(plural(usage.calls, "call"));
    if (usage.totalTokens) parts.push(`${count(usage.totalTokens)} tokens`);
    if (usage.cost) parts.push(`$${Number(usage.cost).toFixed(4)}`);
    return parts.join(" · ");
}

function sourceText(source) {
    if (!source) return "";
    if (source === "stored credential") return "Stored key";
    if (source === "OAuth") return "Signed in with OAuth";
    return `From ${source}`;
}

const STATUS_TONES = {
    ok: "success",
    idle: "neutral",
    running: "accent",
    partial: "warning",
    skipped: "neutral",
    reverted: "neutral",
    busy: "warning",
    "no-model": "warning",
    failed: "danger",
};

function badge(text, tone = "neutral") {
    return h("span", { class: `badge ${tone}` }, text);
}

function statusBadge(status) {
    return badge(String(status ?? "unknown").replace("-", " "), STATUS_TONES[status] ?? "neutral");
}

function projectName(id) {
    if (!id) return "No project";
    const project = state.projects.find((entry) => entry.id === id);
    return project ? project.name : shortId(id);
}

// API ----------------------------------------------------------------------------------------

class LockedError extends Error {}

async function api(method, path, body) {
    const response = await fetch(path, {
        method,
        cache: "no-store",
        headers: {
            Authorization: `Bearer ${state.token}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 401) {
        lock();
        throw new LockedError("The access token is missing or old");
    }
    const text = await response.text();
    let data = null;
    if (text) {
        try {
            data = JSON.parse(text);
        } catch {
            data = text;
        }
    }
    if (!response.ok) {
        const message =
            data && typeof data === "object" && typeof data.error === "string"
                ? data.error
                : `The daemon answered ${response.status}`;
        throw new Error(message);
    }
    return data;
}

/** Run an action. Show its error as a toast, and keep the button busy while it runs. */
async function act(button, work) {
    if (button) button.disabled = true;
    try {
        return await work();
    } catch (error) {
        if (!(error instanceof LockedError)) toast(error.message || String(error), "danger");
        return undefined;
    } finally {
        if (button) button.disabled = false;
    }
}

// Token --------------------------------------------------------------------------------------

function readToken() {
    const hash = location.hash.startsWith("#") ? location.hash.slice(1) : "";
    const params = new URLSearchParams(hash);
    const fromHash = params.get("token");
    if (fromHash) {
        try {
            sessionStorage.setItem(TOKEN_KEY, fromHash);
        } catch {
            // Private mode: the token lives in memory only.
        }
        history.replaceState(null, "", `${location.pathname}#overview`);
        return fromHash;
    }
    try {
        return sessionStorage.getItem(TOKEN_KEY);
    } catch {
        return null;
    }
}

function lock() {
    try {
        sessionStorage.removeItem(TOKEN_KEY);
    } catch {
        // Nothing to remove.
    }
    state.token = null;
    $("app").hidden = true;
    $("savebar").hidden = true;
    $("locked").hidden = false;
}

// Toasts and dialogs -------------------------------------------------------------------------

function toast(text, tone = "neutral") {
    const item = h("div", { class: `toast ${tone}` }, text);
    $("toasts").append(item);
    setTimeout(() => item.classList.add("leaving"), tone === "danger" ? 7000 : 3500);
    setTimeout(() => item.remove(), tone === "danger" ? 7400 : 3900);
}

/**
 * Show a modal dialog. `fields` builds the form body. `submit` gets the form and returns true to
 * close, or false to stay open (for example after an error).
 */
function dialog({ title, text, fields, confirm, danger = false, submit }) {
    const box = $("dialog");
    box.replaceChildren();
    const confirmButton = h(
        "button",
        { type: "submit", class: `btn ${danger ? "danger" : "primary"}` },
        confirm,
    );
    const form = h(
        "form",
        { class: "dialog-form" },
        h("h2", {}, title),
        text ? h("p", { class: "dialog-text" }, text) : null,
        fields ? fields() : null,
        h(
            "div",
            { class: "dialog-actions" },
            h(
                "button",
                { type: "button", class: "btn ghost", onclick: () => box.close() },
                "Cancel",
            ),
            confirmButton,
        ),
    );
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const done = await act(confirmButton, () => submit(form));
        if (done !== false) box.close();
    });
    box.append(form);
    box.showModal();
    const first = form.querySelector("input, select, textarea");
    (first ?? confirmButton).focus();
}

function field(label, control, hint) {
    return h(
        "label",
        { class: "field" },
        h("span", { class: "field-label" }, label),
        control,
        hint ? h("span", { class: "field-hint" }, hint) : null,
    );
}

// Config draft -------------------------------------------------------------------------------

function getPath(object, path) {
    return path.split(".").reduce((value, key) => (value == null ? undefined : value[key]), object);
}

function setPath(object, path, value) {
    const keys = path.split(".");
    const last = keys.pop();
    let target = object;
    for (const key of keys) target = target[key];
    target[last] = value;
}

function dirty() {
    return state.config !== null && JSON.stringify(state.config) !== JSON.stringify(state.draft);
}

function updateSavebar() {
    const changed = dirty();
    $("savebar").hidden = !changed || state.token === null;
    $("save").disabled = state.invalid.size > 0;
    $("savebar-text").textContent =
        state.invalid.size > 0 ? "Some values are out of range" : "You have unsaved changes";
    document.body.classList.toggle("has-savebar", changed);
}

function setDraft(path, value) {
    setPath(state.draft, path, value);
    updateSavebar();
}

function toggleControl(path, label, hint) {
    const id = `cfg-${path}`;
    return h(
        "div",
        { class: "setting" },
        h(
            "div",
            { class: "setting-text" },
            h("label", { class: "setting-label", for: id }, label),
            hint ? h("p", { class: "setting-hint" }, hint) : null,
        ),
        h(
            "label",
            { class: "switch" },
            h("input", {
                type: "checkbox",
                id,
                role: "switch",
                checked: Boolean(getPath(state.draft, path)),
                onchange: (event) => setDraft(path, event.target.checked),
            }),
            h("span", { class: "switch-track", "aria-hidden": "true" }),
        ),
    );
}

function numberControl(path, label, { min, max, step = 1, unit, hint }) {
    const id = `cfg-${path}`;
    const input = h("input", {
        type: "number",
        id,
        class: "input number",
        min,
        max,
        step,
        value: String(getPath(state.draft, path)),
        oninput: () => {
            const raw = input.value.trim();
            const value = Number(raw);
            const ok = raw !== "" && Number.isFinite(value) && input.checkValidity();
            input.classList.toggle("invalid", !ok);
            if (ok) {
                state.invalid.delete(path);
                setDraft(path, value);
            } else {
                state.invalid.add(path);
                updateSavebar();
            }
        },
    });
    const range = max === undefined ? `${count(min)} or more` : `${count(min)} to ${count(max)}`;
    return h(
        "div",
        { class: "setting" },
        h(
            "div",
            { class: "setting-text" },
            h("label", { class: "setting-label", for: id }, label),
            h(
                "p",
                { class: "setting-hint" },
                hint ? `${hint} ` : "",
                h("span", { class: "range" }, range),
            ),
        ),
        h("div", { class: "number-wrap" }, input, unit ? h("span", { class: "unit" }, unit) : null),
    );
}

function textControl(path, label, hint) {
    const id = `cfg-${path}`;
    return h(
        "div",
        { class: "setting stacked" },
        h(
            "div",
            { class: "setting-text" },
            h("label", { class: "setting-label", for: id }, label),
            hint ? h("p", { class: "setting-hint" }, hint) : null,
        ),
        h("input", {
            type: "text",
            id,
            class: "input mono",
            spellcheck: "false",
            autocomplete: "off",
            value: String(getPath(state.draft, path) ?? ""),
            oninput: (event) => setDraft(path, event.target.value),
        }),
    );
}

function selectControl(path, label, options, hint) {
    const id = `cfg-${path}`;
    const current = getPath(state.draft, path) ?? "";
    return h(
        "div",
        { class: "setting" },
        h(
            "div",
            { class: "setting-text" },
            h("label", { class: "setting-label", for: id }, label),
            hint ? h("p", { class: "setting-hint" }, hint) : null,
        ),
        h(
            "select",
            {
                id,
                class: "input select",
                onchange: (event) => setDraft(path, event.target.value || null),
            },
            options(current),
        ),
    );
}

async function saveConfig() {
    if (!dirty() || state.invalid.size > 0) return;
    await act($("save"), async () => {
        const saved = await api("PUT", "/api/config", state.draft);
        state.config = saved;
        state.draft = structuredClone(saved);
        state.invalid.clear();
        updateSavebar();
        renderView();
        toast("Settings saved", "success");
        void loadStatus();
    });
}

function discardConfig() {
    state.draft = structuredClone(state.config);
    state.invalid.clear();
    updateSavebar();
    renderView();
}

// Data loading -------------------------------------------------------------------------------

async function loadStatus() {
    state.status = await api("GET", "/api/status");
    renderConn();
    if (state.section === "overview" || state.section === "storage") renderView();
}

async function loadConfig() {
    const config = await api("GET", "/api/config");
    const wasDirty = dirty();
    state.config = config;
    if (!wasDirty || state.draft === null) {
        state.draft = structuredClone(config);
        state.invalid.clear();
        if (CONFIG_SECTIONS.has(state.section)) renderView();
    }
    updateSavebar();
}

async function loadProviders() {
    const [providers, credentials] = await Promise.all([
        api("GET", "/api/providers"),
        api("GET", "/api/credentials"),
    ]);
    state.providers = providers;
    state.credentials = credentials;
    if (state.section === "models" || state.section === "dreaming") renderView();
}

async function loadProjects() {
    state.projects = await api("GET", `/api/projects${state.showMerged ? "?merged=1" : ""}`);
    if (["projects", "sessions", "runs", "overview"].includes(state.section)) renderView();
}

async function loadSessions() {
    const params = new URLSearchParams({ limit: "200" });
    if (state.sessionProject) params.set("project", state.sessionProject);
    state.sessions = await api("GET", `/api/sessions?${params}`);
    if (state.section === "sessions") renderView();
}

async function loadRuns() {
    state.runs = await api("GET", "/api/runs?limit=100");
    if (state.section === "runs") renderView();
}

function quietly(promise) {
    promise.catch((error) => {
        if (!(error instanceof LockedError)) console.warn(error);
    });
}

// Live events --------------------------------------------------------------------------------

function logActivity(text, tone = "neutral") {
    state.activity.unshift({ at: Date.now(), text, tone });
    state.activity.length = Math.min(state.activity.length, ACTIVITY_LIMIT);
    if (state.section === "overview") renderActivity();
}

function describeDream(data) {
    const detail = data?.data ?? {};
    switch (data?.type) {
        case "pass_started":
            return [`Dreaming pass started (${detail.trigger ?? "manual"})`, "accent"];
        case "session_analyzed":
            return detail.ok
                ? [`Analyzed ${detail.session}`, "neutral"]
                : [`Could not analyze ${detail.session}`, "danger"];
        case "project_committed":
            return [`Memory updated for ${projectName(detail.projectId)}`, "success"];
        case "project_failed":
            return [
                `Memory update failed for ${projectName(detail.projectId)}${detail.error ? `: ${detail.error}` : ""}`,
                "danger",
            ];
        case "global_finished":
            return [
                `Global memory ${detail.status === "ok" ? "updated" : detail.status}`,
                detail.status === "ok" ? "success" : "warning",
            ];
        case "projection_written":
            return [`Views written (${generationName(detail.generation)})`, "neutral"];
        case "pass_finished":
            return [
                `Dreaming pass finished: ${detail.status}`,
                STATUS_TONES[detail.status] ?? "neutral",
            ];
        default:
            return null;
    }
}

function onEvent(name, payload) {
    const data = payload?.data ?? {};
    if (name === "import") {
        if (data.error) logActivity(`Import failed: ${data.error}`, "danger");
        else {
            const parts = [`${count(data.imported)} imported`];
            if (data.purged) parts.push(`${count(data.purged)} removed`);
            if (data.errors) parts.push(plural(data.errors, "error"));
            logActivity(`Import: ${parts.join(", ")}`, data.errors ? "warning" : "neutral");
        }
        quietly(loadStatus());
        quietly(loadSessions());
        quietly(loadProjects());
    } else if (name === "dream") {
        const line = describeDream(data);
        if (line) logActivity(line[0], line[1]);
        if (
            data.type === "pass_started" ||
            data.type === "pass_finished" ||
            data.type === "project_committed"
        ) {
            quietly(loadStatus());
            quietly(loadRuns());
        }
        if (data.type === "pass_finished") quietly(loadSessions());
    } else if (name === "index") {
        if (data.action === "revert") logActivity(`Run ${data.runId} reverted`, "neutral");
        else if (data.action === "forget")
            logActivity(`Forgot session ${shortId(data.sessionId)}`, "neutral");
        else if (data.action === "regenerate")
            logActivity(`Views regenerated (${generationName(data.generation)})`, "neutral");
        else if (NOTE_ACTIONS[data.action]) logActivity(NOTE_ACTIONS[data.action], "neutral");
        quietly(loadStatus());
        quietly(loadRuns());
        quietly(loadSessions());
    } else if (name === "config") {
        if (data.credential) {
            logActivity(`Key ${data.set ? "saved" : "removed"} for ${data.credential}`, "neutral");
            quietly(loadProviders());
        } else {
            quietly(loadConfig());
            quietly(loadStatus());
        }
    }
}

async function streamEvents() {
    let delay = 1000;
    while (state.token) {
        try {
            const response = await fetch("/api/events", {
                cache: "no-store",
                headers: { Authorization: `Bearer ${state.token}`, Accept: "text/event-stream" },
            });
            if (response.status === 401) {
                lock();
                return;
            }
            if (!response.ok || !response.body)
                throw new Error(`Events answered ${response.status}`);
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let split;
                while ((split = buffer.indexOf("\n\n")) >= 0) {
                    const block = buffer.slice(0, split);
                    buffer = buffer.slice(split + 2);
                    let name = "message";
                    const lines = [];
                    for (const line of block.split("\n")) {
                        if (line.startsWith("event:")) name = line.slice(6).trim();
                        else if (line.startsWith("data:")) lines.push(line.slice(5).trimStart());
                    }
                    if (lines.length === 0) continue;
                    let payload = null;
                    try {
                        payload = JSON.parse(lines.join("\n"));
                    } catch {
                        continue;
                    }
                    if (name === "ready") {
                        const first = !state.connected && state.version === null;
                        state.connected = true;
                        state.version = payload?.version ?? null;
                        delay = 1000;
                        renderConn();
                        if (!first) quietly(refreshAll());
                    } else onEvent(name, payload);
                }
            }
        } catch {
            // The daemon stopped or restarts. Try again after a pause.
        }
        if (!state.token) return;
        state.connected = false;
        renderConn();
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 30_000);
    }
}

// Rendering: shell ---------------------------------------------------------------------------

function renderNav() {
    const nav = $("nav");
    nav.replaceChildren(
        ...SECTIONS.map((section) =>
            h(
                "a",
                {
                    href: `#${section.id}`,
                    class: `nav-item${section.id === state.section ? " active" : ""}`,
                    "aria-current": section.id === state.section ? "page" : undefined,
                },
                section.label,
            ),
        ),
    );
}

function renderConn() {
    const conn = $("conn");
    const busy = state.status?.daemon?.busy;
    conn.className = `conn ${state.connected ? (busy ? "busy" : "live") : "down"}`;
    const version = state.status?.daemon?.version ?? state.version;
    conn.textContent = state.connected
        ? `${busy ? "Dreaming" : "Connected"}${version ? ` · v${version}` : ""}`
        : "Reconnecting";
}

/** Render the current section. Keep the focused control when it is drawn again. */
function renderView() {
    const section = SECTIONS.find((entry) => entry.id === state.section) ?? SECTIONS[0];
    $("page-title").textContent = section.label;
    $("page-lede").textContent = section.lede;
    const focused = document.activeElement?.id;
    const view = $("view");
    view.replaceChildren(...[RENDERERS[section.id]()].flat());
    if (focused) {
        const again = document.getElementById(focused);
        if (again && again !== document.activeElement) again.focus({ preventScroll: true });
    }
}

function loading(text = "Loading") {
    return h("div", { class: "empty" }, text);
}

function card(title, aside, ...body) {
    return h(
        "section",
        { class: "card" },
        title || aside
            ? h("header", { class: "card-head" }, title ? h("h2", {}, title) : null, aside ?? null)
            : null,
        body,
    );
}

function empty(text) {
    return h("div", { class: "empty" }, text);
}

// Rendering: overview ------------------------------------------------------------------------

function stat(label, value, note) {
    return h(
        "div",
        { class: "stat" },
        h("div", { class: "stat-label" }, label),
        h("div", { class: "stat-value" }, value),
        note ? h("div", { class: "stat-note" }, note) : null,
    );
}

function renderOverview() {
    const status = state.status;
    if (!status) return loading();
    const counts = status.counts ?? {};
    const items = Object.values(counts.items ?? {}).reduce((sum, n) => sum + Number(n || 0), 0);
    const busy = Boolean(status.daemon?.busy);
    const dreaming = status.dreaming ?? {};
    const noModel = !dreaming.model;

    const importButton = h("button", { type: "button", class: "btn" }, "Import now");
    importButton.addEventListener("click", () =>
        act(importButton, async () => {
            const result = await api("POST", "/api/import", {});
            toast(
                `Import done: ${count(result.imported)} imported, ${count(result.unchanged)} unchanged`,
                "success",
            );
            await loadStatus();
        }),
    );
    const dreamButton = h(
        "button",
        { type: "button", class: "btn primary", disabled: busy || noModel },
        busy ? "Dreaming…" : "Dream now",
    );
    dreamButton.addEventListener("click", () =>
        act(dreamButton, async () => {
            await api("POST", "/api/dream", { force: true, wait: false });
            toast("Dreaming pass started", "success");
            await loadStatus();
        }),
    );
    const regenerateButton = h("button", { type: "button", class: "btn" }, "Regenerate views");
    regenerateButton.addEventListener("click", () =>
        act(regenerateButton, async () => {
            const result = await api("POST", "/api/regenerate", {});
            toast(`Views regenerated (${generationName(result.generation)})`, "success");
            await loadStatus();
        }),
    );

    const pass = status.lastPass;
    const harnesses = HARNESSES.map((id) => {
        const on = status.harnesses?.[id]?.enabled;
        return h(
            "span",
            { class: `chip ${on ? "on" : "off"}` },
            h("span", { class: "dot", "aria-hidden": "true" }),
            HARNESS_NAMES[id],
            h("span", { class: "chip-state" }, on ? "on" : "off"),
        );
    });

    return [
        h(
            "div",
            { class: "stats" },
            stat(
                "Sessions",
                count(counts.sessions),
                `${count(counts.unprocessed)} waiting for Dreaming`,
            ),
            stat("Projects", count(counts.projects)),
            stat("Memory items", count(items), itemBreakdown(counts.items)),
            stat(
                "Events",
                count(counts.events),
                `View generation ${generationName(status.generation)}`,
            ),
        ),
        h(
            "div",
            { class: "grid two" },
            card(
                "Dreaming",
                statusBadge(dreaming.enabled ? (busy ? "running" : "idle") : "skipped"),
                noModel
                    ? h(
                          "div",
                          { class: "notice warning" },
                          "No model is set, so no pass runs. ",
                          h("a", { href: "#dreaming" }, "Choose a model"),
                      )
                    : null,
                h(
                    "dl",
                    { class: "facts" },
                    fact("Model", dreaming.model ? h("code", {}, dreaming.model) : "None"),
                    fact("Thinking", dreaming.thinking ?? "low"),
                    fact("Schedule", dreaming.enabled ? "On" : "Off, manual passes only"),
                    fact(
                        "Last pass",
                        pass ? [statusBadge(pass.status), " ", stamp(pass.finishedAt)] : "None yet",
                    ),
                    pass
                        ? fact(
                              "Last pass work",
                              `${plural(pass.eligible, "eligible session")}, ${plural(pass.projects?.length ?? 0, "project")}${usageText(pass.usage) ? ` · ${usageText(pass.usage)}` : ""}`,
                          )
                        : null,
                ),
                pass?.errors?.length
                    ? h(
                          "ul",
                          { class: "problems" },
                          pass.errors.map((error) => h("li", {}, error)),
                      )
                    : null,
                h("div", { class: "actions" }, dreamButton, importButton, regenerateButton),
            ),
            card(
                "Sources",
                h("a", { href: "#sources", class: "link" }, "Edit"),
                h("div", { class: "chips" }, harnesses),
                h(
                    "dl",
                    { class: "facts" },
                    fact("Memory home", h("code", {}, status.home)),
                    fact("Views", h("code", {}, status.views)),
                    status.lastRun
                        ? fact("Last run", [
                              `#${status.lastRun.id} ${status.lastRun.kind} `,
                              statusBadge(status.lastRun.status),
                              " ",
                              stamp(status.lastRun.startedAt),
                          ])
                        : null,
                ),
            ),
        ),
        card(
            "Activity",
            h("span", { class: "muted small" }, "Live from the daemon"),
            h("ol", { class: "activity", id: "activity" }),
        ),
    ];
}

function itemBreakdown(items) {
    const entries = Object.entries(items ?? {}).filter(([, n]) => Number(n) > 0);
    if (entries.length === 0) return "No items yet";
    return entries.map(([kind, n]) => `${count(n)} ${kind.replace(/_/g, " ")}`).join(" · ");
}

function fact(label, value) {
    return h("div", { class: "fact" }, h("dt", {}, label), h("dd", {}, value));
}

function renderActivity() {
    const list = $("activity");
    if (!list) return;
    if (state.activity.length === 0) {
        list.replaceChildren(
            h("li", { class: "activity-empty" }, "Nothing yet. Events appear here as they happen."),
        );
        return;
    }
    list.replaceChildren(
        ...state.activity.map((entry) =>
            h(
                "li",
                { class: `activity-item ${entry.tone}` },
                h("span", { class: "dot", "aria-hidden": "true" }),
                h("span", { class: "activity-text" }, entry.text),
                h("span", { class: "activity-time" }, new Date(entry.at).toLocaleTimeString()),
            ),
        ),
    );
}

// Rendering: config sections -----------------------------------------------------------------

function renderSources() {
    if (!state.draft) return loading();
    return [
        ...HARNESSES.map((id) =>
            card(
                HARNESS_NAMES[id],
                badge(
                    state.draft.harnesses[id].enabled ? "Importing" : "Off",
                    state.draft.harnesses[id].enabled ? "success" : "neutral",
                ),
                toggleControl(`harnesses.${id}.enabled`, `Import ${HARNESS_NAMES[id]} sessions`),
                textControl(
                    `harnesses.${id}.root`,
                    "Session folder",
                    "The folder that holds the native session files.",
                ),
                h(
                    "p",
                    { class: "card-note" },
                    id === "pi"
                        ? [
                              "To load memory into Pi sessions, add the extension: ",
                              h("code", {}, "lune-memory setup pi"),
                              " prints the install command.",
                          ]
                        : [
                              "To load memory at session start, run ",
                              h("code", {}, `lune-memory setup ${id} --install-hook`),
                              ".",
                          ],
                ),
            ),
        ),
        card(
            "Import",
            null,
            numberControl("importSeconds", "Import interval", {
                min: 5,
                unit: "seconds",
                hint: "Time between import scans in the daemon.",
            }),
            toggleControl(
                "autoStart",
                "Start the daemon when needed",
                "Hooks, the MCP server and the Pi extension start the daemon in the background when it does not run.",
            ),
        ),
    ];
}

function modelOptions(current) {
    const providers = state.providers ?? [];
    const known = new Set();
    const groups = providers
        .filter((provider) => provider.models.length > 0)
        .sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name))
        .map((provider) =>
            h(
                "optgroup",
                { label: provider.configured ? provider.name : `${provider.name} (no key)` },
                provider.models.map((model) => {
                    const value = `${provider.id}/${model.id}`;
                    known.add(value);
                    return h(
                        "option",
                        { value, selected: value === current },
                        model.name || model.id,
                    );
                }),
            ),
        );
    return [
        h("option", { value: "", selected: !current }, "None (no Dreaming)"),
        current && !known.has(current)
            ? h(
                  "option",
                  { value: current, selected: true },
                  `${current}${state.providers ? " (not found)" : ""}`,
              )
            : null,
        groups,
    ];
}

function renderDreaming() {
    if (!state.draft) return loading();
    const model = state.draft.dreaming.model;
    const provider = model
        ? (state.providers ?? []).find((entry) => model.startsWith(`${entry.id}/`))
        : null;
    return [
        card(
            "Model",
            state.providers ? null : h("span", { class: "muted small" }, "Loading providers"),
            selectControl(
                "dreaming.model",
                "Dreaming model",
                modelOptions,
                "Sessions go to this model. Pick one whose provider has a key.",
            ),
            provider && !provider.configured
                ? h(
                      "div",
                      { class: "notice warning" },
                      `${provider.name} has no key yet. `,
                      h("a", { href: "#models" }, "Add a key"),
                  )
                : null,
            selectControl(
                "dreaming.thinking",
                "Thinking level",
                (current) =>
                    THINKING.map((level) =>
                        h("option", { value: level, selected: level === current }, level),
                    ),
                "Used when the model supports reasoning.",
            ),
        ),
        card(
            "Schedule",
            null,
            toggleControl(
                "dreaming.enabled",
                "Run scheduled passes",
                "When off, Dreaming runs only when you start it.",
            ),
            numberControl("dreaming.idleHours", "Idle time before Dreaming", {
                min: 0,
                step: 0.5,
                unit: "hours",
                hint: "A session waits this long after its last change.",
            }),
            numberControl("dreaming.scanMinutes", "Scan interval", {
                min: 1,
                unit: "minutes",
                hint: "Time between eligibility scans.",
            }),
            numberControl("dreaming.historyDays", "History limit", {
                min: 0,
                unit: "days",
                hint: "Older sessions are kept but never analyzed. 0 means no limit.",
            }),
        ),
        card(
            "Pass limits",
            null,
            numberControl("dreaming.maxSessionsPerPass", "Sessions per pass", { min: 1, max: 100 }),
            numberControl("dreaming.maxCharsPerSession", "Characters per session", {
                min: 1000,
                step: 1000,
                hint: "Longer sessions are cut to fit.",
            }),
            numberControl("dreaming.concurrency", "Parallel model calls", { min: 1, max: 16 }),
        ),
        card(
            "Retries",
            null,
            numberControl("dreaming.maxAttempts", "Attempts per session", {
                min: 1,
                max: 100,
                hint: "After this many failed passes, a session waits for new content.",
            }),
            numberControl("dreaming.maxRetries", "Retries per model call", { min: 0, max: 10 }),
        ),
    ];
}

function renderStorage() {
    if (!state.draft) return loading();
    const status = state.status;
    return [
        card(
            "Retention",
            null,
            numberControl("retentionDays", "Keep session events", {
                min: 0,
                unit: "days",
                hint: "Events of older sessions are deleted. 0 keeps everything.",
            }),
            numberControl("generations", "View generations", {
                min: 1,
                max: 20,
                hint: "Older Markdown views kept for restore.",
            }),
        ),
        status
            ? card(
                  "Locations",
                  null,
                  h(
                      "dl",
                      { class: "facts" },
                      fact("Memory home", h("code", {}, status.home)),
                      fact("Markdown views", h("code", {}, status.views)),
                      fact("Current generation", generationName(status.generation)),
                  ),
                  h(
                      "p",
                      { class: "card-note" },
                      "Set LUNE_MEMORY_HOME before the daemon starts to move the memory home.",
                  ),
              )
            : null,
    ];
}

// Rendering: models and keys -----------------------------------------------------------------

function renderModels() {
    if (!state.providers) return loading("Loading providers");
    const stored = new Set(state.credentials.map((entry) => entry.providerId));
    const filter = state.providerFilter.trim().toLowerCase();
    const keyed = state.providers
        .filter((provider) => provider.apiKey)
        .filter(
            (provider) =>
                !filter ||
                provider.name.toLowerCase().includes(filter) ||
                provider.id.toLowerCase().includes(filter),
        )
        .sort(
            (a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name),
        );
    const others = state.providers.filter((provider) => !provider.apiKey);

    const search = h("input", {
        type: "search",
        id: "provider-filter",
        class: "input",
        placeholder: "Filter providers",
        value: state.providerFilter,
        oninput: (event) => {
            state.providerFilter = event.target.value;
            renderView();
        },
    });

    return [
        h(
            "div",
            { class: "toolbar" },
            search,
            h("span", { class: "muted small" }, `${plural(keyed.length, "provider")}`),
        ),
        h(
            "div",
            { class: "list" },
            keyed.length === 0
                ? empty("No provider matches the filter.")
                : keyed.map((provider) => providerRow(provider, stored.has(provider.id))),
        ),
        others.length
            ? h(
                  "details",
                  { class: "more" },
                  h("summary", {}, `${plural(others.length, "provider")} without API keys`),
                  h(
                      "p",
                      { class: "card-note" },
                      "These providers sign in another way, for example OAuth through Pi or cloud credentials. lune-memory uses them when they are set up.",
                  ),
                  h(
                      "ul",
                      { class: "plain" },
                      others.map((provider) =>
                          h(
                              "li",
                              {},
                              provider.name,
                              " ",
                              provider.configured
                                  ? badge(sourceText(provider.source) || "Ready", "success")
                                  : badge("Not set up"),
                          ),
                      ),
                  ),
              )
            : null,
    ];
}

function providerRow(provider, hasStoredKey) {
    const setButton = h(
        "button",
        { type: "button", class: "btn small" },
        hasStoredKey ? "Replace key" : "Set key",
    );
    setButton.addEventListener("click", () =>
        dialog({
            title: `${provider.name} API key`,
            text: "The key is saved in the local credential file with owner-only access. It is not shown again.",
            confirm: "Save key",
            fields: () =>
                field(
                    "API key",
                    h("input", {
                        type: "password",
                        name: "key",
                        class: "input mono",
                        autocomplete: "off",
                        spellcheck: "false",
                        required: true,
                    }),
                ),
            submit: async (form) => {
                const key = form.elements.key.value.trim();
                if (!key) return false;
                await api("PUT", `/api/credentials/${encodeURIComponent(provider.id)}`, { key });
                toast(`Key saved for ${provider.name}`, "success");
                await loadProviders();
                return true;
            },
        }),
    );
    const removeButton = hasStoredKey
        ? h("button", { type: "button", class: "btn small ghost danger-text" }, "Remove")
        : null;
    removeButton?.addEventListener("click", () =>
        dialog({
            title: `Remove the ${provider.name} key?`,
            text: "Dreaming stops for models of this provider until a key is set again, unless an environment variable gives one.",
            confirm: "Remove key",
            danger: true,
            submit: async () => {
                await api("PUT", `/api/credentials/${encodeURIComponent(provider.id)}`, {
                    key: "",
                });
                toast(`Key removed for ${provider.name}`, "success");
                await loadProviders();
                return true;
            },
        }),
    );
    return h(
        "div",
        { class: "row" },
        h(
            "div",
            { class: "row-main" },
            h(
                "div",
                { class: "row-title" },
                provider.name,
                " ",
                h("code", { class: "muted" }, provider.id),
            ),
            h(
                "div",
                { class: "row-sub" },
                provider.configured
                    ? badge(sourceText(provider.source) || "Ready", "success")
                    : badge("No key"),
                " ",
                plural(provider.models.length, "model"),
            ),
        ),
        h("div", { class: "row-actions" }, removeButton, setButton),
    );
}

// Rendering: projects ------------------------------------------------------------------------

function renderProjects() {
    const registerButton = h(
        "button",
        { type: "button", class: "btn primary" },
        "Register project",
    );
    registerButton.addEventListener("click", () =>
        dialog({
            title: "Register a project",
            text: "Sessions under this folder, or under other clones of the same repository, join the project.",
            confirm: "Register",
            fields: () => [
                field(
                    "Folder",
                    h("input", {
                        name: "path",
                        class: "input mono",
                        required: true,
                        placeholder: "/path/to/project",
                        spellcheck: "false",
                    }),
                ),
                field(
                    "Name",
                    h("input", { name: "name", class: "input", placeholder: "Optional" }),
                ),
            ],
            submit: async (form) => {
                const path = form.elements.path.value.trim();
                const name = form.elements.name.value.trim();
                const project = await api("POST", "/api/projects", {
                    path,
                    ...(name ? { name } : {}),
                });
                toast(`Registered ${project.name}`, "success");
                await loadProjects();
                return true;
            },
        }),
    );
    const mergedToggle = h(
        "label",
        { class: "check" },
        h("input", {
            type: "checkbox",
            id: "show-merged",
            checked: state.showMerged,
            onchange: (event) => {
                state.showMerged = event.target.checked;
                quietly(loadProjects());
            },
        }),
        "Show merged projects",
    );
    const projects = state.projects;
    return [
        h("div", { class: "toolbar" }, registerButton, mergedToggle),
        h(
            "div",
            { class: "list" },
            projects.length === 0
                ? empty("No projects yet. They appear when sessions are imported.")
                : projects.map(projectRow),
        ),
    ];
}

function projectRow(project) {
    const active = state.projects.filter((entry) => !entry.mergedInto && entry.id !== project.id);
    const rename = h("button", { type: "button", class: "btn small ghost" }, "Rename");
    rename.addEventListener("click", () =>
        dialog({
            title: "Rename project",
            confirm: "Rename",
            fields: () =>
                field(
                    "Name",
                    h("input", {
                        name: "name",
                        class: "input",
                        required: true,
                        value: project.name,
                    }),
                ),
            submit: async (form) => {
                await api("POST", `/api/projects/${encodeURIComponent(project.id)}/rename`, {
                    name: form.elements.name.value.trim(),
                });
                toast("Project renamed", "success");
                await loadProjects();
                return true;
            },
        }),
    );
    const merge = h(
        "button",
        { type: "button", class: "btn small ghost", disabled: active.length === 0 },
        "Merge into…",
    );
    merge.addEventListener("click", () =>
        dialog({
            title: `Merge ${project.name}`,
            text: "Its sessions, memory and locators move to the target project. A locator seen again later brings the project back.",
            confirm: "Merge",
            danger: true,
            fields: () =>
                field(
                    "Target project",
                    h(
                        "select",
                        { name: "target", class: "input select" },
                        active.map((entry) => h("option", { value: entry.id }, entry.name)),
                    ),
                ),
            submit: async (form) => {
                await api("POST", "/api/projects/merge", {
                    source: project.id,
                    target: form.elements.target.value,
                });
                toast(`Merged ${project.name}`, "success");
                await loadProjects();
                return true;
            },
        }),
    );
    const locators = project.locators ?? [];
    const split = h(
        "button",
        { type: "button", class: "btn small ghost", disabled: locators.length < 2 },
        "Split…",
    );
    split.addEventListener("click", () =>
        dialog({
            title: `Split ${project.name}`,
            text: "Move one locator, and the sessions it matches, to a project of its own. When the locator made a project that was merged away, that project comes back. Those sessions are analyzed again.",
            confirm: "Split",
            danger: true,
            fields: () => [
                field(
                    "Locator",
                    h(
                        "select",
                        { name: "locator", class: "input select" },
                        locators.map((locator, index) =>
                            h(
                                "option",
                                { value: String(index) },
                                `${LOCATOR_NAMES[locator.kind] ?? locator.kind}: ${locator.value}`,
                            ),
                        ),
                    ),
                ),
                field(
                    "Project name",
                    h("input", { name: "name", class: "input", placeholder: "Optional" }),
                ),
            ],
            submit: async (form) => {
                const locator = locators[Number(form.elements.locator.value)];
                const name = form.elements.name.value.trim();
                await api("POST", "/api/projects/split", {
                    kind: locator.kind,
                    value: locator.value,
                    ...(name ? { name } : {}),
                });
                toast("Project split", "success");
                await loadProjects();
                return true;
            },
        }),
    );
    const mergedInto = project.mergedInto
        ? state.projects.find((entry) => entry.id === project.mergedInto)
        : null;
    return h(
        "div",
        { class: `row${project.mergedInto ? " dim" : ""}` },
        h(
            "div",
            { class: "row-main" },
            h(
                "div",
                { class: "row-title" },
                project.name,
                project.mergedInto
                    ? [" ", badge(`Merged into ${mergedInto?.name ?? shortId(project.mergedInto)}`)]
                    : null,
            ),
            project.root ? h("div", { class: "row-sub" }, h("code", {}, project.root)) : null,
            h(
                "div",
                { class: "chips" },
                locators.map((locator) =>
                    h(
                        "span",
                        { class: "chip small", title: locator.value },
                        h(
                            "span",
                            { class: "chip-kind" },
                            LOCATOR_NAMES[locator.kind] ?? locator.kind,
                        ),
                        locator.value,
                    ),
                ),
            ),
        ),
        project.mergedInto ? null : h("div", { class: "row-actions" }, rename, merge, split),
    );
}

// Rendering: sessions ------------------------------------------------------------------------

function renderSessions() {
    const filter = h(
        "select",
        {
            id: "session-project",
            class: "input select",
            onchange: (event) => {
                state.sessionProject = event.target.value;
                quietly(loadSessions());
            },
        },
        h("option", { value: "", selected: state.sessionProject === "" }, "All projects"),
        h(
            "option",
            { value: UNASSIGNED, selected: state.sessionProject === UNASSIGNED },
            "No project",
        ),
        state.projects
            .filter((project) => !project.mergedInto)
            .map((project) =>
                h(
                    "option",
                    { value: project.id, selected: state.sessionProject === project.id },
                    project.name,
                ),
            ),
    );
    const sessions = state.sessions;
    return [
        h(
            "div",
            { class: "toolbar" },
            filter,
            h("span", { class: "muted small" }, plural(sessions.length, "session")),
        ),
        sessions.length === 0
            ? empty("No sessions here yet.")
            : h(
                  "div",
                  { class: "table-wrap" },
                  h(
                      "table",
                      { class: "table" },
                      h(
                          "thead",
                          {},
                          h(
                              "tr",
                              {},
                              ["Session", "Project", "Updated", "Dreaming", ""].map((label) =>
                                  h("th", {}, label),
                              ),
                          ),
                      ),
                      h("tbody", {}, sessions.map(sessionRow)),
                  ),
              ),
    ];
}

function sessionState(session) {
    if (session.lastError && !session.processed) {
        return h(
            "span",
            { title: session.lastError },
            badge(`Failed ${session.attempts}×`, "danger"),
        );
    }
    return session.processed ? badge("Done", "success") : badge("Waiting", "neutral");
}

function sessionRow(session) {
    const forget = h("button", { type: "button", class: "btn small ghost danger-text" }, "Forget");
    forget.addEventListener("click", () =>
        dialog({
            title: "Forget this session?",
            text: "This deletes the session, its events and its transcript copy, and retires memory that rests only on it. The source file of the harness stays. This cannot be undone.",
            confirm: "Forget session",
            danger: true,
            submit: async () => {
                await api("POST", "/api/sessions/forget", {
                    harness: session.harness,
                    sessionId: session.id,
                });
                toast("Session forgotten", "success");
                await loadSessions();
                return true;
            },
        }),
    );
    return h(
        "tr",
        {},
        h(
            "td",
            {},
            h(
                "div",
                { class: "cell-title" },
                badge(HARNESS_NAMES[session.harness] ?? session.harness, "outline"),
                " ",
                session.title || h("span", { class: "muted" }, "Untitled"),
            ),
            h(
                "div",
                { class: "cell-sub" },
                h("code", { title: session.id }, shortId(session.id)),
                session.branch ? [" · ", session.branch] : null,
            ),
        ),
        h("td", {}, projectName(session.projectId)),
        h("td", { class: "nowrap" }, stamp(session.updatedAt)),
        h("td", {}, sessionState(session)),
        h("td", { class: "end" }, forget),
    );
}

// Rendering: runs ----------------------------------------------------------------------------

function renderRuns() {
    const runs = state.runs;
    if (runs.length === 0)
        return empty("No runs yet. A run appears when a Dreaming pass commits memory.");
    return h(
        "div",
        { class: "table-wrap" },
        h(
            "table",
            { class: "table" },
            h(
                "thead",
                {},
                h(
                    "tr",
                    {},
                    ["Run", "Project", "Started", "Status", "Detail", ""].map((label) =>
                        h("th", {}, label),
                    ),
                ),
            ),
            h("tbody", {}, runs.map(runRow)),
        ),
    );
}

function runRow(run) {
    const canRevert = run.status === "ok" && run.kind !== "revert";
    const revert = canRevert
        ? h("button", { type: "button", class: "btn small ghost" }, "Revert")
        : null;
    revert?.addEventListener("click", () =>
        dialog({
            title: `Revert run #${run.id}?`,
            text: "Memory items this run created go away, and items it changed go back to their earlier state.",
            confirm: "Revert run",
            danger: true,
            fields: () =>
                h(
                    "label",
                    { class: "check" },
                    h("input", { type: "checkbox", name: "reprocess", checked: true }),
                    "Analyze its sessions again in the next pass",
                ),
            submit: async (form) => {
                const result = await api("POST", `/api/runs/${run.id}/revert`, {
                    reprocess: form.elements.reprocess.checked,
                });
                toast(`Run #${run.id} reverted (${plural(result.items ?? 0, "item")})`, "success");
                await loadRuns();
                return true;
            },
        }),
    );
    const detail = [];
    if (run.model) detail.push(h("code", {}, run.model));
    if (run.sessions?.length) detail.push(h("span", {}, plural(run.sessions.length, "session")));
    const usage = usageText(run.usage);
    if (usage) detail.push(h("span", {}, usage));
    const time = duration(run.startedAt, run.finishedAt);
    if (time) detail.push(h("span", {}, time));
    return h(
        "tr",
        {},
        h(
            "td",
            {},
            h(
                "div",
                { class: "cell-title" },
                `#${run.id} `,
                h("span", { class: "muted" }, run.kind),
            ),
            h("div", { class: "cell-sub" }, run.trigger),
        ),
        h("td", {}, run.kind === "global" ? "All projects" : projectName(run.projectId)),
        h("td", { class: "nowrap" }, stamp(run.startedAt)),
        h("td", {}, statusBadge(run.status)),
        h(
            "td",
            {},
            h(
                "div",
                { class: "cell-meta" },
                detail.flatMap((node, index) =>
                    index ? [h("span", { class: "sep" }, "·"), node] : [node],
                ),
            ),
            run.error ? h("div", { class: "cell-error" }, run.error) : null,
            run.warnings?.length
                ? h("div", { class: "cell-warn" }, run.warnings.join(" · "))
                : null,
        ),
        h("td", { class: "end" }, revert),
    );
}

const RENDERERS = {
    overview: renderOverview,
    sources: renderSources,
    dreaming: renderDreaming,
    models: renderModels,
    projects: renderProjects,
    sessions: renderSessions,
    runs: renderRuns,
    storage: renderStorage,
};

// Navigation and start -----------------------------------------------------------------------

function sectionFromHash() {
    const id = location.hash.replace(/^#/, "");
    return SECTIONS.some((section) => section.id === id) ? id : "overview";
}

function navigate() {
    state.section = sectionFromHash();
    renderNav();
    renderView();
    if (state.section === "overview") renderActivity();
    $("main").scrollTo?.(0, 0);
}

async function refreshAll() {
    await Promise.all([loadStatus(), loadConfig(), loadProjects()]);
    await Promise.all([loadSessions(), loadRuns(), loadProviders()]);
}

async function start() {
    state.token = readToken();
    if (!state.token) {
        lock();
        return;
    }
    $("locked").hidden = true;
    $("app").hidden = false;
    $("save").addEventListener("click", () => void saveConfig());
    $("discard").addEventListener("click", discardConfig);
    window.addEventListener("hashchange", navigate);
    window.addEventListener("beforeunload", (event) => {
        if (dirty()) event.preventDefault();
    });
    document.addEventListener("keydown", (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "s" && dirty()) {
            event.preventDefault();
            void saveConfig();
        }
    });
    navigate();
    renderConn();
    try {
        await refreshAll();
        navigate();
    } catch (error) {
        if (!(error instanceof LockedError)) toast(error.message || String(error), "danger");
    }
    if (state.token) void streamEvents();
}

void start();

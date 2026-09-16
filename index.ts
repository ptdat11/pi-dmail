/**
 * D-Mail — model-driven context folding for Pi.
 *
 * The agent sees a long transcript and knows, right now, which parts of it it is
 * finished with. Pi gives it no way to say so. Compaction fires on a size
 * threshold and cuts by recency, so the material that is genuinely dead weight
 * competes for space with the material that matters.
 *
 * D-Mail closes that gap with one tool. `SendDMail(fromStep, summary)` records
 * that everything from `fromStep` up to the last completed step is finished with,
 * and that `summary` replaces it. A `context` hook replays those records on every
 * request, so the agent is sent the summary instead of the transcript.
 *
 * Three properties are worth stating plainly, because they are what make it safe
 * to let a model decide:
 *
 *   Non-destructive. Folding changes what is sent, never what is stored. Entries
 *   and files are untouched, so folding too much costs a re-read, not data.
 *
 *   Uncached. There is no fold state to lose. Records live in the session and are
 *   replayed from it, so folding survives resume and survives the extension being
 *   reloaded mid-session. The session toggle is not persisted; a new session starts
 *   from `dmail.enabled` in settings.json, defaulting to on.
 *
 * `/dmail` turns the whole thing off for the session: the tool is withdrawn, the
 * policy is withheld, and fold records stop being applied, so folded material comes
 * back. That is the escape hatch if a summary turns out to have dropped something.
 *
 *   Bounded damage. A fold that no longer resolves is skipped, not applied
 *   partially, and a fold can never separate an assistant message from its tool
 *   results — that is a hard provider error, and `fold.ts` refuses any range that
 *   would cause it.
 *
 * The algebra lives in `fold.ts`, which is pure and is the only thing unit-tested.
 * This file is wiring.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AgentMessage,
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type SessionEntry,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { FOLD_TYPE, foldContext, numberSteps, type FoldRecord, type NumberedStep } from "./fold.ts";
import { readSettingsFile, resolveDmailEnabled } from "./settings.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY_PATH = process.env.DMAIL_POLICY ?? join(HERE, "POLICY.md");

const TOOL_NAME = "SendDMail";
const COMMAND_NAME = "dmail";

/**
 * Footer status key. The leading space sorts it ahead of letter-keyed statuses, so
 * it survives the right-truncation Pi applies to the single joined status line.
 * Same convention, and same reason, as bash-guard's " bash-guard".
 */
const STATUS_KEY = " dmail";

/** Structural subset of Pi's theme, so this file needs no internal theme import. */
type BadgeTheme = {
	fg(color: "dim" | "error" | "text", text: string): string;
	bg(color: "toolErrorBg", text: string): string;
	bold(text: string): string;
	getFgAnsi(color: "border"): string;
};

/**
 * Pi exposes no blue background token, so the enabled badge borrows the theme's own
 * blue: `border` is blue in both built-in themes. Flipping the foreground escape to a
 * background escape (`38;` -> `48;`) reuses the form the theme already picked, so the
 * blue stays exact in truecolor and 256-color mode alike, with no second palette here.
 */
function onBlue(theme: BadgeTheme, text: string): string {
	const background = theme.getFgAnsi("border").replace("\u001b[38;", "\u001b[48;");
	return `${background}${text}\u001b[49m`;
}

/**
 * Default mode comes from settings.json, so the one key D-Mail owns has a single
 * place to be read and a single place to be documented.
 */
const SETTINGS_FILE = "settings.json";

/**
 * `--dmail-disabled` wins over settings, and settings win over the built-in on.
 * A project that is not trusted is not read, matching how Pi itself treats
 * `.pi/settings.json`.
 */
function configuredEnabled(ctx: ExtensionContext, flag: boolean | string | undefined): boolean {
	if (flag === true) return false;
	const globalText = readSettingsFile(join(getAgentDir(), SETTINGS_FILE));
	const projectText = ctx.isProjectTrusted()
		? readSettingsFile(join(ctx.cwd, CONFIG_DIR_NAME, SETTINGS_FILE))
		: undefined;
	return resolveDmailEnabled(globalText, projectText);
}

/**
 * OFF is the escape hatch and stays loud; ON now wears the same badge treatment in blue,
 * so the toggle reads as one control rather than a warning next to a word.
 */
function badge(theme: BadgeTheme, enabled: boolean): string {
	return enabled
		? onBlue(theme, theme.bold(theme.fg("text", " D-MAIL ON ")))
		: theme.bg("toolErrorBg", theme.bold(theme.fg("error", " \u26a0 D-MAIL OFF ")));
}

const OFF_MESSAGE =
	"D-Mail DISABLED for this session. Folding stops and the raw transcript goes out instead, " +
	"so anything folded earlier is back in context. Run /dmail again to re-enable.";

/** Injecting nothing would leave the tool undiscoverable, so keep a floor. */
const FALLBACK_POLICY = [
	"You have a `SendDMail` tool: it folds a range of finished steps out of your context and replaces them with a summary you write.",
	"Fold a step as soon as you have taken what you need from it and will not need to read it again. Do not wait for a phase boundary.",
	"Steps are numbered in the conversation as `[step N]`. Pass the earliest step you are done with as `fromStep`.",
].join("\n");

let cachedPolicy: string | undefined;

function policy(): string {
	if (cachedPolicy !== undefined) return cachedPolicy;
	let text = "";
	try {
		text = readFileSync(POLICY_PATH, "utf8").trim();
	} catch {
		// A missing policy file is not worth failing a session over.
	}
	cachedPolicy = text.length > 0 ? text : FALLBACK_POLICY;
	return cachedPolicy;
}

function isAssistantEntry(entry: SessionEntry): boolean {
	return entry.type === "message" && entry.message.role === "assistant";
}

function stepsIn(entries: readonly SessionEntry[]): NumberedStep[] {
	return numberSteps(entries, isAssistantEntry);
}

function userMessage(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

/**
 * Read fold records from the current view.
 *
 * `buildContextEntries()` is the right source: it is already scoped to the active
 * branch and already accounts for Pi's own compaction, so records on an abandoned
 * branch, or on the far side of a compaction boundary, are invisible rather than
 * wrongly replayed.
 */
function readFolds(entries: readonly SessionEntry[]): FoldRecord[] {
	const folds: FoldRecord[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== FOLD_TYPE) continue;
		const data = entry.data as Partial<FoldRecord> | undefined;
		if (!data) continue;
		if (typeof data.fromEntryId !== "string" || typeof data.toEntryId !== "string") continue;
		if (typeof data.summary !== "string") continue;
		folds.push({
			fromEntryId: data.fromEntryId,
			toEntryId: data.toEntryId,
			summary: data.summary,
			fromStep: typeof data.fromStep === "number" ? data.fromStep : undefined,
		});
	}
	return folds;
}

export default function dmail(pi: ExtensionAPI): void {
	// Session-local, deliberately. A toggle is not a setting, and it should not outlive
	// the session that asked for it — the same choice bash-guard made. The *starting*
	// value is a setting (settings.json `dmail.enabled`); this only overrides it.
	let enabled = true;
	// True only while *we* are the ones hiding the tool, so that re-enabling does not
	// hand SendDMail back to a user who had deliberately deactivated it.
	let toolSuppressed = false;

	const paint = (ctx: ExtensionContext): void => {
		try {
			ctx.ui.setStatus(STATUS_KEY, badge(ctx.ui.theme, enabled));
		} catch {
			// A front end that cannot draw a status must not break the session.
		}
	};

	/**
	 * Keep `SendDMail` out of the advertised tool list while disabled. Rebuilding the
	 * list from `getActiveTools()` rather than from a constant means we never clobber
	 * another extension's tool configuration.
	 */
	const applyToolVisibility = (): void => {
		try {
			const active = pi.getActiveTools();
			const listed = active.includes(TOOL_NAME);
			if (!enabled && listed) {
				pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
				toolSuppressed = true;
			} else if (enabled && toolSuppressed && !listed) {
				pi.setActiveTools([...active, TOOL_NAME]);
				toolSuppressed = false;
			}
		} catch {
			// Advertising is cosmetic; the execute guard below still refuses the call.
		}
	};

	pi.registerFlag("dmail-disabled", {
		description:
			"Force D-Mail off for this session, overriding settings.json (folding off; /dmail re-enables it).",
		type: "boolean",
		default: false,
	});

	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "startup") {
			// Registered name, no leading dashes: getFlag matches the name passed to
			// registerFlag exactly, and returns undefined for anything else.
			enabled = configuredEnabled(ctx, pi.getFlag("dmail-disabled"));
		}
		applyToolVisibility();
		paint(ctx);
	});

	pi.registerCommand(COMMAND_NAME, {
		description: "Turn D-Mail on or off for this session. No argument toggles; also accepts on, off, status.",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") enabled = true;
			else if (arg === "off") enabled = false;
			else if (arg === "") enabled = !enabled;
			else if (arg !== "status") {
				ctx.ui.notify(`Unknown argument "${arg}". Use /dmail, /dmail on, /dmail off, or /dmail status.`, "warning");
				return;
			}

			applyToolVisibility();
			paint(ctx);
			if (arg === "status") {
				ctx.ui.notify(enabled ? "D-Mail is ON." : OFF_MESSAGE, enabled ? "info" : "warning");
				return;
			}
			ctx.ui.notify(enabled ? "D-Mail enabled. Folding resumes." : OFF_MESSAGE, enabled ? "info" : "warning");
		},
	});

	// The policy goes in the system prompt, re-prepended on top of whatever the
	// assembly produced, because the event result replaces rather than appends. While
	// disabled it is withheld: instructing the model to fold, on a request that will
	// not be folded, is the one thing guaranteed to confuse it.
	pi.on("before_agent_start", async (event) => {
		if (!enabled) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${policy()}` };
	});

	pi.on("context", async (_event, ctx) => {
		// Guarded before the try, not inside it: disabled is a decision, not a failure.
		if (!enabled) return undefined;
		try {
			const entries = ctx.sessionManager.buildContextEntries();

			// Numbers come from the branch, so a step keeps its number even after it
			// has been folded away. Markers are only emitted for steps still in view.
			const stepOfEntry = new Map(stepsIn(ctx.sessionManager.getBranch()).map((s) => [s.entryId, s.step]));

			const result = foldContext<SessionEntry, AgentMessage>(entries, readFolds(entries), {
				convert: (entry) => sessionEntryToContextMessages(entry),
				summaryMessage: (wrappedText) => userMessage(wrappedText, Date.now()),
				beforeEntry: (entry) => {
					const step = stepOfEntry.get(entry.id);
					if (step === undefined) return undefined;
					// A stable timestamp keeps the marker byte-identical across requests.
					return userMessage(`[step ${step}]`, Date.parse(entry.timestamp) || Date.now());
				},
				isStepStart: isAssistantEntry,
			});

			if (!result.changed || result.messages.length === 0) return undefined;
			return { messages: result.messages };
		} catch {
			// A context hook must never break a request: fall through to Pi's view.
			return undefined;
		}
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "SendDMail",
		description:
			"Fold a range of finished steps out of your context and replace them with a summary you write. " +
			"Everything from `fromStep` up to the last completed step stops being sent; the step you are in is kept. " +
			"Nothing is deleted from the session or from disk, so folding too much costs only a re-read.",
		promptSnippet: "SendDMail — fold finished steps out of context, replacing them with a summary you write",
		parameters: Type.Object({
			fromStep: Type.Number({
				description: "Number of the earliest step to fold, as shown by the [step N] markers.",
			}),
			summary: Type.String({
				description: "What replaces the folded steps. Include everything later steps depend on.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!enabled) {
				throw new Error(
					"D-Mail is disabled for this session, so nothing can be folded. " +
						"Ask the user to run /dmail if folding is needed.",
				);
			}

			const branchSteps = stepsIn(ctx.sessionManager.getBranch());
			const entries = ctx.sessionManager.buildContextEntries();
			const visible = new Set(entries.map((entry) => entry.id));
			const visibleSteps = branchSteps.filter((step) => visible.has(step.entryId));
			const listed = visibleSteps.map((step) => step.step).join(", ") || "none";

			const target = branchSteps.find((step) => step.step === params.fromStep);
			if (!target) {
				throw new Error(`There is no step ${params.fromStep}. Visible steps: [${listed}].`);
			}
			if (!visible.has(target.entryId)) {
				throw new Error(
					`Step ${params.fromStep} has already been folded out of view. Visible steps: [${listed}].`,
				);
			}
			if (params.summary.trim() === "") {
				throw new Error("The summary is empty. Write what should replace the folded steps.");
			}

			// The end is resolved once, here, and frozen. Re-deriving it later would let
			// the fold keep swallowing every step that follows it.
			const current = visibleSteps[visibleSteps.length - 1];
			if (!current || target.step >= current.step) {
				throw new Error(
					`Step ${params.fromStep} is the step you are in, so there is nothing finished to fold yet.`,
				);
			}

			pi.appendEntry<FoldRecord>(FOLD_TYPE, {
				fromEntryId: target.entryId,
				toEntryId: current.entryId,
				summary: params.summary.trim(),
				fromStep: target.step,
			});

			const through = current.step - 1;
			// Best effort: a fold that succeeded must not be reported as a failure just
			// because the front end could not draw a notification.
			try {
				ctx.ui.notify(`Folded steps ${target.step}–${through}. In effect from the next request.`, "info");
			} catch {
				// Ignore.
			}

			return {
				content: [
					{
						type: "text" as const,
						text: `Folded steps ${target.step} through ${through}. They are replaced by your summary from the next request on.`,
					},
				],
				details: {
					fromStep: target.step,
					throughStep: through,
					fromEntryId: target.entryId,
					toEntryId: current.entryId,
				},
			};
		},
	});
}

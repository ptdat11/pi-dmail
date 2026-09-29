/**
 * D-Mail — model-driven context folding for Pi.
 *
 * The agent sees a long transcript and knows, right now, which parts of it it is
 * finished with. Pi gives it no way to say so. Compaction fires on a size
 * threshold and cuts by recency, so the material that is genuinely dead weight
 * competes for space with the material that matters.
 *
 * D-Mail closes that gap with one tool. `send_dmail(fromStep, summary)` records
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
 * `/send-dmail` is the opposite nudge: it asks the agent to fold now, starting at
 * the earliest step still in view.
 *
 *   Bounded damage. A fold that no longer resolves is skipped, not applied
 *   partially, and a fold can never separate an assistant message from its tool
 *   results — that is a hard provider error, and `fold.ts` refuses any range that
 *   would cause it.
 *
 * The algebra lives in `fold.ts`, which is pure and carries its own unit tests;
 * `test/` drives this file through a fake Pi. This file is wiring.
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
	keyHint,
	type SessionEntry,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	FOLD_TYPE,
	foldContext,
	numberSteps,
	planReplay,
	type FoldRecord,
	type LocatedFold,
	type NumberedStep,
	type ReplayPlan,
} from "./fold.ts";
import { type FoldRenderDetails, foldResultText, foldSkippedLine } from "./render.ts";
import { readSettingsFile, resolveDmailEnabled } from "./settings.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY_PATH = process.env.DMAIL_POLICY ?? join(HERE, "POLICY.md");

const TOOL_NAME = "send_dmail";
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

/**
 * `/send-dmail` injects this as a user message. It is deliberately short: the
 * mechanics live in POLICY.md, so this only states the thing the user is asking
 * for. "Still shown to you" is the load-bearing phrase — it is what makes the
 * agent start at the first un-folded step rather than a number that has already
 * been folded away.
 */
const SEND_DMAIL_PROMPT =
	"Send D-Mail now. Fold from the earliest step still shown to you; the step you are in is kept. " +
	"Put everything later steps depend on into the summary.";

/** Injecting nothing would leave the tool undiscoverable, so keep a floor. */
const FALLBACK_POLICY = [
	"You have a `send_dmail` tool: it folds a range of finished steps out of your context and replaces them with a summary you write.",
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
 * Read every fold record on the active branch, tagged with the entry that holds
 * it, so a replay plan can split the ones still inside the compaction view from
 * the ones a boundary pushed out. Reading the branch (not the view) is what makes
 * an out-of-view record countable instead of silently absent; whether it may
 * replay is `planReplay`'s era check on `holderEntryId`.
 */
function readFolds(entries: readonly SessionEntry[]): LocatedFold[] {
	const folds: LocatedFold[] = [];
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
			holderEntryId: entry.id,
		});
	}
	return folds;
}

/**
 * Plan a replay for the current view: era split first, then validation — so the
 * count is exactly what replay would skip. Both call sites (context hook and
 * tool result) go through here; if they planned separately, the tool could
 * report a number the hook does not agree with.
 */
function planForView(entries: readonly SessionEntry[], branch: readonly SessionEntry[]): ReplayPlan {
	return planReplay(entries, readFolds(branch), { isStepStart: isAssistantEntry });
}

export default function dmail(pi: ExtensionAPI): void {
	// Session-local, deliberately. A toggle is not a setting, and it should not outlive
	// the session that asked for it — the same choice bash-guard made. The *starting*
	// value is a setting (settings.json `dmail.enabled`); this only overrides it.
	let enabled = true;
	// True only while *we* are the ones hiding the tool, so that re-enabling does not
	// hand send_dmail back to a user who had deliberately deactivated it.
	let toolSuppressed = false;

	const paint = (ctx: ExtensionContext): void => {
		try {
			ctx.ui.setStatus(STATUS_KEY, badge(ctx.ui.theme, enabled));
		} catch {
			// A front end that cannot draw a status must not break the session.
		}
	};

	/**
	 * Keep `send_dmail` out of the advertised tool list while disabled. Rebuilding the
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

	// A nudge, not a command that folds by itself: the model still owns the summary,
	// and the step numbering it needs is already in its context as [step N] markers.
	pi.registerCommand("send-dmail", {
		description:
			"Ask the agent to fold now: it starts at the earliest step still in view and runs through the last completed step.",
		handler: async (_args, ctx) => {
			if (!enabled) {
				ctx.ui.notify("D-Mail is off, so there is nothing to send. Run /dmail to turn it on.", "warning");
				return;
			}
			if (!pi.getActiveTools().includes(TOOL_NAME)) {
				ctx.ui.notify(
					`The ${TOOL_NAME} tool is not active, so the agent cannot fold. Enable it from /tools first.`,
					"warning",
				);
				return;
			}
			// The in-flight turn that will answer this is itself a step, so one visible
			// step is already enough to fold. Only an empty view has nothing to work with.
			if (stepsIn(ctx.sessionManager.buildContextEntries()).length === 0) {
				ctx.ui.notify("Nothing to fold yet — no steps in view.", "warning");
				return;
			}

			if (ctx.isIdle()) {
				pi.sendUserMessage(SEND_DMAIL_PROMPT);
				return;
			}
			pi.sendUserMessage(SEND_DMAIL_PROMPT, { deliverAs: "followUp" });
			ctx.ui.notify("D-Mail requested. The agent will fold once it finishes the current turn.", "info");
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

			// Era split first: records a compaction boundary pushed out of the view are
			// skipped (never replayed), while everything still in view replays exactly
			// as before.
			const plan = planForView(entries, ctx.sessionManager.getBranch());

			const result = foldContext<SessionEntry, AgentMessage>(entries, plan.inEra, {
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
		label: "Send D-Mail",
		description:
			"Fold a range of finished steps out of your context and replace them with a summary you write. " +
			"Everything from `fromStep` up to the last completed step stops being sent; the step you are in is kept. " +
			"Nothing is deleted from the session or from disk, so folding too much costs only a re-read.",
		promptSnippet: "send_dmail — fold finished steps out of context, replacing them with a summary you write",
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

			const branch = ctx.sessionManager.getBranch();
			const branchSteps = stepsIn(branch);
			const entries = ctx.sessionManager.buildContextEntries();
			// Planned before appending: the record this call is about to write is not in
			// the `entries` snapshot, so reading it here would miscount it as orphaned.
			const { skipped } = planForView(entries, branch);
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

			// Skipped records are counted, never dropped silently: the count rides the
			// result so every view of it (raw fallback, collapsed, expanded) can say so.
			const skipLine = foldSkippedLine(skipped.length);
			const hasSkips = skipLine !== "";
			const headline = `Folded steps ${target.step} through ${through}. They are replaced by your summary from the next request on.`;
			return {
				content: [
					{
						type: "text" as const,
						text: hasSkips ? `${headline}\n${skipLine}` : headline,
					},
				],
				details: {
					fromStep: target.step,
					throughStep: through,
					fromEntryId: target.entryId,
					toEntryId: current.entryId,
					...(hasSkips ? { skipped: skipped.length } : {}),
				},
			};
		},
		/**
		 * Pi draws this instead of the raw `content` line, which named the folded
		 * range but never showed the summary. Collapsed it previews the summary and
		 * advertises the expand key; expanded it shows the summary whole.
		 */
		renderResult(result, { expanded }, theme, context) {
			const summary = typeof context.args.summary === "string" ? context.args.summary : "";
			const text = foldResultText(
				(result.details ?? {}) as FoldRenderDetails,
				summary,
				keyHint("app.tools.expand", "to expand"),
				expanded,
			);
			return new Text(`${theme.fg("success", "✓")} ${text}`, 0, 0);
		},
	});
}

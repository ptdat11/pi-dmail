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
 * `/send-dmail` is an alias of `/dmail fold`: the same picker, the same pinned
 * range, the same prompt-delivery path — the user picks both cut ends either way.
 *
 *   Bounded damage. A fold that no longer resolves is skipped, not applied
 *   partially, and a fold can never separate an assistant message from its tool
 *   results — that is a hard provider error, and `fold.ts` refuses any range that
 *   would cause it.
 *
 * The algebra lives in `fold.ts`, which is pure and carries its own unit tests;
 * `test/` drives this file through a fake Pi. This file is wiring — plus
 * planFold/estimateFold, the one plan the fold, its `preview` flag, and
 * `/dmail price` all run through, which needs the session view pi hands here.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getLatestCompactionEntry,
	keyHint,
	type SessionEntry,
	type SessionMessageEntry,
	estimateTokens,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	archivedSpanOf,
	FOLD_TYPE,
	foldContext,
	isArchivedMidStart,
	numberSteps,
	planReplay,
	wrapSummary,
	type FoldRecord,
	type LocatedFold,
	type NumberedStep,
	type ReplayPlan,
} from "./fold.ts";
import { redactFoldCalls } from "./dedupe.ts";
import { evaluateEconomics, type Economics } from "./economics.ts";
import {
	type FoldRenderDetails,
	foldAdvisoryText,
	foldEconomicsLine,
	foldHeadline,
	foldHeadroomLine,
	foldResultText,
	foldSkippedLine,
	foldSummaryPreview,
} from "./render.ts";
import { readSettingsFile, resolveDmailEnabled } from "./settings.ts";
import {
	buildFoldPickerRows,
	endRefusal,
	endStepOf,
	estimateLine,
	ESTIMATE_LEGEND,
	foldBracket,
	type FoldPin,
	latestFinishedStep,
	PICKER_END_TITLE,
	PICKER_TITLE,
	validEnds,
} from "./picker.ts";
import { FoldPickerComponent } from "./picker-ui.ts";

/**
 * The message shape pi records entries with. pi used to export `AgentMessage`
 * from its package root and no longer does (0.87.x), so derive it from the
 * exported `SessionMessageEntry` pi itself declares entries with — if pi
 * changes the message type, typecheck fails here instead of the seam drifting
 * silently against the type pi actually writes.
 */
type AgentMessage = SessionMessageEntry["message"];

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
 * `/dmail fold` (and its alias `/send-dmail`) pin a START and an END; this is the
 * prompt that delivers them — idle → plain send, busy → followUp. The agent owns the
 * prose: it writes the summary and performs the fold over exactly that range.
 *
 * The call always names `throughStep`. The tool's default end is "the last completed
 * step", measured when the fold runs — a round after this prompt is read, and a later
 * round in the same turn moves it further, so it can name a step the user never
 * pinned. Naming the end is free and cannot drift.
 */
function foldPinPrompt(
	fromStep: number,
	throughStep: number,
	latestFinishedStep: number,
	newestAtPinTime: boolean,
): string {
	const lead =
		throughStep < latestFinishedStep
			? ". "
			: newestAtPinTime
				? " — the newest step in view, which folds because the round that folds is the step after it. "
				: ", the latest finished step. ";
	return (
		`The user pinned the cut: fold from step ${fromStep} through step ${throughStep}` +
		lead +
		`Fold from exactly step ${fromStep} and stop exactly at step ${throughStep} — the user owns the cut range. ` +
		`Write the summary yourself with send_dmail(fromStep=${fromStep}, throughStep=${throughStep}, summary) — ` +
		`keep everything later steps depend on; tell the user when the fold lands.`
	);
}

/** Injecting nothing would leave the tool undiscoverable, so keep a floor. */
const FALLBACK_POLICY = [
	"You have a `send_dmail` tool: it folds a range of finished steps out of your context and replaces them with a summary you write.",
	"Fold a step as soon as you have taken what you need from it and will not need to read it again. Do not wait for a phase boundary.",
	"Steps are numbered in the conversation as `[step N]`. Pass the earliest step you are done with as `fromStep`.",
	"Pass `throughStep` (inclusive) to stop the fold before the last completed step; omit it to fold through the last completed step.",
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

// The message object of an entry when the entry is a message. AgentMessage is
// a union; only message-shaped members carry role/content, so both readers go
// through this one structural view instead of casting at each use site.
function messageOf(entry: SessionEntry | undefined): { role?: unknown; content?: unknown } | undefined {
	if (!entry || entry.type !== "message") return undefined;
	return entry.message as { role?: unknown; content?: unknown };
}

// The previewable text of an entry: text parts, plus tool calls as
// `<tool_name>: <params>` (the /tree row format) so a bare tool-call step
// isn't blank. The picker preview keeps the first line.
function entryText(entry: SessionEntry | undefined): string {
	const content = messageOf(entry)?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part): string => {
			if (!part || typeof part !== "object") return "";
			const block = part as { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown };
			if (block.type === "toolCall") {
				const params = JSON.stringify(block.arguments ?? {});
				return `${String(block.name ?? "tool")}: ${params}`;
			}
			return "text" in block ? String(block.text ?? "") : "";
		})
		.join("\n");
}

/** The role of a step's entry message (the picker labels each row with it). */
function entryRole(entry: SessionEntry | undefined): string | undefined {
	const role = messageOf(entry)?.role;
	return typeof role === "string" ? role : undefined;
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
 * count is exactly what replay would skip. Every site that plans a replay (tool
 * results, the context hook, the compaction seam) goes through here; if they
 * planned separately, one could report a number the others do not agree with.
 */
function planForView(entries: readonly SessionEntry[], branch: readonly SessionEntry[]): ReplayPlan {
	return planReplay(entries, readFolds(branch), { isStepStart: isAssistantEntry });
}

/**
 * One line prefixed to the spliced guidance channel: fold summaries are a lossy
 * editorial layer — they omit details on purpose — while the raw messages pi
 * summarizes are the material of record, so the summarizer trusts the narrative
 * for shape and goes back to the raw text for facts.
 */
const FOLD_CHANNEL_INSTRUCTION = "Fold summaries may omit details; the raw messages below are authoritative.";

/**
 * The current compaction era: branch entries from the latest compaction boundary
 * to the end — the material pi's compaction is about to summarize.
 *
 * The boundary is the latest compaction entry's `firstKeptEntryId` (pi's own
 * `getLatestCompactionEntry` finds it), which is the same membership
 * `buildContextEntries` keeps in the context view, so a record held before the
 * boundary is out-of-era here exactly when it is out of view for replay. No
 * compaction yet means the whole branch is the era.
 */
function currentEraOf(branch: readonly SessionEntry[]): SessionEntry[] {
	const compaction = getLatestCompactionEntry([...branch]);
	if (!compaction) return [...branch];
	const kept = branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
	if (kept >= 0) return [...branch.slice(kept)];
	// Stale boundary (the kept entry left the branch): fall back to what pi's own
	// projection would keep — entries after the compaction record — so nothing
	// from before the boundary can leak into the era.
	const at = branch.findIndex((entry) => entry.id === compaction.id);
	return at < 0 ? [] : [...branch.slice(at + 1)];
}

/**
 * The steps addressable in the current view: branch steps whose holder entry
 * survived into the context view. Both the fold's validation and `/dmail
 * price`'s candidate enumeration read the view through this one shape.
 */
function visibleStepsOf(entries: readonly SessionEntry[], branch: readonly SessionEntry[]): NumberedStep[] {
	const visible = new Set(entries.map((entry) => entry.id));
	return stepsIn(branch).filter((step) => visible.has(step.entryId));
}

/**
 * Refuse a fold that starts inside an already-folded span, naming the marker that
 * absorbs the existing summary instead (tickets 12 and 14). The record would be
 * well-formed but its start would not contain the old fold's start, so suppression
 * would leave the old memo standing and place a second, overlapping one beside it.
 * A picker row can never trigger this — a region row starts where its summary
 * starts — so this is the guard on what the agent or a typed range asks for.
 */
function midStartRefusal(
	entries: readonly SessionEntry[],
	branchSteps: readonly NumberedStep[],
	inEra: readonly FoldRecord[],
	target: NumberedStep,
): string | undefined {
	const positionOf = new Map(entries.map((entry, i) => [entry.id, i]));
	const targetPos = positionOf.get(target.entryId);
	if (targetPos === undefined) return undefined;
	const spans: (readonly [number, number])[] = [];
	let enclosing: FoldRecord | undefined;
	for (const fold of inEra) {
		const from = positionOf.get(fold.fromEntryId);
		const to = positionOf.get(fold.toEntryId);
		if (from === undefined || to === undefined) continue;
		spans.push([from, to]);
		enclosing ??= isArchivedMidStart(targetPos, [[from, to]]) ? fold : undefined;
	}
	const span = archivedSpanOf(targetPos, spans);
	if (span === undefined || enclosing === undefined) return undefined;
	const stepAt = new Map(branchSteps.map((step) => [step.entryId, step]));
	// The last step the fold archives is the step before its `to` entry, which is a
	// step start by the pairing invariant, so there is always one to name.
	const start = stepAt.get(enclosing.fromEntryId);
	const through = branchSteps.filter((step) => step.index < (positionOf.get(enclosing!.toEntryId) ?? Infinity)).at(-1);
	if (!start || !through) return undefined;
	return (
		`Step ${target.step} is inside a fold that already covers steps ${start.step} – ${through.step}. ` +
		`Fold from step ${start.step} instead: that is the marker of the summary to absorb, ` +
		`whereas folding from inside it would leave both summaries standing.`
	);
}

/** A fold fully decided: the validated range, the trimmed summary, its estimate. */
interface FoldPlan {
	target: NumberedStep;
	/** The inclusive end, exactly as the user or agent chose it. */
	through: number;
	/**
	 * The first step kept: the exclusive end of the archive and of the fold record.
	 * Unset only for an estimate of a cut that ends at the newest step in view while
	 * nothing is in progress — there is no kept step until the folding round arrives.
	 */
	to: NumberedStep | undefined;
	/** The summary as a fold would record it: trimmed. */
	summary: string;
	/** How many fold records replay skipped when the view was planned. */
	skipped: number;
	economics: Economics;
}

/**
 * The end of a fold, decided once against the live view (tickets 12 and 13). `through`
 * is the inclusive end — the caller's choice, or the latest foldable step by default —
 * and `to` is the first step kept, which is what the fold record's exclusive
 * `toEntryId` reads. Both endpoints are visible step starts, so the record cannot cut a
 * tool call from its result and replay's pairing invariant stays structural.
 *
 * `inFlight` is the step being written right now, which is never foldable. Omit it when
 * nothing is running — an idle session, where the newest step is a finished step and
 * folds, with no step kept after it in this view (`to` is undefined) because the round
 * that writes the fold has not arrived yet. With a step in flight every legal end is
 * below it, so `to` always exists: the tool's own fold is written from a round after the
 * whole view, which makes that case closed by type instead of by a runtime assertion.
 *
 * A chosen end that is not foldable (older than the start, or in progress) refuses by
 * naming the ends that are valid, in the picker's latest-to-oldest order.
 */
function resolveEnd(
	visibleSteps: readonly NumberedStep[],
	target: NumberedStep,
	throughStep: number | undefined,
	inFlight: NumberedStep,
): { to: NumberedStep; through: number };
function resolveEnd(
	visibleSteps: readonly NumberedStep[],
	target: NumberedStep,
	throughStep: number | undefined,
	inFlight: undefined,
): { to: NumberedStep | undefined; through: number };
function resolveEnd(
	visibleSteps: readonly NumberedStep[],
	target: NumberedStep,
	throughStep: number | undefined,
	inFlight: NumberedStep | undefined,
): { to: NumberedStep | undefined; through: number };
function resolveEnd(
	visibleSteps: readonly NumberedStep[],
	target: NumberedStep,
	throughStep: number | undefined,
	inFlight: NumberedStep | undefined,
): { to: NumberedStep | undefined; through: number } {
	const ends = validEnds(visibleSteps, inFlight, target.step);
	if (ends.length === 0) {
		// Only reachable with a step in progress: with none, `target` is a visible step
		// and is therefore an end of itself.
		throw new Error(
			inFlight
				? `Step ${target.step} is the step you are in, so there is nothing finished to fold yet.`
				: endRefusal(throughStep ?? target.step, ends),
		);
	}
	// Either the start itself is a legal end, or something newer is.
	const chosen = throughStep ?? ends[0]!;
	if (!ends.includes(chosen)) {
		throw new Error(endRefusal(chosen, ends));
	}
	// `to` is the next step in view, which is the first one a fold over this range keeps.
	const to = visibleSteps.find((step) => step.step > chosen);
	return { to, through: chosen };
}

/**
 * Everything a fold decides before it commits: the same validation, throwing
 * the same errors, and the same estimate. The real fold, the tool's `preview`
 * flag, and `/dmail price` all go through here — that is what makes their
 * numbers identical and their refusals symmetric by construction (ticket 05).
 * Without `throughStep` the end is the latest foldable step, exactly as before
 * ticket 12. `openEnd` says the view has no step in progress, so the newest step is
 * foldable too — `/dmail price` on an idle session, never the tool, which always runs
 * inside the round that follows everything in view. Omitting `openEnd` therefore
 * returns a closed plan: `to` is a step, by type, and not by a runtime assertion.
 */
function planFold(
	entries: readonly SessionEntry[],
	branch: readonly SessionEntry[],
	fromStep: number,
	summary: string,
	ctx: ExtensionContext,
	throughStep?: number,
	openEnd?: false,
): FoldPlan & { to: NumberedStep };
function planFold(
	entries: readonly SessionEntry[],
	branch: readonly SessionEntry[],
	fromStep: number,
	summary: string,
	ctx: ExtensionContext,
	throughStep: number | undefined,
	openEnd: boolean,
): FoldPlan;
function planFold(
	entries: readonly SessionEntry[],
	branch: readonly SessionEntry[],
	fromStep: number,
	summary: string,
	ctx: ExtensionContext,
	throughStep?: number,
	openEnd = false,
): FoldPlan {
	const branchSteps = stepsIn(branch);
	// Planned before appending: the record this call is about to write is not in
	// the `entries` snapshot, so reading it here would miscount it as orphaned.
	const plan = planForView(entries, branch);
	const { skipped } = plan;
	const visibleSteps = visibleStepsOf(entries, branch);
	const listed = visibleSteps.map((step) => step.step).join(", ") || "none";

	const target = branchSteps.find((step) => step.step === fromStep);
	if (!target) {
		throw new Error(`There is no step ${fromStep}. Visible steps: [${listed}].`);
	}
	if (!visibleSteps.some((step) => step.entryId === target.entryId)) {
		throw new Error(`Step ${fromStep} has already been folded out of view. Visible steps: [${listed}].`);
	}
	const midStart = midStartRefusal(entries, branchSteps, plan.inEra, target);
	if (midStart !== undefined) {
		throw new Error(midStart);
	}
	const trimmed = summary.trim();
	if (trimmed === "") {
		throw new Error("The summary is empty. Write what should replace the folded steps.");
	}

	// The end is resolved once, here, and frozen. Re-deriving it later would let the
	// fold keep swallowing every step that follows it, including an end the user chose.
	// A fold is written from a round that follows everything in view, so the tool reads
	// that round as the step in flight and its range is closed by type; only the command
	// side, where nothing is running, may stop at the newest step and keep nothing.
	if (openEnd) {
		const open = resolveEnd(visibleSteps, target, throughStep, undefined);
		return estimateFold(entries, target, open.to, open.through, trimmed, skipped.length, ctx);
	}
	const { to, through } = resolveEnd(visibleSteps, target, throughStep, visibleSteps[visibleSteps.length - 1]);
	return estimateFold(entries, target, to, through, trimmed, skipped.length, ctx);
}

/**
 * The estimation half of a fold: walk the range, probe usage, evaluate the
 * economics. No validation — the caller passes a range it already knows is
 * foldable — and no side effects, so preview, fold, and price all read the
 * same numbers off the same code.
 */
function estimateFold(
	entries: readonly SessionEntry[],
	target: NumberedStep,
	to: NumberedStep | undefined,
	through: number,
	summary: string,
	skipped: number,
	ctx: ExtensionContext,
): FoldPlan {
	// Usage is probed before the record lands so headroom describes the
	// context this fold is deciding about, not the one it just changed.
	let usage: { tokens: number | null; contextWindow: number } | undefined;
	try {
		usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
	} catch {
		// No usage probe (or a throwing one): headroom degrades to unknown.
	}

	// Advisory economics (ticket 04): what the fold removed, what the cache
	// will pay back, how much window headroom is left. Every fallible piece is
	// guarded separately, so the result always carries the advisory while a
	// fold is never refused, delayed, or altered on economic grounds.
	//
	// The fold replaces [fromEntryId, toEntryId): `toEntryId` is documented as
	// "the first entry kept", so the archive is [start, end) — exactly what
	// replay drops — and the kept suffix (the other half of the one-time fresh
	// rewrite) starts at `end`. Both walks use replay's convert() so the
	// counts match what replay sends.
	let archiveTokens = 0;
	let keptTokens = 0;
	// Without a kept step the cut runs to the newest step in view, and what follows it is
	// the round that folds — not in this view. The kept suffix is then unknown rather
	// than zero: "nothing after the cut" is a promise this estimate does not get to make.
	// The archive is under-counted by the same step (the pin prompt and the folding
	// round arrive after this view), which is why the figure is advisory, not a bill.
	let keptKnown = to !== undefined;
	try {
		const start = entries.findIndex((entry) => entry.id === target.entryId);
		const end = to === undefined ? entries.length : entries.findIndex((entry) => entry.id === to.entryId);
		if (start < 0 || end < start) throw new Error("fold range not in the view");
		const tokensOf = (entry: SessionEntry): number =>
			sessionEntryToContextMessages(entry).reduce((sum, message) => sum + estimateTokens(message), 0);
		for (const entry of entries.slice(start, end)) archiveTokens += tokensOf(entry);
		for (const entry of entries.slice(end)) keptTokens += tokensOf(entry);
	} catch {
		// A malformed entry can hide tokens: the verdict degrades, the fold does not.
		archiveTokens = 0;
		keptKnown = false;
	}
	const keptAfterTokens: number | null = keptKnown ? keptTokens : null;
	// The memo as replay sends it: wrapSummary's <summary> wrapper is part of
	// what replaces the archive, so it is part of what the replacement costs.
	const memoTokens = estimateTokens(userMessage(wrapSummary(summary), Date.now()));
	// Total by construction (clamped inputs): this cannot throw and cannot
	// omit a verdict — that is what "always carries the advisory" means.
	const economics = evaluateEconomics({
		archiveTokens,
		memoTokens,
		keptAfterTokens,
		contextTokens: typeof usage?.tokens === "number" ? usage.tokens : null,
		contextWindow: typeof usage?.contextWindow === "number" ? usage.contextWindow : null,
	});

	return { target, through, to, summary, skipped, economics };
}

/**
 * The memo `/dmail price` sizes candidate cuts against when no summary is
 * given: a stand-in for a typical fold memo, so the cuts are comparable to
 * each other. Exact numbers need the real summary — `/dmail price <step>
 * <summary>` and the tool's `preview` flag report the same figures for the
 * same input, because all three run through planFold/estimateFold.
 */
const PRICE_SUMMARY_SAMPLE =
	"Opening exchange: the goal, the constraints decided there, and the two decisions later steps still depend on.";

/**
 * `/dmail price [start] [end] [summary…]` — estimates without commitment. Prints
 * through notify (the command output seam), appends nothing, and sends the
 * agent nothing. A bad start reports the fold's own refusal as an error, and so
 * does an end the fold would refuse (ticket 12: price and fold share planFold).
 * A second number is the inclusive end; anything else there starts the summary.
 */
function priceCommand(ctx: ExtensionContext, rest: string): void {
	const entries = ctx.sessionManager.buildContextEntries();
	const branch = ctx.sessionManager.getBranch();
	const words = rest === "" ? [] : rest.split(/\s+/);
	const stepToken = words[0];
	const endToken = /^\d+$/.test(words[1] ?? "") ? words[1] : undefined;
	const summaryText = words.slice(endToken === undefined ? 1 : 2).join(" ").trim();

	if (stepToken === undefined) {
		// Every candidate cut: a step that can start a range, latest first. With nothing
		// in progress the newest step starts one too, ending on itself.
		const visibleSteps = visibleStepsOf(entries, branch);
		const inFlight = ctx.isIdle() ? undefined : visibleSteps[visibleSteps.length - 1];
		const candidates = visibleSteps
			.filter((step) => inFlight === undefined || step.step < inFlight.step)
			.reverse();
		if (candidates.length === 0) {
			ctx.ui.notify("Nothing finished to fold yet: the step you are in has nothing after it.", "info");
			return;
		}
		const { skipped } = planForView(entries, branch);
		// Each candidate is priced at the end the fold would itself freeze for it, so the
		// headline and the figures describe the cut that would actually happen — not an
		// arithmetic guess a folded-away step turns into a step that is not there.
		const plans = candidates.map((target) => {
			const end = resolveEnd(visibleSteps, target, undefined, inFlight);
			return estimateFold(entries, target, end.to, end.through, PRICE_SUMMARY_SAMPLE, skipped.length, ctx);
		});
		const rows = plans.map(
			(plan) =>
				`${foldHeadline({ fromStep: plan.target.step, throughStep: plan.through, preview: true })} · ` +
				foldEconomicsLine({ economics: plan.economics }),
		);
		// Headroom and skips describe this view once, not each cut — all share them.
		const headroom = foldHeadroomLine({ economics: plans[0].economics });
		const skipLine = foldSkippedLine(skipped.length);
		ctx.ui.notify(
			[
				"Candidate cuts (memo sized from a representative summary):",
				...rows,
				...(headroom === "" ? [] : [headroom]),
				...(skipLine === "" ? [] : [skipLine]),
				"For an exact cut: /dmail price <start> [<end>] <summary> — the same numbers the preview flag reports.",
			].join("\n"),
			"info",
		);
		return;
	}

	// Strict digits: anything else never reaches the fold's own numbering, so a
	// typo reports "not a step number" instead of a confusing "no step 0x2".
	if (!/^\d+$/.test(stepToken)) {
		ctx.ui.notify(`"${stepToken}" is not a step number. Try /dmail price 2.`, "error");
		return;
	}
	const fromStep = Number(stepToken);
	try {
		const plan = planFold(
			entries,
			branch,
			fromStep,
			summaryText === "" ? PRICE_SUMMARY_SAMPLE : summaryText,
			ctx,
			endToken === undefined ? undefined : Number(endToken),
			// On an idle session the newest step is a finished step, so pricing it means
			// pricing the cut the picker offers — the fold that follows it is the kept step.
			ctx.isIdle(),
		);
		const details = {
			fromStep: plan.target.step,
			throughStep: plan.through,
			economics: plan.economics,
			preview: true,
		};
		ctx.ui.notify(
			[
				`${foldHeadline(details)} — preview only, nothing folded.`,
				foldEconomicsLine(details),
				foldHeadroomLine(details),
				foldSkippedLine(plan.skipped),
			]
				.filter((line) => line !== "")
				.join("\n"),
			"info",
		);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

export default function dmail(pi: ExtensionAPI): void {
	// Session-local, deliberately. A toggle is not a setting, and it should not outlive
	// the session that asked for it — the same choice bash-guard made. The *starting*
	// value is a setting (settings.json `dmail.enabled`); this only overrides it.
	let enabled = true;
	// The range last pinned through `/dmail fold`: consumed by the next real fold
	// so its confirmation can tell the user the fold happened on their behalf.
	let pinned: { fromStep: number; throughStep: number } | undefined;
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

	/**
	 * `/dmail fold` — the user owns the cut range, the agent owns the prose.
	 * Rows come from the replayed view (visible steps + one row per folded
	 * region) latest first, and every row can be either endpoint: the picker asks
	 * for a start, then for an end through the same list, and the pair is handed
	 * to the agent via the standard prompt path (plain when idle, followUp when
	 * busy). This one function serves both `/dmail fold` and its alias
	 * `/send-dmail`. Cancel changes nothing; without an interactive UI the printed
	 * list plus `/dmail fold <start> [<end>]` keeps headless sessions working.
	 */
	async function foldCommand(ctx: ExtensionContext, rest: string, invocation: string): Promise<void> {
		// Shared guards for /dmail fold and /send-dmail: an unreachable fold helps no one.
		if (!enabled) {
			ctx.ui.notify("D-Mail is off, so there is nothing to fold. Run /dmail to turn it on.", "warning");
			return;
		}
		if (!pi.getActiveTools().includes(TOOL_NAME)) {
			ctx.ui.notify(`The ${TOOL_NAME} tool is not active, so the agent cannot fold. Enable it from /tools first.`, "warning");
			return;
		}
		const entries = ctx.sessionManager.buildContextEntries();
		const branch = ctx.sessionManager.getBranch();
		const visible = visibleStepsOf(entries, branch);
		if (visible.length === 0) {
			ctx.ui.notify("Nothing to fold yet — no steps in view.", "warning");
			return;
		}
		// The newest step is the round in progress only while something is running. On an
		// idle session it is a finished step like any other — and the round that writes
		// the fold will be a step start after it — so it is offered at both ends.
		const inFlight = ctx.isIdle() ? undefined : visible[visible.length - 1];
		// The end a pin takes when the user chose only a start. Read off the view, because
		// step numbers keep their gaps once steps are folded away.
		const latestFinished = latestFinishedStep(visible, inFlight);
		const plan = planForView(entries, branch);
		const entryById = new Map(entries.map((entry) => [entry.id, entry]));
		// One pricing walk per (start, end) pair, memoised: the picker asks for a row's
		// figure on every redraw, and for each pending range once while the end is picked.
		const priced = new Map<string, string | undefined>();
		const estimateFor = (fromStep: number, throughStep: number): string | undefined => {
			const key = `${fromStep}\u2192${throughStep}`;
			if (priced.has(key)) return priced.get(key);
			const target = visible.find((step) => step.step === fromStep);
			const to = visible.find((step) => step.step > throughStep);
			let line: string | undefined;
			// No step kept after the cut is legal only when nothing is in flight: the cut
			// then runs to the newest step, whose fold has not arrived in this view yet.
			if (target && (to !== undefined || inFlight === undefined)) {
				const range = estimateFold(entries, target, to, throughStep, PRICE_SUMMARY_SAMPLE, plan.skipped.length, ctx);
				line = estimateLine(range.economics.removedTokens);
			}
			priced.set(key, line);
			return line;
		};
		// The ends a fold from this start may stop at, latest first — the very list the
		// fold's own endpoint validation reads, so a refusal never names a refused step.
		const endsFrom = (fromStep: number): number[] => validEnds(visible, inFlight, fromStep);
		// A number to suggest when an end was missing or unparseable: the end this start
		// would have taken by default, or the latest foldable step if it has none.
		const endsHint = (fromStep: number): number => endsFrom(fromStep)[0] ?? latestFinished;
		const rows = buildFoldPickerRows({
			steps: visible,
			current: inFlight,
			folds: plan.inEra,
			roleOf: (step) => entryRole(entryById.get(step.entryId)),
			previewOf: (step) => foldSummaryPreview(entryText(entryById.get(step.entryId))),
			estimateOf: (fromStep) => estimateFor(fromStep, latestFinished),
		});
		if (rows.length === 0) {
			ctx.ui.notify("Nothing finished to fold yet: the step you are in has nothing after it.", "info");
			return;
		}

		// Deliver the pinned range: plain when idle, followUp when the agent is busy.
		const pin = (fromStep: number, throughStep: number): void => {
			pinned = { fromStep, throughStep };
			const cut = foldBracket(fromStep, throughStep);
			const prompt = foldPinPrompt(fromStep, throughStep, latestFinished, inFlight === undefined);
			if (ctx.isIdle()) {
				pi.sendUserMessage(prompt);
				ctx.ui.notify(`Pinned ${cut} — the agent will fold and write the summary.`, "info");
			} else {
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				ctx.ui.notify(`Pinned ${cut}. The agent will fold once it finishes the current turn.`, "info");
			}
		};

		// Explicit endpoints: `/dmail fold 2` or `/dmail fold 2 7` — the headless way to pin a range.
		const args = rest.trim() === "" ? [] : rest.trim().split(/\s+/);
		if (args.length > 0) {
			const [startToken, endToken, ...extra] = args;
			if (!/^\d+$/.test(startToken)) {
				ctx.ui.notify(`"${startToken}" is not a step number. Try /${invocation} 2.`, "error");
				return;
			}
			if (endToken !== undefined && !/^\d+$/.test(endToken)) {
				const suggested = endsHint(Number(startToken));
				ctx.ui.notify(`"${endToken}" is not a step number. Try /${invocation} ${startToken} ${suggested}.`, "error");
				return;
			}
			if (extra.length > 0) {
				ctx.ui.notify(`A fold takes a start and an end, not "${extra.join(" ")}". Try /${invocation} ${startToken}.`, "error");
				return;
			}
			const row = rows.find((candidate) => candidate.fromStep === Number(startToken));
			if (!row) {
				ctx.ui.notify(
					`There is no step ${startToken} to fold from. Starts: [${rows.map((candidate) => candidate.fromStep).join(", ")}].`,
					"error",
				);
				return;
			}
			// No end means the frozen default: the latest finished step, as before ticket 12.
			const fromStep = row.fromStep;
			const ends = endsFrom(fromStep);
			const throughStep = endToken === undefined ? ends[0] : Number(endToken);
			if (!ends.includes(throughStep)) {
				ctx.ui.notify(`There is no step ${throughStep} to fold through. Ends: [${ends.join(", ")}].`, "error");
				return;
			}
			pin(fromStep, throughStep);
			return;
		}

		// The /tree-style TUI picker when a TUI can host it (one component, two phases),
		// ui.select for rpc-style UIs (two dialogs, esc from the second returns to the
		// first), and the printed list to keep headless sessions working.
		if (ctx.hasUI !== false && typeof ctx.ui.custom === "function") {
			const pinResult = await ctx.ui.custom<FoldPin | undefined>(
				(tui, theme, keybindings, done) =>
					new FoldPickerComponent({
						rows,
						theme,
						terminalRows: tui.terminal?.rows ?? 40,
						keybindings,
						rangeEstimate: (fromStep, throughStep) => estimateFor(fromStep, throughStep),
						onSelect: done,
						onCancel: () => done(undefined),
					}),
			);
			if (pinResult === undefined) {
				ctx.ui.notify("Cancelled — nothing was folded.", "info");
			} else {
				pin(pinResult.fromStep, pinResult.throughStep);
			}
			return;
		}

		if (ctx.hasUI !== false && typeof ctx.ui.select === "function") {
			// One loop, two dialogs: esc in the end dialog discards the start and shows
			// the full list again; esc in the start dialog is the only way out.
			for (;;) {
				const startLabel = await ctx.ui.select(
					`${PICKER_TITLE} The end is the latest finished step. ${ESTIMATE_LEGEND}.`,
					rows.map((row) => row.label),
				);
				const startRow = startLabel === undefined ? undefined : rows.find((row) => row.label === startLabel);
				if (!startRow) {
					ctx.ui.notify("Cancelled — nothing was folded.", "info");
					return;
				}
				const fromStep = startRow.fromStep;
				const ends = endsFrom(fromStep);
				const endRows = rows.filter((row) => ends.includes(endStepOf(row)));
				const endLabel = await ctx.ui.select(`${PICKER_END_TITLE} (start: ${fromStep})`, endRows.map((row) => row.label));
				if (endLabel === undefined) continue; // esc → back to the start list
				const endRow = endRows.find((row) => row.label === endLabel);
				if (endRow) {
					pin(fromStep, endStepOf(endRow));
					return;
				}
			}
		}

		// No dialog-capable UI (print/json mode): print the list.
		ctx.ui.notify(
			[
				`No interactive picker here — pin a range with /${invocation} <start> [<end>]: ${ESTIMATE_LEGEND}.`,
				...rows.map((row) => `· ${row.label}`),
			].join("\n"),
			"info",
		);
	}

	pi.registerCommand(COMMAND_NAME, {
		description:
			"Turn D-Mail on or off for this session, price a fold, or pick where to fold. No argument toggles; also accepts on, off, status, price, fold.",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const splitAt = trimmed.search(/\s/);
			const arg = (splitAt === -1 ? trimmed : trimmed.slice(0, splitAt)).toLowerCase();
			const rest = splitAt === -1 ? "" : trimmed.slice(splitAt).trim();

			// The user picks the cut point; the agent authors the summary and folds.
			if (arg === "fold") {
				await foldCommand(ctx, rest, "dmail fold");
				return;
			}
			// Price is read-only: it never toggles, never folds, never pings the agent.
			if (arg === "price") {
				priceCommand(ctx, rest);
				return;
			}
			if (arg === "on") enabled = true;
			else if (arg === "off") enabled = false;
			else if (arg === "") enabled = !enabled;
			else if (arg !== "status") {
				ctx.ui.notify(
					`Unknown argument "${arg}". Use /dmail, /dmail on, /dmail off, /dmail status, /dmail price, or /dmail fold.`,
					"warning",
				);
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

	// The classic entry point, now an alias of `/dmail fold`: same picker, same
	// pinned range, same delivery path. Arguments mean the same thing —
	// `/send-dmail 2` pins a start, `/send-dmail 2 7` pins the whole range.
	pi.registerCommand("send-dmail", {
		description:
			"Pick the range D-Mail folds: the same picker and pinned range as /dmail fold (explicit steps work without one).",
		handler: async (args, ctx) => {
			await foldCommand(ctx, args, "send-dmail");
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
			// One copy of the summary: the chip carries the body, so the call that
			// wrote it keeps only its range (dedupe.ts). Applied records only — a
			// preview or a refusal has no chip and keeps its arguments.
			return { messages: redactFoldCalls(result.messages, { toolName: TOOL_NAME, applied: result.applied }) };
		} catch {
			// A context hook must never break a request: fall through to Pi's view.
			return undefined;
		}
	});

	/**
	 * The hybrid compaction seam (ticket 08): folding's editorial work survives
	 * pi's compaction.
	 *
	 * Compaction summarizes the current era — the branch since the latest
	 * compaction entry — and that era's folds are exactly the material the agent
	 * already decided it was finished with. Left alone, pi's summarizer would see
	 * only the raw messages, and the post-compaction session would be re-taught
	 * material the agent had folded away.
	 *
	 * So this handler splices the era's fold summaries into the one channel pi's
	 * default summarizer already reads for iteration — `preparation.previousSummary`,
	 * in place: the one-line instruction first, then pi's own prior summary (when
	 * there is one), then S1…Sn in chronological order. `messagesToSummarize`,
	 * `tokensBefore`, and `fileOps` stay exactly as pi prepared them, and the
	 * handler returns nothing, so pi's default summarizer runs as it always would
	 * — hybrid, not replacement.
	 */
	pi.on("session_before_compact", async (event, ctx) => {
		// Disabled is a decision, not a failure: guarded before the try, so the
		// channel is never touched when folding is off.
		if (!enabled) return undefined;
		try {
			const branch = event.branchEntries;
			const era = currentEraOf(branch);

			// Plan through the shared planner — era split (holder-based) then
			// validation — so the summaries spliced here are exactly what the context
			// hook replays: re-fold suppression and endpoint validation included,
			// records listed but never double-counted.
			const plan = planForView(era, branch);
			const replay = foldContext<SessionEntry, string>(era, plan.inEra, {
				convert: () => [],
				summaryMessage: (_wrappedText, fold) => fold.summary,
				isStepStart: isAssistantEntry,
			});
			if (replay.messages.length === 0) return undefined;

			const prior = event.preparation.previousSummary;
			// Chronological: pi's prior summary first (created from the fold summaries
			// alone when the channel does not exist yet), then the era's chain.
			const channel = [
				FOLD_CHANNEL_INSTRUCTION,
				...(typeof prior === "string" && prior.trim() !== "" ? [prior] : []),
				...replay.messages,
			].join("\n\n");
			// In place: pi's default summarizer reads this same preparation object
			// after the handlers run. Raw material, token estimates, and file-op
			// bookkeeping stay as pi prepared them; the return value stays empty so
			// pi's summarizer still runs.
			event.preparation.previousSummary = channel;
			return undefined;
		} catch (error) {
			// Compaction must never break because of this hook — but a silent no-op
			// would hide a seam failure, so surface it; pi proceeds untouched either way.
			ctx.ui.notify(
				`dmail: compaction seam failed — ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return undefined;
		}
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Send D-Mail",
		description:
			"Fold a range of finished steps out of your context and replace them with a summary you write. " +
			"Everything from `fromStep` through `throughStep` (default: the last completed step) stops being sent; the step you are in is kept. " +
			"Nothing is deleted from the session or from disk, so folding too much costs only a re-read. " +
			"Pass `preview` to get the same estimates without folding.",
		promptSnippet: "send_dmail — fold finished steps out of context, replacing them with a summary you write",
		parameters: Type.Object({
			fromStep: Type.Number({
				description: "Number of the earliest step to fold, as shown by the [step N] markers.",
			}),
			throughStep: Type.Optional(
				Type.Number({
					description:
						"Number of the last step to fold, inclusive. Omit to fold through the last completed step; " +
						"the step you are in is never folded.",
				}),
			),
			summary: Type.String({
				description: "What replaces the folded steps. Include everything later steps depend on.",
			}),
			preview: Type.Optional(
				Type.Boolean({
					description:
						"Estimate only: report exactly what this fold would — same validation, same numbers — " +
						"without appending a record or changing the view.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!enabled) {
				throw new Error(
					"D-Mail is disabled for this session, so nothing can be folded. " +
						"Ask the user to run /dmail if folding is needed.",
				);
			}

			// One path decides everything: validation (identical errors) and the
			// estimate (identical numbers) live in planFold, so this call, its own
			// `preview` flag, and `/dmail price` cannot drift apart. An omitted
			// `throughStep` keeps the frozen end: the last completed step.
			const entries = ctx.sessionManager.buildContextEntries();
			const branch = ctx.sessionManager.getBranch();
			const plan = planFold(entries, branch, params.fromStep, params.summary, ctx, params.throughStep);
			const { target, to, through, economics, summary: trimmedSummary, skipped } = plan;
			// `to` is typed as present, and the tool never passes `openEnd`: the newest
			// step in view is the round running this very call, so a step always follows
			// the cut — which is what keeps a tool call and its result on one side of it.

			// Skipped records are counted, never dropped silently: the count rides the
			// result so every view of it (raw fallback, collapsed, expanded) can say so.
			const skipLine = foldSkippedLine(skipped);
			const hasSkips = skipLine !== "";
			const details = {
				fromStep: target.step,
				throughStep: through,
				fromEntryId: target.entryId,
				toEntryId: to.entryId,
				economics,
				predicted: economics.predicted,
				actual: economics.actual,
				...(hasSkips ? { skipped } : {}),
			};
			// The raw fallback content carries the advisory too: the economics line
			// and any headroom warning, before the skip count.
			const advisory = foldAdvisoryText(details);
			const tail = [...(advisory === "" ? [] : [advisory]), ...(hasSkips ? [skipLine] : [])];

			// Preview (ticket 05): the numbers without the commitment. Same plan,
			// same advisory — nothing appended, no notification, the view untouched.
			if (params.preview) {
				const headline =
					`Preview: steps ${target.step} through ${through} would be replaced by your summary ` +
					`from the next request on. Nothing was appended — the view is unchanged.`;
				return {
					content: [{ type: "text" as const, text: [headline, ...tail].join("\n") }],
					details: { ...details, preview: true },
				};
			}

			// Both endpoints come from resolveEnd, so both are step starts and the
			// exclusive end is the first kept step's entry: a fold can never cut a tool
			// call from its result, whatever end the user or agent chose.
			pi.appendEntry<FoldRecord>(FOLD_TYPE, {
				fromEntryId: target.entryId,
				toEntryId: to.entryId,
				summary: trimmedSummary,
				fromStep: target.step,
				// Predicted-vs-actual rides the record as well as the result, so offline
				// scoring (ticket 06) can read it back from the recorded session.
				// `actual` ships null — economics never gate anything.
				predicted: economics.predicted,
				actual: economics.actual,
			});

			// A fold over the range the user pinned through `/dmail fold` says so in the
			// confirmation — but only when the fold really is that range. The end has to
			// match too: the default end moves when a fold lands a round later than the
			// pin, and a wider fold must not be reported as one the user asked for.
			const behalf =
				pinned?.fromStep === target.step && pinned.throughStep === through
						? ` Folded on your behalf ${foldBracket(target.step, through)}.`
						: "";
			// The pin survives a fold that was not it: the injected policy tells the agent
			// to fold finished work as soon as it lands, so it may well fold something
			// else before the range the user pinned. A lingering pin can only ever credit
			// that exact range, and crediting it twice is unreachable — its own start is
			// gone once it has folded.
			if (behalf !== "") pinned = undefined;
			// Best effort: a fold that succeeded must not be reported as a failure just
			// because the front end could not draw a notification.
			try {
				ctx.ui.notify(`Folded steps ${target.step}–${through}. In effect from the next request.${behalf}`, "info");
			} catch {
				// Ignore.
			}

			const headline = `Folded steps ${target.step} through ${through}. They are replaced by your summary from the next request on.`;
			return {
				content: [{ type: "text" as const, text: [headline, ...tail].join("\n") }],
				details,
			};
		},
		/**
		 * Pi draws this instead of the raw `content` line, which named the folded
		 * range but never showed the summary. Collapsed it previews the summary and
		 * advertises the expand key; expanded it shows the summary whole.
		 */
		renderResult(result, { expanded }, theme, context) {
			const summary = typeof context.args.summary === "string" ? context.args.summary : "";
			const details = (result.details ?? {}) as FoldRenderDetails;
			const text = foldResultText(details, summary, keyHint("app.tools.expand", "to expand"), expanded);
			// A preview must not wear the fold's checkmark: nothing succeeded yet.
			return details.preview
				? new Text(`${theme.fg("accent", "◌ preview (nothing folded):")} ${text}`, 0, 0)
				: new Text(`${theme.fg("success", "✓")} ${text}`, 0, 0);
		},
	});
}

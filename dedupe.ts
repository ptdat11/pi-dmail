/**
 * One copy of the summary in the replayed prompt.
 *
 * A fold is sent twice. The `context` hook injects the summary as a chip at the
 * fold's start, and the `send_dmail` call that produced it stays in the view —
 * the step doing the folding is never inside its own range — so the body of the
 * summary rides along in that call's `arguments` for every request afterwards.
 * The model reads the same prose twice: once as the replacement, once as its own
 * forgotten argument.
 *
 * This pass removes the second copy from the *replayed* context. It rewrites the
 * tool call down to the range it folded and trims its result to the headline and
 * the advisory lines, so what survives is the part the summary cannot say for
 * itself: which steps went, that the swap takes effect now, and whether the
 * window is closing. Nothing is deleted from the session — the stored transcript
 * still holds the full call, and `renderResult` still draws the whole summary.
 *
 * Two invariants make it safe:
 *
 *   One chip, one redaction. Only calls matching a record that *replayed this
 *   view* are rewritten. A `preview` appended no record and injected no chip, so
 *   its arguments are the only copy of that text and are left alone; a refused or
 *   failed fold never got a chip either, and its arguments explain why.
 *
 *   Structure is untouched. Messages are rewritten, never dropped, so no
 *   assistant is ever separated from its results and no `[step N]` marker goes
 *   missing. Pure and deterministic — no clock, no counters — so two replays of
 *   the same session are byte-identical and prompt caching keeps working.
 *
 * Pure and pi-free, like `render.ts`: the exact wording is testable under bare
 * `node --test`.
 */
import { foldAdvisoryText, type FoldRenderDetails } from "./render.ts";

/** The part of a fold record this pass matches calls against. */
export interface AppliedFold {
	fromStep?: number;
	summary?: string;
}

export interface RedactOptions {
	/** The folding tool's name; calls to any other tool are left alone. */
	toolName: string;
	/** Records replayed in this view — one injected chip each. */
	applied: readonly AppliedFold[];
}

/** Tool-call arguments, as loosely as the wire delivers them. */
type Args = Record<string, unknown>;

/**
 * The message shapes this pass reads. Deliberately structural: pi's `AgentMessage`
 * union satisfies it without an import, and every unrecognised shape passes
 * through as it arrived.
 */
interface MessageView {
	role?: string;
	content?: unknown;
	toolCallId?: string;
	toolName?: string;
	details?: unknown;
}

/** A `toolCall` content block, as loosely as the wire delivers it. */
interface ToolCallView {
	type?: string;
	id?: string;
	name?: string;
	arguments?: Args;
}

/**
 * Drop the duplicated summary body from the folded calls in `messages`.
 *
 * Returns a new array; the input is never mutated, and every message in it is
 * still there afterwards. A call is matched by the pair the record stores —
 * `fromStep` and the summary text — rather than by anything positional, because
 * a later fold may have swallowed the step that made it, and re-folds make step
 * numbers repeat. Matching is a multiset: two folds with identical ranges and
 * text redact exactly two calls, never one.
 */
export function redactFoldCalls<M extends MessageView>(messages: readonly M[], options: RedactOptions): M[] {
	const claims = claimTable(options.applied);
	const out: M[] = messages.slice();
	if (claims.size === 0) return out;

	// Tool results always follow their call in a well-formed context, so the ids
	// collected while walking forward are complete by the time a result is met.
	const foldedIds = new Set<string>();
	let changed = false;

	out.forEach((message, index) => {
		if (message.role === "assistant") {
			const next = redactCallBlocks(message.content, options.toolName, claims, foldedIds);
			if (next === message.content) return;
			out[index] = { ...message, content: next } as M;
			changed = true;
			return;
		}
		if (message.role !== "toolResult") return;
		if (!foldedIds.has(message.toolCallId ?? "")) return;
		const trimmed = trimResult(message);
		if (trimmed === message) return;
		out[index] = trimmed as M;
		changed = true;
	});

	return changed ? out : messages.slice();
}

/**
 * How many calls each distinct fold pair may still claim.
 *
 * `fromStep` alone is not an identity — the same step can be folded again, and a
 * hand-edited or malformed record carries no step at all. Pairs that cannot be
 * matched are simply never claimed.
 */
function claimTable(applied: readonly AppliedFold[]): Map<string, number> {
	const claims = new Map<string, number>();
	for (const fold of applied) {
		if (typeof fold?.fromStep !== "number" || typeof fold.summary !== "string") continue;
		const key = claimKey(fold.fromStep, fold.summary);
		claims.set(key, (claims.get(key) ?? 0) + 1);
	}
	return claims;
}

/** Identity of a fold claim: the step it started at, plus the text it wrote. */
function claimKey(fromStep: number, summary: string): string {
	return `${fromStep}\u0000${summary.trim()}`;
}

/**
 * Rewrite the folded `toolCall` blocks in one assistant message to their range.
 *
 * Returns the content unchanged when nothing matched, so the caller can tell a
 * real rewrite from a pass-through by identity. Other blocks — text, thinking,
 * other tools' calls — are copied through untouched, and an assistant message
 * that made parallel calls keeps them.
 */
function redactCallBlocks(
	content: unknown,
	toolName: string,
	claims: Map<string, number>,
	foldedIds: Set<string>,
): unknown {
	if (!Array.isArray(content)) return content;
	let changed = false;
	const next = content.map((block) => {
		if (!isToolCall(block) || block.name !== toolName) return block;
		const rewritten = rewriteArguments(block, claims);
		if (rewritten === undefined) return block;
		foldedIds.add(block.id ?? "");
		changed = true;
		return { ...block, arguments: rewritten };
	});
	return changed ? next : content;
}

/**
 * The surviving arguments for one folded call: which steps it replaced.
 *
 * `undefined` when the call is not one of this view's applied folds — a preview,
 * a refusal, or a record that did not replay. `throughStep` rides only when the
 * model stated one: the default end was resolved at fold time and is named by
 * the result's headline anyway.
 */
function rewriteArguments(block: ToolCallView, claims: Map<string, number>): Args | undefined {
	const args = block.arguments;
	if (args === null || typeof args !== "object") return undefined;
	// A preview never appended a record, so there is no chip and no second copy.
	if (args.preview === true) return undefined;
	const { fromStep, summary, throughStep } = args as { fromStep?: unknown; summary?: unknown; throughStep?: unknown };
	if (typeof fromStep !== "number" || typeof summary !== "string") return undefined;
	const key = claimKey(fromStep, summary);
	const remaining = claims.get(key) ?? 0;
	if (remaining <= 0) return undefined;
	claims.set(key, remaining - 1);
	const kept: Args = { fromStep };
	if (typeof throughStep === "number" && Number.isFinite(throughStep)) kept.throughStep = throughStep;
	return kept;
}

/**
 * The result of a folded call: the headline, then the advisory lines.
 *
 * The headline says what went and that the swap takes effect now — the part the
 * summary chip cannot say for itself. The advisory (economics, window headroom)
 * rides along because it is the model's cue to keep folding. The skip count is
 * dropped: it counts *other* records, and replay has just re-decided those.
 */
function trimResult(message: MessageView): MessageView {
	const content = message.content;
	if (!Array.isArray(content)) return message;
	const first = content.findIndex((block) => isText(block));
	if (first < 0) return message;
	const headline = firstLine(textOf(content[first]));
	if (headline === "") return message;
	const advisory = foldAdvisoryText((message.details ?? {}) as FoldRenderDetails);
	const blocks = content.slice();
	blocks[first] = { ...(blocks[first] as object), text: advisory === "" ? headline : `${headline}\n${advisory}` };
	return { ...message, content: blocks };
}

/** A `toolCall` block, or not. */
function isToolCall(block: unknown): block is ToolCallView {
	return block !== null && typeof block === "object" && (block as ToolCallView).type === "toolCall";
}

/** A `text` block, or not. */
function isText(block: unknown): boolean {
	return block !== null && typeof block === "object" && (block as { type?: string }).type === "text";
}

/** The block's text, or `""` when it has none. */
function textOf(block: unknown): string {
	const text = (block as { text?: unknown } | undefined)?.text;
	return typeof text === "string" ? text : "";
}

/** First non-blank line, trimmed. `""` when the text carries nothing. */
function firstLine(text: string): string {
	return (
		text
			.split("\n")
			.find((line) => line.trim() !== "")
			?.trim() ?? ""
	);
}
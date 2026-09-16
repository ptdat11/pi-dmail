/**
 * The fold algebra for D-Mail.
 *
 * This module is the extension's one test seam. It is pure: no Pi runtime, no
 * I/O, no model, no clock, no globals. Everything above it in `index.ts` is
 * declarative wiring around the Pi extension API.
 *
 * The unit of work is a *fold record*: a promise that a range of finished steps
 * has been replaced by a summary. Records are produced by the model (via the
 * `SendDMail` tool) and replayed here on every request. Replay is idempotent:
 * applying the same records to the same entries always yields the same list.
 *
 * The one invariant that must never break: a fold may not separate an assistant
 * message from the tool results that answer it. Ranges are therefore resolved at
 * entry granularity and validated at record time; this module additionally
 * refuses any range whose end does not strictly follow its start.
 */

/** Custom-entry type used to persist fold records in the session. */
export const FOLD_TYPE = "dmail.fold";

/** A persisted promise that `[fromEntryId, toEntryId)` was replaced by `summary`. */
export interface FoldRecord {
	/** Inclusive start. The entry id of the earliest folded step's assistant message. */
	fromEntryId: string;
	/** Exclusive end. The entry id of the first entry kept after the fold. */
	toEntryId: string;
	/** Model-authored replacement text. Must be non-blank to take effect. */
	summary: string;
	/** The number the agent used, for readability only. Nothing resolves against it. */
	fromStep?: number;
}

export interface EntryLike {
	id: string;
}

export interface NumberedStep {
	/** 1-based, stable for the life of the branch. */
	step: number;
	entryId: string;
	/** Index into the entry list the numbering was derived from. */
	index: number;
}

export interface SkippedFold {
	fold: FoldRecord;
	/** Why this record did not take effect. */
	why:
		| "blank-summary"
		| "start-not-in-context"
		| "end-not-in-context"
		| "end-not-after-start"
		| "start-not-a-step-boundary"
		| "end-not-a-step-boundary";
}

export interface FoldResult<M> {
	/** The rewritten message list. */
	messages: M[];
	/** Records that took effect, in input order. */
	applied: FoldRecord[];
	/** Records that did not, with a reason. Never fatal. */
	skipped: SkippedFold[];
	/** True when the output differs from a plain conversion of the input. */
	changed: boolean;
}

export interface FoldOptions<E, M> {
	/** Convert one entry into the messages it contributes. May return zero. */
	convert: (entry: E) => readonly M[];
	/** Build the injected summary message. Receives already-wrapped text. */
	summaryMessage: (wrappedText: string, fold: FoldRecord) => M;
	/**
	 * Optional message to emit immediately before a kept entry. Used for step
	 * markers. Never called for a dropped entry.
	 */
	beforeEntry?: (entry: E, index: number) => M | undefined;
	/**
	 * Which entries begin a step. When supplied, a fold is refused unless both of
	 * its endpoints begin a step.
	 *
	 * This is what makes the pairing invariant structural rather than
	 * conventional. Dropping `[from, to)` is safe exactly when `from` and `to` are
	 * both step starts: every assistant inside the range has all of its tool
	 * results inside the range too. Without the check a record pointing at a tool
	 * result — from a hand-edited session, a future writer, or a bug — would keep a
	 * tool result whose assistant was dropped, which is a hard provider error, not
	 * a degraded result.
	 */
	isStepStart?: (entry: E) => boolean;
}

/**
 * Wrap a summary for injection.
 *
 * The tags are the only structural signal separating an injected summary from a
 * message the user actually typed, and they are what `getContextUsage` and the
 * session transcript will show. Keep them stable.
 */
export function wrapSummary(summary: string): string {
	return `<summary>\n${summary.trim()}\n</summary>`;
}

/**
 * Number the steps in a branch.
 *
 * Numbering is derived from the full branch, not from the current context view,
 * so a step keeps its number for the life of the session. Folding step 1 must
 * not turn step 2 into step 1, and a compaction must not renumber what survives
 * it. Numbers are therefore allowed to have gaps.
 */
export function numberSteps<E extends EntryLike>(
	entries: readonly E[],
	isStepStart: (entry: E) => boolean,
): NumberedStep[] {
	const steps: NumberedStep[] = [];
	entries.forEach((entry, index) => {
		if (isStepStart(entry)) steps.push({ step: steps.length + 1, entryId: entry.id, index });
	});
	return steps;
}

/**
 * Replay fold records over a list of entries.
 *
 * Overlapping records are allowed. Their drop ranges union, and each record
 * still contributes its own summary at its own start position, so an overlap can
 * produce two adjacent summaries. That is noise, not corruption, and collapsing
 * it is deliberately left out of the first slice.
 */
export function foldContext<E extends EntryLike, M>(
	entries: readonly E[],
	folds: readonly FoldRecord[],
	options: FoldOptions<E, M>,
): FoldResult<M> {
	const positionOf = new Map<string, number>();
	entries.forEach((entry, index) => {
		if (!positionOf.has(entry.id)) positionOf.set(entry.id, index);
	});

	const summaryAt = new Map<number, { text: string; fold: FoldRecord }>();
	const dropped = new Set<number>();
	const applied: FoldRecord[] = [];
	const skipped: SkippedFold[] = [];

	for (const fold of folds) {
		if (typeof fold?.summary !== "string" || fold.summary.trim() === "") {
			skipped.push({ fold, why: "blank-summary" });
			continue;
		}
		const from = positionOf.get(fold.fromEntryId);
		if (from === undefined) {
			skipped.push({ fold, why: "start-not-in-context" });
			continue;
		}
		const to = positionOf.get(fold.toEntryId);
		if (to === undefined) {
			skipped.push({ fold, why: "end-not-in-context" });
			continue;
		}
		if (to <= from) {
			skipped.push({ fold, why: "end-not-after-start" });
			continue;
		}
		const startsStep = options.isStepStart;
		if (startsStep && !startsStep(entries[from] as E)) {
			skipped.push({ fold, why: "start-not-a-step-boundary" });
			continue;
		}
		if (startsStep && !startsStep(entries[to] as E)) {
			skipped.push({ fold, why: "end-not-a-step-boundary" });
			continue;
		}
		summaryAt.set(from, { text: wrapSummary(fold.summary), fold });
		for (let i = from; i < to; i++) dropped.add(i);
		applied.push(fold);
	}

	const messages: M[] = [];
	let markers = 0;

	entries.forEach((entry, index) => {
		const summary = summaryAt.get(index);
		if (summary !== undefined) messages.push(options.summaryMessage(summary.text, summary.fold));
		if (dropped.has(index)) return;

		if (options.beforeEntry) {
			const marker = options.beforeEntry(entry, index);
			if (marker !== undefined) {
				messages.push(marker);
				markers++;
			}
		}
		for (const message of options.convert(entry)) messages.push(message);
	});

	return { messages, applied, skipped, changed: applied.length > 0 || markers > 0 };
}

/**
 * The fold algebra for D-Mail.
 *
 * This module is pure: no Pi runtime, no I/O, no model, no clock, no globals.
 * Everything above it in `index.ts` is declarative wiring around the Pi
 * extension API. `test/fold.test.ts` unit-tests the algebra here.
 *
 * The unit of work is a *fold record*: a promise that a range of finished steps
 * has been replaced by a summary. Records are produced by the model (via the
 * `send_dmail` tool) and replayed here on every request. Replay is idempotent:
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

/** A fold record paired with the id of the session entry that holds it. */
export interface LocatedFold extends FoldRecord {
	/**
	 * The id of the entry this record was written into. An orphan — a record
	 * whose holder predates the boundary of the last compaction — is detected
	 * here, not at the endpoints: an orphan can point at entries still in view,
	 * and must still never be replayed.
	 */
	holderEntryId: string;
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
		| "end-not-a-step-boundary"
		| "record-out-of-era";
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
	 * Optional message to emit immediately before a kept entry, and before an
	 * injected summary at the fold's start (which is how a summary inherits the
	 * marker of the step it replaces). Used for step markers. Never called for
	 * any other dropped entry.
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

/** First index of each entry id; duplicate ids resolve to the earliest. */
function indexPositions<E extends EntryLike>(entries: readonly E[]): Map<string, number> {
	const positionOf = new Map<string, number>();
	entries.forEach((entry, index) => {
		if (!positionOf.has(entry.id)) positionOf.set(entry.id, index);
	});
	return positionOf;
}

/**
 * Validate one record against a positional view of the entries.
 *
 * Shared by `foldContext` (replay) and `planReplay` (era split), so a record
 * rejected in one place is rejected in the other for exactly the same reason.
 * Returns the start and end indices on success, or the reason it did not take
 * effect.
 */
function validateFold<E extends EntryLike>(
	fold: FoldRecord,
	positionOf: ReadonlyMap<string, number>,
	entries: readonly E[],
	isStepStart?: (entry: E) => boolean,
): { from: number; to: number; why: null } | { from: null; to: null; why: SkippedFold["why"] } {
	if (typeof fold?.summary !== "string" || fold.summary.trim() === "") {
		return { from: null, to: null, why: "blank-summary" };
	}
	const from = positionOf.get(fold.fromEntryId);
	if (from === undefined) return { from: null, to: null, why: "start-not-in-context" };
	const to = positionOf.get(fold.toEntryId);
	if (to === undefined) return { from: null, to: null, why: "end-not-in-context" };
	if (to <= from) return { from: null, to: null, why: "end-not-after-start" };
	if (isStepStart && !isStepStart(entries[from] as E)) {
		return { from: null, to: null, why: "start-not-a-step-boundary" };
	}
	if (isStepStart && !isStepStart(entries[to] as E)) {
		return { from: null, to: null, why: "end-not-a-step-boundary" };
	}
	return { from, to, why: null };
}

/** The split `foldContext` will make, computed without touching any record. */
export interface ReplayPlan {
	/** In-era records that passed validation, in input order. */
	inEra: FoldRecord[];
	/** Records that must not replay, with a reason — orphans included. */
	skipped: SkippedFold[];
}

/**
 * Split located fold records into what the current era may replay and what it
 * must count as skipped.
 *
 * The era check runs on the record's *holder*: a record written before the
 * boundary of the last compaction is an orphan even when both of its endpoints
 * happen to survive in the view, and must never fold the current era. Records
 * held in the era then go through the same validation `foldContext` applies, so
 * the count this reports is exactly the count replay would skip.
 *
 * Pure and deterministic: same inputs, same plan; records are never mutated.
 */
export function planReplay<E extends EntryLike>(
	entries: readonly E[],
	folds: readonly LocatedFold[],
	options: { isStepStart?: (entry: E) => boolean } = {},
): ReplayPlan {
	const positionOf = indexPositions(entries);
	const inEra: FoldRecord[] = [];
	const skipped: SkippedFold[] = [];

	for (const fold of folds) {
		if (!positionOf.has(fold.holderEntryId)) {
			skipped.push({ fold, why: "record-out-of-era" });
			continue;
		}
		const check = validateFold(fold, positionOf, entries, options.isStepStart);
		if (check.why !== null) {
			skipped.push({ fold, why: check.why });
			continue;
		}
		inEra.push(fold);
	}

	return { inEra, skipped };
}

/**
 * Replay fold records over a list of entries.
 *
 * Overlapping records are allowed; their drop ranges union. Summaries resolve by
 * containment: a newer record whose range contains an older record's start
 * replaces that summary — so a re-fold that reaches back to an earlier fold's
 * start renders one summary where two would collide, a same-start re-fold means
 * newest wins, and an overlap that stops short of the older start leaves both
 * summaries in place. Suppression compares records that validated only: a
 * skipped record neither suppresses nor is suppressed.
 */
export function foldContext<E extends EntryLike, M>(
	entries: readonly E[],
	folds: readonly FoldRecord[],
	options: FoldOptions<E, M>,
): FoldResult<M> {
	const positionOf = indexPositions(entries);
	const summaryAt = new Map<number, { text: string; fold: FoldRecord }>();
	const dropped = new Set<number>();
	const applied: FoldRecord[] = [];
	const skipped: SkippedFold[] = [];

	for (const fold of folds) {
		const check = validateFold(fold, positionOf, entries, options.isStepStart);
		if (check.why !== null) {
			skipped.push({ fold, why: check.why });
			continue;
		}
		const { from, to } = check;
		// Suppression by containment: this record's range swallows every summary
		// whose start it contains (its own included, so same-start is newest-wins).
		// Delete before set, or `from` would delete the entry just written.
		for (const key of [...summaryAt.keys()]) {
			if (from <= key && key < to) summaryAt.delete(key);
		}
		summaryAt.set(from, { text: wrapSummary(fold.summary), fold });
		for (let i = from; i < to; i++) dropped.add(i);
		applied.push(fold);
	}

	const messages: M[] = [];
	let markers = 0;

	const emitMarker = (entry: E, index: number): void => {
		if (!options.beforeEntry) return;
		const marker = options.beforeEntry(entry, index);
		if (marker !== undefined) {
			messages.push(marker);
			markers++;
		}
	};

	entries.forEach((entry, index) => {
		const summary = summaryAt.get(index);
		if (summary !== undefined) {
			// A summary sits exactly at its fold's original first step, so it gets
			// that step's marker: readers see the number the fold started from,
			// and numbers never renumber as folds stack.
			emitMarker(entry, index);
			messages.push(options.summaryMessage(summary.text, summary.fold));
		}
		if (dropped.has(index)) return;

		emitMarker(entry, index);
		for (const message of options.convert(entry)) messages.push(message);
	});

	return { messages, applied, skipped, changed: applied.length > 0 || markers > 0 };
}

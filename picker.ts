/**
 * Pure row builder for `/dmail fold` (tickets 07 and 12): the replayed view →
 * the rows the picker shows. No pi imports — rows are plain data; index.ts owns
 * the interaction and the delivery of the pinned range to the agent.
 *
 * A row offers one step (or one collapsed region) as EITHER endpoint. The
 * picker asks for a start first, then for an end, and both answers come from
 * this same row list, so the list never has to be rebuilt between phases. A
 * region row read as a start means "re-fold from there"; read as an end it
 * means "the whole region goes", which is why `endStepOf` answers with the
 * region's last step rather than its first.
 *
 * Rows are ordered latest first — the step you are in is never a row, so
 * `rows[0]` is the latest finished step, which is both where the cursor starts
 * and what the default end means. Row format follows /tree: `x` for a step,
 * `[a - b]` for a folded region, role + content peek per row, and a quiet `~Nk`
 * estimate as the tail.
 */
import type { FoldRecord, NumberedStep } from "./fold.ts";
import { foldSummaryPreview, fmtTokens } from "./render.ts";

/** A fold record as it arrives from the session (ticket 02 shape). */
export type FoldRangeInput = Pick<FoldRecord, "fromEntryId" | "toEntryId" | "fromStep" | "summary">;

/** One picker option: a step to pin, or an already-folded region collapsed. */
export interface FoldPickerRow {
	kind: "step" | "folded";
	/** The pinned start when this row is chosen as the START of the range. */
	fromStep: number;
	/** Message role of the step ("assistant"), or "fold" for a collapsed region. */
	role?: string;
	/** Original [first, last] step of a collapsed region; its end when chosen as an end. */
	range?: [number, number];
	/** Normalized first line of the entry text (or of the fold's summary). */
	preview: string;
	/** The quiet `~Nk` figure for a cut at this row, when known. */
	estimate?: string;
	/** Full option text: bracket/step, `role: peek`, and the estimate, joined by two spaces. */
	label: string;
}

/** Both ends of the cut, as the two picker phases answer them. Inclusive at both ends. */
export interface FoldPin {
	/** Step the cut starts at (a collapsed region row contributes its original start). */
	fromStep: number;
	/** Last step the cut archives (a collapsed region row contributes its last step). */
	throughStep: number;
}

/** Phase-1 title, shared by the TUI heading and the ui.select dialog. */
export const PICKER_TITLE = "Fold from which step?";

/** Phase-2 title (ticket 12): the same list, now read as the far endpoint. */
export const PICKER_END_TITLE = "Through which step?";

/** One sentence explaining the quiet row estimate, shared by every surface. */
export const ESTIMATE_LEGEND = "~ ≈ tokens this cut removes (+ = added)";

/**
 * The compact `~Nk` figure each row carries (signed like Economics): `~` for
 * the tokens the cut removes, `~+` for the rare cut that costs tokens (a memo
 * that outweighs the archive).
 */
export function estimateLine(removedTokens: number): string {
	return removedTokens < 0 ? `~+${fmtTokens(-removedTokens)}` : `~${fmtTokens(removedTokens)}`;
}

/** `[2]` for a single-step region, `[2 - 4]` for a span (literal hyphen, like /tree). */
export function foldBracket(from: number, through: number): string {
	return from === through ? `[${from}]` : `[${from} - ${through}]`;
}

/**
 * What this row means as the END of a range: the last step it archives.
 * For a plain step that is the step itself; for a collapsed region it is the
 * region's last step, so choosing the region folds the whole region in.
 */
export function endStepOf(row: FoldPickerRow): number {
	return row.kind === "folded" && row.range ? row.range[1] : row.fromStep;
}

/**
 * The ends a range starting at `fromStep` may stop at, latest first: `fromStep`
 * itself (a single-step fold is legal) up to the latest step before the one you
 * are in. One predicate on the caller's view, so the fold's refusal, the headless
 * hint, and the picker's dimmed rows cannot drift apart (ticket 12).
 */
export function validEnds(steps: readonly NumberedStep[], current: NumberedStep, fromStep: number): number[] {
	return steps
		.filter((step) => step.step >= fromStep && step.step < current.step)
		.map((step) => step.step)
		.reverse();
}

/** The latest finished step in view — never `current.step - 1`, which a folded-away step turns into a step that is not there. */
export function latestFinishedStep(steps: readonly NumberedStep[], current: NumberedStep): number {
	return steps.reduce((latest, step) => (step.step < current.step && step.step > latest ? step.step : latest), 0);
}

/** How a refusal names the ends it just computed, in the same order it printed them. */
export function endRefusal(chosen: number, ends: readonly number[]): string {
	return `There is no step ${chosen} to fold through. Ends: [${ends.join(", ")}].`;
}

export interface BuildFoldPickerRowsInput {
	/** Visible steps of the replayed view, ascending (NumberedStep.index = position). */
	steps: readonly NumberedStep[];
	/** The step the agent is in — never a start, so never a row. */
	current: NumberedStep;
	/** Folds that replay in this view (planForView().inEra). */
	folds?: readonly FoldRangeInput[];
	/** First-line preview for a step row; blank/undefined omits the part. */
	previewOf?: (step: NumberedStep) => string | undefined;
	/** The quiet `~Nk` estimate for a row pinned at this start. */
	estimateOf?: (fromStep: number) => string | undefined;
	/** Message role of a step's entry (e.g. "assistant"); absent omits the part. */
	roleOf?: (step: NumberedStep) => string | undefined;
}

/** A folded region as it collapses into one row. Positions index `steps`. */
interface Region {
	/** Covered steps are [fromPos, toPos) — the record's `to` is exclusive. */
	fromPos: number;
	toPos: number;
	/** Original first step of the region — still a legal pinned start (a re-fold). */
	fromStep: number;
	/** Original last folded step. */
	throughStep: number;
	/** Summary peek; the first row's survives a merge. */
	preview: string;
}

/**
 * Build the picker rows: one row per finished visible step, plus one row per
 * already-folded region labelled with its original step range. Steps inside a
 * region are collapsed away; the region row stands for the whole region at both
 * ends. Rows come out latest first (`rows[0]` = the latest finished step).
 */
export function buildFoldPickerRows(input: BuildFoldPickerRowsInput): FoldPickerRow[] {
	const { steps, current, folds = [], previewOf, estimateOf, roleOf } = input;
	const positionOf = new Map(steps.map((step, i) => [step.entryId, i]));

	// Fold records → regions: both endpoints are visible step entries, so the
	// last folded step is the one immediately before the `to` entry.
	const regions: Region[] = [];
	for (const fold of folds) {
		const fromPos = positionOf.get(fold.fromEntryId);
		const toPos = positionOf.get(fold.toEntryId);
		if (fromPos === undefined || toPos === undefined || toPos <= fromPos) continue;
		regions.push({
			fromPos,
			toPos,
			fromStep: fold.fromStep ?? steps[fromPos].step,
			throughStep: steps[toPos - 1].step,
			preview: foldSummaryPreview(fold.summary),
		});
	}

	// Merge overlapping ranges; adjacent-but-not-overlapping folds stay separate.
	// The first row's preview and role describe the merged region.
	regions.sort((a, b) => a.fromPos - b.fromPos);
	const merged: Region[] = [];
	for (const region of regions) {
		const prev = merged[merged.length - 1];
		if (prev && region.fromPos < prev.toPos) {
			prev.toPos = Math.max(prev.toPos, region.toPos);
			prev.fromStep = Math.min(prev.fromStep, region.fromStep);
			prev.throughStep = Math.max(prev.throughStep, region.throughStep);
		} else {
			merged.push({ ...region });
		}
	}

	const covered = (pos: number) => merged.some((r) => pos >= r.fromPos && pos < r.toPos);
	const label = (parts: (string | undefined)[]) => parts.filter((part): part is string => !!part).join("  ");
	const middle = (role: string | undefined, preview: string): string | undefined => {
		if (preview) return role ? `${role}: ${preview}` : preview;
		return role ? `${role}:` : undefined;
	};

	const rows: { pos: number; row: FoldPickerRow }[] = [];
	for (const region of merged) {
		const estimate = estimateOf?.(region.fromStep);
		const bracket = foldBracket(region.fromStep, region.throughStep);
		rows.push({
			pos: region.fromPos,
			row: {
				kind: "folded",
				fromStep: region.fromStep,
				role: "fold",
				range: [region.fromStep, region.throughStep],
				preview: region.preview,
				estimate,
				label: label([bracket, middle("fold", region.preview), estimate]),
			},
		});
	}
	const currentPos = positionOf.get(current.entryId) ?? steps.length;
	for (const [pos, step] of steps.entries()) {
		if (pos >= currentPos) continue; // the step you are in has nothing finished after it
		if (covered(pos)) continue; // collapsed into a region row
		const preview = previewOf?.(step) ?? "";
		const role = roleOf?.(step);
		const estimate = estimateOf?.(step.step);
		rows.push({
			pos,
			row: {
				kind: "step",
				fromStep: step.step,
				role,
				preview,
				estimate,
				label: label([String(step.step), middle(role, preview), estimate]),
			},
		});
	}

	// Latest first, so the default end and the starting cursor are both `rows[0]`.
	// Every list a fold reads — the picker, the printed fallback, `/dmail price`'
	// candidates — is ordered this way, newest at the top.
	rows.sort((a, b) => b.pos - a.pos);
	return rows.map(({ row }) => row);
}

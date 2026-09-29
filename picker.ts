/**
 * Pure row builder for `/dmail fold` (ticket 07): the replayed view → the rows
 * the interactive picker shows. No pi imports — rows are plain data; index.ts
 * owns the interaction and the delivery of the pinned start to the agent.
 *
 * A row pins a START only. The end is always the latest finished step, which
 * `planFold` freezes on the agent's side, so rows never carry an end.
 */
import type { FoldRecord, NumberedStep } from "./fold.ts";
import { fmtTokens } from "./render.ts";

/** Endpoints of a fold record as it arrives from the session (ticket 02 shape). */
export type FoldRangeInput = Pick<FoldRecord, "fromEntryId" | "toEntryId" | "fromStep">;

/** An already-folded region as it collapses into a single picker row. */
export interface FoldRegion {
	/** Original first step of the region — a legal pinned start. */
	fromStep: number;
	/** Original last folded step (the record's `to` is exclusive). */
	throughStep: number;
	/** Positions in the steps array, for coverage and row ordering. */
	fromIndex: number;
	toIndex: number;
}

export interface FoldPickerRow {
	kind: "step" | "folded";
	/** The pinned start when this row is chosen. */
	fromStep: number;
	/** Full option text: label + preview + `~Nk tokens removed` estimate. */
	label: string;
}

/** The `~Nk tokens removed` figure each row carries (signed like Economics). */
export function estimateLine(removedTokens: number): string {
	const magnitude = Math.abs(removedTokens);
	return removedTokens < 0 ? `~${fmtTokens(magnitude)} tokens added` : `~${fmtTokens(magnitude)} tokens removed`;
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
	/** `~Nk tokens removed` estimate for a row pinned at this start. */
	estimateOf?: (fromStep: number) => string | undefined;
}

/**
 * Build the picker rows: one row per finished visible step, plus one row per
 * already-folded region labelled with its original step range. Steps inside a
 * region are collapsed away; picking the region row pins its original start.
 */
export function buildFoldPickerRows(input: BuildFoldPickerRowsInput): FoldPickerRow[] {
	const { steps, current, folds = [], previewOf, estimateOf } = input;
	const stepByEntry = new Map(steps.map((step) => [step.entryId, step]));

	// Fold records → regions: endpoints are visible step entries, `to` exclusive.
	const regions: FoldRegion[] = [];
	for (const fold of folds) {
		const from = stepByEntry.get(fold.fromEntryId);
		const to = stepByEntry.get(fold.toEntryId);
		if (!from || !to || to.index <= from.index) continue;
		const last = [...steps].reverse().find((step) => step.index < to.index);
		if (!last) continue;
		regions.push({
			fromIndex: from.index,
			toIndex: to.index,
			fromStep: fold.fromStep ?? from.step,
			throughStep: last.step,
		});
	}

	// Merge overlapping ranges; adjacent-but-not-overlapping folds stay separate.
	regions.sort((a, b) => a.fromIndex - b.fromIndex);
	const merged: FoldRegion[] = [];
	for (const region of regions) {
		const prev = merged[merged.length - 1];
		if (prev && region.fromIndex < prev.toIndex) {
			prev.toIndex = Math.max(prev.toIndex, region.toIndex);
			prev.fromStep = Math.min(prev.fromStep, region.fromStep);
			prev.throughStep = Math.max(prev.throughStep, region.throughStep);
		} else {
			merged.push({ ...region });
		}
	}

	const covered = (index: number) => merged.some((r) => index >= r.fromIndex && index < r.toIndex);
	const label = (parts: (string | undefined)[]) => parts.filter(Boolean).join(" · ");

	const rows: { pos: number; row: FoldPickerRow }[] = [];
	for (const region of merged) {
		const head =
			region.fromStep === region.throughStep
				? `Folded step ${region.fromStep}`
				: `Folded steps ${region.fromStep}–${region.throughStep}`;
		rows.push({
			pos: region.fromIndex,
			row: {
				kind: "folded",
				fromStep: region.fromStep,
				label: label([head, estimateOf?.(region.fromStep)]),
			},
		});
	}
	for (const step of steps) {
		if (step.index >= current.index) continue; // the step you are in has nothing finished after it
		if (covered(step.index)) continue; // collapsed into a region row
		rows.push({
			pos: step.index,
			row: {
				kind: "step",
				fromStep: step.step,
				label: label([`Step ${step.step}`, previewOf?.(step), estimateOf?.(step.step)]),
			},
		});
	}

	rows.sort((a, b) => a.pos - b.pos);
	return rows.map(({ row }) => row);
}

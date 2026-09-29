/**
 * Pure picker row builder (ticket 07): the replayed view → the rows `/dmail fold`
 * shows. No pi wiring here — rows are data; index.ts owns delivery.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFoldPickerRows, estimateLine } from "../picker.ts";
import type { NumberedStep } from "../fold.ts";

/** e1..e10 with assistant steps on the even ids: five visible steps. */
function fiveSteps(): NumberedStep[] {
	return [1, 2, 3, 4, 5].map((step, i) => ({ step, entryId: `e${2 + i * 2}`, index: 1 + i * 2 }));
}

const estimateOf = (fromStep: number) => `~${fromStep}k tokens removed`;

test("one row per finished step, with preview and token estimate; the step you are in is never a start", () => {
	const steps = fiveSteps();
	const current = steps[steps.length - 1];
	const rows = buildFoldPickerRows({
		steps,
		current,
		estimateOf,
		previewOf: (step) => `first line of step ${step.step}`,
	});

	assert.deepEqual(
		rows.map((r) => `${r.kind}:${r.fromStep}`),
		["step:1", "step:2", "step:3", "step:4"],
	);
	assert.equal(rows[0].label, "Step 1 · first line of step 1 · ~1k tokens removed");
});

test("a folded region collapses to one row labelled with its original range, and picking it is a legal start", () => {
	const steps = fiveSteps();
	const current = steps[steps.length - 1];
	const rows = buildFoldPickerRows({
		steps,
		current,
		estimateOf,
		folds: [{ fromEntryId: "e4", toEntryId: "e6", fromStep: 2 }],
		previewOf: (step) => `line ${step.step}`,
	});

	assert.deepEqual(
		rows.map((r) => `${r.kind}:${r.fromStep}`),
		["step:1", "folded:2", "step:3", "step:4"],
		"the folded step is represented by exactly one region row",
	);
	assert.equal(rows[1].label, "Folded step 2 · ~2k tokens removed");
	assert.ok(rows[1].fromStep < current.step, "the region's original start is a legal pinned start");
});

test("overlapping folds merge into a single region row covering their combined range", () => {
	const steps = fiveSteps();
	const current = steps[steps.length - 1];
	const rows = buildFoldPickerRows({
		steps,
		current,
		estimateOf,
		folds: [
			{ fromEntryId: "e2", toEntryId: "e6", fromStep: 1 }, // covers steps 1–2
			{ fromEntryId: "e4", toEntryId: "e8", fromStep: 2 }, // covers steps 2–3
		],
	});

	assert.deepEqual(
		rows.map((r) => `${r.kind}:${r.fromStep}`),
		["folded:1", "step:4"],
	);
	assert.equal(rows[0].label, "Folded steps 1–3 · ~1k tokens removed");
});

test("estimates and previews are optional parts of the label", () => {
	const rows = buildFoldPickerRows({
		steps: fiveSteps(),
		current: fiveSteps()[4],
		previewOf: () => "",
	});

	assert.deepEqual(
		rows.map((r) => r.label),
		["Step 1", "Step 2", "Step 3", "Step 4"],
	);
});

test("estimateLine renders the ~Nk figure the ticket asks rows to carry", () => {
	assert.equal(estimateLine(4800), "~4.8k tokens removed");
	assert.equal(estimateLine(700), "~700 tokens removed");
	assert.equal(estimateLine(48_000), "~48k tokens removed");
	assert.equal(estimateLine(-3000), "~3k tokens added");
});

/**
 * Pure picker row builder (ticket 07): the replayed view → the rows `/dmail fold`
 * shows. No pi wiring here — rows are data; index.ts owns delivery.
 *
 * Row format follows /tree: `x` for a step, `[a - b]` for a folded region,
 * role + content peek per row, and a quiet `~Nk` estimate as the tail.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFoldPickerRows, estimateLine } from "../picker.ts";
import type { NumberedStep } from "../fold.ts";

/** e1..e10 with assistant steps on the even ids: five visible steps. */
function fiveSteps(): NumberedStep[] {
	return [1, 2, 3, 4, 5].map((step, i) => ({ step, entryId: `e${2 + i * 2}`, index: 1 + i * 2 }));
}

const estimateOf = (fromStep: number) => `~${fromStep}k`;
const roleOf = () => "assistant";

test("one row per finished step, with role, peek and token estimate; the step you are in is never a start", () => {
	const steps = fiveSteps();
	const current = steps[steps.length - 1];
	const rows = buildFoldPickerRows({
		steps,
		current,
		estimateOf,
		roleOf,
		previewOf: (step) => `first line of step ${step.step}`,
	});

	assert.deepEqual(
		rows.map((r) => `${r.kind}:${r.fromStep}`),
		["step:1", "step:2", "step:3", "step:4"],
	);
	assert.equal(rows[0].label, "1  assistant: first line of step 1  ~1k");
	assert.equal(rows[0].role, "assistant", "the row carries the message role");
	assert.equal(rows[0].preview, "first line of step 1", "the row carries the content peek");
	assert.equal(rows[0].estimate, "~1k", "the row carries the quiet ~Nk figure");
});

test("a folded region collapses to one row labelled with its original range, and picking it is a legal start", () => {
	const steps = fiveSteps();
	const current = steps[steps.length - 1];
	const rows = buildFoldPickerRows({
		steps,
		current,
		estimateOf,
		roleOf,
		folds: [{ fromEntryId: "e4", toEntryId: "e6", fromStep: 2, summary: "Venue booked: the hall." }],
		previewOf: (step) => `line ${step.step}`,
	});

	assert.deepEqual(
		rows.map((r) => `${r.kind}:${r.fromStep}`),
		["step:1", "folded:2", "step:3", "step:4"],
		"the folded step is represented by exactly one region row",
	);
	assert.equal(rows[1].label, "[2]  fold: Venue booked: the hall.  ~2k");
	assert.deepEqual(rows[1].range, [2, 2], "single-step region brackets its range");
	assert.equal(rows[1].role, "fold");
	assert.ok(rows[1].fromStep < current.step, "the region's original start is a legal pinned start");
});

test("overlapping folds merge into a single region row covering their combined range", () => {
	const steps = fiveSteps();
	const current = steps[steps.length - 1];
	const rows = buildFoldPickerRows({
		steps,
		current,
		estimateOf,
		roleOf,
		folds: [
			{ fromEntryId: "e2", toEntryId: "e6", fromStep: 1, summary: "First fold summary." }, // covers steps 1–2
			{ fromEntryId: "e4", toEntryId: "e8", fromStep: 2, summary: "Second fold summary." }, // covers steps 2–3
		],
	});

	assert.deepEqual(
		rows.map((r) => `${r.kind}:${r.fromStep}`),
		["folded:1", "step:4"],
	);
	assert.equal(rows[0].label, "[1 - 3]  fold: First fold summary.  ~1k");
	assert.deepEqual(rows[0].range, [1, 3]);
});

test("role, peek and estimate are optional parts of the label", () => {
	const rows = buildFoldPickerRows({
		steps: fiveSteps(),
		current: fiveSteps()[4],
		previewOf: () => "",
	});

	assert.deepEqual(
		rows.map((r) => r.label),
		["1", "2", "3", "4"],
	);
});

test("estimateLine renders the compact ~Nk figure (+ for a memo that outweighs the archive)", () => {
	assert.equal(estimateLine(4800), "~4.8k");
	assert.equal(estimateLine(700), "~700");
	assert.equal(estimateLine(48_000), "~48k");
	assert.equal(estimateLine(-3000), "~+3k");
});

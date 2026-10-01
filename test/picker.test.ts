/**
 * Pure picker row builder (tickets 07 and 12): the replayed view → the rows
 * `/dmail fold` shows. No pi wiring here — rows are data; index.ts owns delivery.
 *
 * Rows are latest first, because `rows[0]` is both where the cursor opens and
 * what the default end means. Row format follows /tree: `x` for a step,
 * `[a - b]` for a folded region, role + content peek per row, and a quiet `~Nk`
 * estimate as the tail.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildFoldPickerRows,
	endStepOf,
	estimateLine,
	ESTIMATE_LEGEND,
	latestFinishedStep,
	PICKER_END_TITLE,
	PICKER_TITLE,
	validEnds,
} from "../picker.ts";
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
		["step:4", "step:3", "step:2", "step:1"],
		"latest first — rows[0] is the latest finished step",
	);
	assert.equal(rows[3].label, "1  assistant: first line of step 1  ~1k");
	assert.equal(rows[3].role, "assistant", "the row carries the message role");
	assert.equal(rows[3].preview, "first line of step 1", "the row carries the content peek");
	assert.equal(rows[3].estimate, "~1k", "the row carries the quiet ~Nk figure");
	assert.equal(PICKER_TITLE, "Fold from which step?", "phase-1 title");
	assert.equal(PICKER_END_TITLE, "Through which step?", "phase-2 title");
	assert.equal(ESTIMATE_LEGEND, "~ ≈ tokens this cut removes (+ = added)", "one legend for every surface");
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
		["step:4", "step:3", "folded:2", "step:1"],
		"the folded step is represented by exactly one region row",
	);
	assert.equal(rows[2].label, "[2]  fold: Venue booked: the hall.  ~2k");
	assert.deepEqual(rows[2].range, [2, 2], "single-step region brackets its range");
	assert.equal(rows[2].role, "fold");
	assert.ok(rows[2].fromStep < current.step, "the region's original start is a legal pinned start");
	assert.equal(endStepOf(rows[2]), 2, "as an end the region folds through its last step");
	assert.equal(endStepOf(rows[0]), 4, "as an end a plain step folds through itself");
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
		["step:4", "folded:1"],
	);
	assert.equal(rows[1].label, "[1 - 3]  fold: First fold summary.  ~1k");
	assert.deepEqual(rows[1].range, [1, 3]);
	assert.equal(endStepOf(rows[1]), 3, "choosing the region as the end folds the whole region in");
});

test("role, peek and estimate are optional parts of the label", () => {
	const rows = buildFoldPickerRows({
		steps: fiveSteps(),
		current: fiveSteps()[4],
		previewOf: () => "",
	});

	assert.deepEqual(
		rows.map((r) => r.label),
		["4", "3", "2", "1"],
	);
});

test("with no round in progress, the newest step is a row like any other", () => {
	const rows = buildFoldPickerRows({ steps: fiveSteps(), previewOf: () => "", roleOf });

	assert.deepEqual(
		rows.map((r) => r.fromStep),
		[5, 4, 3, 2, 1],
		"nothing running means nothing is held back",
	);
	assert.equal(endStepOf(rows[0]), 5, "the newest step is also the default end");
});

test("validEnds and latestFinishedStep follow whether a round is in flight", () => {
	const steps = fiveSteps();
	const current = steps[steps.length - 1];

	assert.deepEqual(validEnds(steps, current, 3), [4, 3], "the round in flight is never an end");
	assert.deepEqual(validEnds(steps, undefined, 3), [5, 4, 3], "idle, the newest step is a legal end");
	assert.deepEqual(validEnds(steps, current, 5), [], "the round in flight has nothing after it");
	assert.deepEqual(validEnds(steps, undefined, 5), [5], "idle, A == B is the whole cut");
	assert.equal(latestFinishedStep(steps, current), 4);
	assert.equal(latestFinishedStep(steps, undefined), 5);
});

test("estimateLine renders the compact ~Nk figure (+ for a memo that outweighs the archive)", () => {
	assert.equal(estimateLine(4800), "~4.8k");
	assert.equal(estimateLine(700), "~700");
	assert.equal(estimateLine(48_000), "~48k");
	assert.equal(estimateLine(-3000), "~+3k");
});

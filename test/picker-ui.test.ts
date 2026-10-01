/**
 * The scrollable /tree-style picker component behind `/dmail fold` (tickets 07
 * and 12): row styling (cursor, role/range colours, dim estimate), the centred
 * scroll window, and the two-phase machine that asks the same stable list for a
 * start and then for an end — driven here through render()/handleInput() with an
 * echoing theme (no live terminal).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { FoldPickerComponent, type FoldPin } from "../picker-ui.ts";
import { buildFoldPickerRows, type FoldPickerRow } from "../picker.ts";
import type { NumberedStep } from "../fold.ts";

/** Echoing theme: fg/bg wrap the text so assertions can see the colours. */
const theme = {
	fg: (color: string, text: string) => `<${color}:${text}>`,
	bg: (color: string, text: string) => `<bg-${color}:${text}>`,
	bold: (text: string) => text,
} as unknown as Theme;

/**
 * `count` finished steps, latest first — the order buildFoldPickerRows hands
 * over, so index 0 is the latest finished step and the default end.
 */
function stepRows(count: number): FoldPickerRow[] {
	return Array.from({ length: count }, (_, i) => {
		const step = count - i;
		return {
			kind: "step" as const,
			fromStep: step,
			role: "assistant",
			preview: `peek ${step}`,
			estimate: "~4.8k",
			label: `${step}  assistant: peek ${step}  ~4.8k`,
		};
	});
}

/** The step at list index `i` of a `count`-row list. */
const stepAt = (count: number, i: number) => count - i;

/** Component plus the callbacks it drives, so tests can await a choice. */
function make(rows: FoldPickerRow[], terminalRows = 12, rangeEstimate?: (from: number, through: number) => string) {
	const picked: { pin?: FoldPin; cancelled: boolean } = { cancelled: false };
	const component = new FoldPickerComponent({
		rows,
		theme,
		terminalRows,
		rangeEstimate,
		onSelect: (pin) => {
			picked.pin = pin;
		},
		onCancel: () => {
			picked.cancelled = true;
		},
	});
	return { component, picked };
}

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const ESC = "\x1b";
const PAGE_DOWN = "\x1b[6~";
const PAGE_UP = "\x1b[5~";

/** Pin `start` as the start of the range, leaving the picker in phase 2. */
function pinStart(component: FoldPickerComponent, start: number): void {
	const index = component.rows.findIndex((row) => row.fromStep === start);
	for (let i = 0; i < index; i++) component.handleInput(DOWN);
	component.handleInput(ENTER);
}

test("phase 1 renders the title, the end-is-latest legend, coloured rows and the position footer", () => {
	const { component } = make(stepRows(20));
	const lines = component.render(120);
	const text = lines.join("\n");

	assert.match(text, /Fold from which step/, "title");
	assert.doesNotMatch(text, /Through which step/, "phase 1 asks for the start only");
	assert.doesNotMatch(text, /Pending \[/, "no pending range before a start exists");
	assert.match(text, /latest finished step/, "the legend says what the row estimates mean");
	assert.match(text, /~ ≈ tokens this cut removes/, "the legend explains the quiet estimate");

	const rowLines = lines.filter((line) => line.includes("<text:peek"));
	assert.equal(rowLines.length, 6, "terminalRows=12 → a /tree-style window of rows, not all 20");
	assert.ok(
		rowLines[0].startsWith("  <accent:› >"),
		"cursor opens on the top row, the latest finished step; the gutter column is reserved in both phases",
	);
	assert.match(
		rowLines[0],
		/<accent:20>  <success:assistant: ><text:peek 20>  <dim:~4\.8k>/,
		"latest step first: number, role, peek, dim estimate",
	);
	assert.ok(rowLines[0].includes("<bg-selectedBg:"), "selected row carries the selected background");
	assert.ok(!rowLines[1].includes("<bg-selectedBg:"), "unselected rows do not");
	assert.ok(!rowLines.some((line) => line.includes("│")), "phase 1 shows no end gutter anywhere");

	assert.match(text, /\(1\/20\)/, "position footer");
	assert.match(text, /navigate/, "key hints");
});

test("the window follows the selection, centre-anchored like /tree", () => {
	const { component } = make(stepRows(20));
	for (let i = 0; i < 12; i++) component.handleInput(DOWN);

	const text = component.render(120).join("\n");
	assert.match(text, /\(13\/20\)/);
	assert.ok(text.includes(`<accent:${stepAt(20, 12)}>`), "the selection is visible");
	assert.ok(!text.includes(`<accent:${stepAt(20, 0)}>`), "the top row scrolled out of the window");
	assert.ok(text.includes(`<accent:${stepAt(20, 14)}>`), "the window reaches two rows past the selection");
	assert.ok(!text.includes(`<accent:${stepAt(20, 15)}>`), "rows past the window stay hidden");

	component.handleInput(UP);
	assert.match(component.render(120).join("\n"), /\(12\/20\)/, "one row back up");
});

test("arrow, vim, and page keys move in phase 1; Enter, Enter pins start and default end", () => {
	const { component, picked } = make(stepRows(20));

	component.handleInput(DOWN);
	assert.match(component.render(120).join("\n"), /\(2\/20\)/);
	component.handleInput("k");
	assert.match(component.render(120).join("\n"), /\(1\/20\)/, "k = up");
	component.handleInput("j");
	assert.match(component.render(120).join("\n"), /\(2\/20\)/, "j = down");
	component.handleInput(PAGE_DOWN);
	assert.match(component.render(120).join("\n"), /\(8\/20\)/, "page down advances a window");
	component.handleInput(PAGE_UP);
	assert.match(component.render(120).join("\n"), /\(2\/20\)/, "page up rewinds a window");

	component.handleInput(DOWN); // index 2 = step 18
	component.handleInput(ENTER); // pin the start
	assert.equal(picked.pin, undefined, "one Enter only pins a start; the picker stays open");
	assert.equal(component.state.phase, "end");
	assert.equal(component.state.cursor, 0, "the end cursor pre-selects the latest finished step");

	component.handleInput(ENTER);
	assert.deepEqual(picked.pin, { fromStep: 18, throughStep: 20 }, "Enter, Enter = start + latest end");
});

test("phase 2 titles the same list, shows the pending range, and keeps the list and window stable", () => {
	const rows = stepRows(8);
	const calls: string[] = [];
	const { component } = make(rows, 12, (from, through) => {
		calls.push(`${from}-${through}`);
		return "~9k";
	});
	const before = component.render(120);
	pinStart(component, 5); // index 3

	const text = component.render(120).join("\n");
	assert.match(text, /Through which step\?/, "phase-2 title");
	assert.match(text, /Pending\s+\[5 - 8\]/, "the pending range, latest end by default");
	assert.match(text, /\[5 - 8\]  ~9k/, "the pending range carries one live figure");
	assert.match(text, /~ ≈ tokens this cut removes/, "the legend travels with the figure");
	assert.match(text, /\(1\/8\)/, "the footer counter is unchanged by the phase change");
	assert.match(text, /esc back|back/, "escape now means back, not cancel");

	const shownOrder = (lines: string[]) =>
		rows.filter((row) => lines.some((line) => line.includes(row.preview))).map((row) => row.fromStep);
	assert.equal(component.rows, rows, "the list itself is never rebuilt between phases");
	assert.deepEqual(
		shownOrder(component.render(120)),
		shownOrder(before),
		"the same rows in the same order and the same scroll window: the list is stable across phases",
	);
	assert.deepEqual(calls, ["5-8"], "one figure per (start, end) pair");

	component.handleInput(DOWN); // one step older: a new pair, so a new figure
	assert.match(component.render(120).join("\n"), /\[5 - 7\]  ~9k/, "the figure follows the cursor");
	assert.deepEqual(calls, ["5-8", "5-7"], "a new end asks for its figure once");
	component.handleInput(UP);
	component.render(120);
	component.render(120);
	assert.deepEqual(calls, ["5-8", "5-7"], "the pair already priced comes from the memo");
});

test("the (start, end) memo never re-asks the host for a pair it already priced", () => {
	const calls: string[] = [];
	const { component } = make(stepRows(6), 12, (from, through) => {
		calls.push(`${from}>${through}`);
		return "~1k";
	});
	pinStart(component, 3); // rows: 6,5,4,3,2,1 — the start sits at index 3

	component.render(120);
	component.render(120);
	for (let i = 0; i < 4; i++) {
		component.handleInput(DOWN);
		component.render(120);
		component.render(120);
	}
	assert.deepEqual(calls, ["3>6", "3>5", "3>4", "3>3"], "one figure per (start, end) pair, in visit order");

	for (let i = 0; i < 3; i++) {
		component.handleInput(UP);
		component.render(120);
	}
	assert.equal(calls.length, 4, "returning to a priced pair reuses the memo");
});

test("in phase 2 invalid ends are dimmed, the pending range carries the gutter, and the cursor never visits a dimmed row", () => {
	const { component } = make(stepRows(6), 12, () => "~1k");
	pinStart(component, 4); // rows: 6,5,4 | 3,2,1 — the last three are older than the start

	const lines = component.render(120);
	const rowLines = lines.filter((line) => line.includes("peek"));
	assert.equal(rowLines.length, 6, "invalid rows stay in the list, dimmed — nothing is re-filtered");

	const stepOf = (line: string) => /peek (\d)/.exec(line)?.[1] ?? "";
	const valid = rowLines.filter((line) => "456".includes(stepOf(line)));
	const invalid = rowLines.filter((line) => "123".includes(stepOf(line)));
	assert.equal(valid.length, 3);
	assert.equal(invalid.length, 3);
	// The cursor opens on the default end (row 0), so the pending range is 6..4 and
	// the gutter spans those three rows — not merely "every reachable end".
	for (const line of valid) assert.ok(line.includes("<muted:│ >"), `gutter on the pending range: ${line}`);
	for (const line of invalid) {
		assert.ok(!line.includes("│"), `no gutter on an invalid end: ${line}`);
		assert.match(line, /<dim:\d+  assistant: peek \d+  ~4\.8k>/, "the whole invalid row is dimmed");
	}

	const selected = rowLines.filter((line) => line.includes("<bg-selectedBg:"));
	assert.equal(selected.length, 1, "the background belongs to the cursor alone");
	assert.ok(selected[0].includes("<muted:│ >"), "the cursor row is inside the range");
	assert.ok(!invalid.some((line) => line.includes("›")), "a dimmed row can never carry the cursor");

	// The gutter is the range, so it follows the cursor down to the start row.
	component.handleInput(DOWN);
	const moved = component.render(120).filter((line) => line.includes("peek"));
	assert.ok(moved[0].includes("peek 6") && !moved[0].includes("│"), "step 6 is now above the cut: no gutter");
	assert.ok(moved[1].includes("<muted:│ >"), "the cursor row stays in the range");
	assert.ok(moved[2].includes("<muted:│ >"), "the start row closes the range");

	// ↓ stops at the start row, which is itself a valid end (A == B is legal).
	for (let i = 0; i < 4; i++) component.handleInput(DOWN);
	assert.equal(component.state.cursor, 2, "the cursor stops on the start row, not on the dimmed rows");
	assert.match(component.render(120).join("\n"), /\(3\/6\)/, "footer counter unchanged in phase 2");
	assert.deepEqual(component.pending, { fromStep: 4, throughStep: 4 }, "A == B is a legal single-step fold");

	component.handleInput(UP);
	assert.equal(component.state.cursor, 1, "up leaves the start row again");
});

test("page down in phase 2 stops at the start row too", () => {
	const { component } = make(stepRows(20), 12);
	pinStart(component, 8); // index 12
	for (let i = 0; i < 4; i++) component.handleInput(PAGE_DOWN);
	assert.equal(component.state.cursor, 12, "page down never walks into the dimmed rows");
	for (let i = 0; i < 4; i++) component.handleInput(PAGE_UP);
	assert.equal(component.state.cursor, 0, "page up still reaches the latest finished step");
});

test("escape backs out of phase 2 with the start intact, and only phase 1 cancels", () => {
	const { component, picked } = make(stepRows(6), 12);
	pinStart(component, 3);
	assert.equal(component.state.phase, "end");
	assert.deepEqual(component.pending, { fromStep: 3, throughStep: 6 });

	component.handleInput(DOWN);
	component.handleInput(ESC);

	assert.equal(component.state.phase, "start", "escape leaves the end phase");
	assert.equal(picked.pin, undefined, "nothing is pinned by backing out");
	assert.equal(component.state.cursor, 3, "the cursor returns to the row the start was pinned from");
	assert.match(component.render(120).join("\n"), /Fold from which step/, "phase 1 is rendered again");

	component.handleInput(ENTER); // re-accept the same start, no re-scrolling needed
	assert.deepEqual(component.pending, { fromStep: 3, throughStep: 6 }, "the start survived the trip back");
	component.handleInput(ENTER);
	assert.deepEqual(picked.pin, { fromStep: 3, throughStep: 6 });
});

test("escape in phase 1 cancels and pins nothing", () => {
	const { component, picked } = make(stepRows(4));
	component.handleInput(DOWN);
	component.handleInput(ESC);
	assert.equal(picked.cancelled, true);
	assert.equal(picked.pin, undefined, "no range is pinned on cancel");
});

test("a region row means its last step as an end and its first step as a start", () => {
	const steps: NumberedStep[] = [1, 2, 3, 4, 5, 6].map((step) => ({ step, entryId: `e${step}`, index: step }));
	const rows = buildFoldPickerRows({
		steps,
		current: steps[5],
		folds: [{ fromEntryId: "e2", toEntryId: "e5", fromStep: 2, summary: "Venue booked: the hall." }],
		previewOf: (step) => `peek ${step.step}`,
	});
	assert.deepEqual(
		rows.map((row) => row.fromStep),
		[5, 2, 1],
		"the region row keeps its own slot (steps 2-4 collapsed) and the list is latest first",
	);

	// As an end the collapsed region means its LAST step: the whole region folds in.
	const asEnd = make(rows, 12);
	pinStart(asEnd.component, 1); // the oldest visible step
	asEnd.component.handleInput(DOWN); // onto the region row [2 - 4]
	assert.deepEqual(asEnd.component.pending, { fromStep: 1, throughStep: 4 });
	asEnd.component.handleInput(ENTER);
	assert.deepEqual(asEnd.picked.pin, { fromStep: 1, throughStep: 4 }, "the region folds the whole region in");

	// As a start the same row means its FIRST step: a re-fold from the region's start.
	const asStart = make(rows, 12);
	pinStart(asStart.component, 2);
	assert.equal(asStart.component.state.phase, "end", "the region row is a legal start");
	asStart.component.handleInput(ENTER);
	assert.deepEqual(asStart.picked.pin, { fromStep: 2, throughStep: 5 }, "as a start the region means fromStep");
});

test("a folded-region row renders its range bracket in the warning colour", () => {
	const rows: FoldPickerRow[] = [
		...stepRows(3).map((row) => ({ ...row, fromStep: row.fromStep + 4 })),
		{
			kind: "folded",
			fromStep: 2,
			range: [2, 4],
			role: "fold",
			preview: "Venue booked: the hall.",
			estimate: "~12k",
			label: "[2 - 4]  fold: Venue booked: the hall.  ~12k",
		},
	];
	const { component } = make(rows, 40);
	const lines = component.render(120).join("\n");

	assert.match(lines, /<warning:\[2 - 4\]>/, "region range");
	assert.match(lines, /<muted:fold: ><text:Venue booked: the hall\.>/, "region role + summary peek");
	assert.match(lines, /<dim:~12k>/, "estimate stays quiet");
});

test("invalidate is a no-op and narrow widths truncate instead of wrapping", () => {
	const { component } = make(stepRows(4));
	component.invalidate();
	const lines = component.render(10);
	assert.ok(lines.every((line) => line.split("\n").length === 1), "one row per line");
	assert.ok(lines.length > 0, "still renders something");
});

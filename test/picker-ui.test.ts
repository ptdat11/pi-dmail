/**
 * The scrollable /tree-style picker component behind `/dmail fold` (ticket 07):
 * row styling (cursor, role/range colours, dim estimate) and the centred
 * scroll window — built as a plain pi-tui Component, driven here through
 * render()/handleInput() with an echoing theme (no live terminal).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { FoldPickerComponent } from "../picker-ui.ts";
import type { FoldPickerRow } from "../picker.ts";

/** Echoing theme: fg/bg wrap the text so assertions can see the colours. */
const theme = {
	fg: (color: string, text: string) => `<${color}:${text}>`,
	bg: (color: string, text: string) => `<bg-${color}:${text}>`,
	bold: (text: string) => text,
} as unknown as Theme;

function stepRows(count: number): FoldPickerRow[] {
	return Array.from({ length: count }, (_, i) => ({
		kind: "step" as const,
		fromStep: i + 1,
		role: "assistant",
		preview: `peek ${i + 1}`,
		estimate: "~4.8k",
		label: `${i + 1}  assistant: peek ${i + 1}  ~4.8k`,
	}));
}

/** Component plus the callbacks it drives, so tests can await a choice. */
function make(rows: FoldPickerRow[], terminalRows = 12) {
	const picked: { fromStep?: number; cancelled: boolean } = { cancelled: false };
	const component = new FoldPickerComponent({
		rows,
		theme,
		terminalRows,
		onSelect: (fromStep) => {
			picked.fromStep = fromStep;
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

test("renders the title, the start-only legend, coloured rows and the position footer", () => {
	const { component } = make(stepRows(20));
	const lines = component.render(120);

	assert.match(lines.join("\n"), /Fold from which step/, "title");
	assert.match(lines.join("\n"), /latest finished step/, "the legend says the end resolves automatically");
	assert.match(lines.join("\n"), /~ ≈ tokens this cut removes/, "the legend explains the quiet estimate");

	const rowLines = lines.filter((line) => line.includes("<text:peek"));
	assert.equal(rowLines.length, 6, "terminalRows=12 → a /tree-style window of rows, not all 20");
	assert.ok(rowLines[0].startsWith("<accent:› >"), "cursor on the selected row");
	assert.match(rowLines[0], /<accent:1>  <success:assistant: ><text:peek 1>  <dim:~4\.8k>/, "step number, role, peek, dim estimate");
	assert.ok(rowLines[0].includes("<bg-selectedBg:"), "selected row carries the selected background");
	assert.ok(!rowLines[1].includes("<bg-selectedBg:"), "unselected rows do not");

	assert.match(lines.join("\n"), /\(1\/20\)/, "position footer");
	assert.match(lines.join("\n"), /navigate/, "key hints");
});

test("the window follows the selection, centre-anchored like /tree", () => {
	const { component } = make(stepRows(20));
	for (let i = 0; i < 12; i++) component.handleInput(DOWN);

	let lines = component.render(120);
	assert.match(lines.join("\n"), /\(13\/20\)/);
	assert.ok(lines.some((line) => line.includes("<accent:13>")), "the selection is visible");
	assert.ok(!lines.some((line) => line.includes("<accent:1>")), "row 1 scrolled out of the window");
	assert.ok(lines.some((line) => line.includes("<accent:15>")), "window shows rows 10–15 around the selection");
	assert.ok(!lines.some((line) => line.includes("<accent:16>")), "rows past the window stay hidden");

	component.handleInput(UP);
	assert.match(component.render(120).join("\n"), /\(12\/20\)/, "one row back up");
});

test("arrow, vim, and page keys move; enter picks the row's pinned start", () => {
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

	component.handleInput(DOWN);
	component.handleInput(ENTER);
	assert.equal(picked.fromStep, 3, "enter hands the row's fromStep to the caller");
});

test("escape cancels without picking anything", () => {
	const { component, picked } = make(stepRows(4));
	component.handleInput(DOWN);
	component.handleInput(ESC);
	assert.equal(picked.cancelled, true);
	assert.equal(picked.fromStep, undefined, "no start is pinned on cancel");
});

test("a folded-region row renders its range bracket in the warning colour", () => {
	const rows: FoldPickerRow[] = [
		{
			kind: "folded",
			fromStep: 2,
			range: [2, 4],
			role: "fold",
			preview: "Venue booked: the hall.",
			estimate: "~12k",
			label: "[2 - 4]  fold: Venue booked: the hall.  ~12k",
		},
		...stepRows(3).map((row) => ({ ...row, fromStep: row.fromStep + 4 })),
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

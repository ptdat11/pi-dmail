/**
 * Tests for the `send_dmail` result renderer.
 *
 * The point of these is the thing the fallback renderer got wrong: the summary
 * must be reachable from the result. Collapsed it appears as a preview plus the
 * key that reveals the rest; expanded it appears whole and indented. Everything
 * here is the plain text, before index.ts colors it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	foldCollapsedText,
	foldExpandedText,
	foldHeadline,
	foldResultText,
	foldSummaryPreview,
} from "../render.ts";

test("headline names the range, and a single step stays singular", () => {
	assert.equal(foldHeadline({ fromStep: 3, throughStep: 8 }), "Folded steps 3–8");
	assert.equal(foldHeadline({ fromStep: 4, throughStep: 4 }), "Folded step 4");
});

test("headline degrades instead of printing NaN", () => {
	assert.equal(foldHeadline({}), "Folded steps");
	assert.equal(foldHeadline({ fromStep: 3 }), "Folded step 3");
	assert.equal(foldHeadline({ fromStep: Number.NaN, throughStep: 8 }), "Folded steps");
});

test("preview takes the first non-blank line", () => {
	assert.equal(foldSummaryPreview("Ran the suite\n8 passed"), "Ran the suite");
	assert.equal(foldSummaryPreview("\n\n  indented first  \nsecond"), "indented first");
});

test("preview truncates with an ellipsis at the limit", () => {
	const preview = foldSummaryPreview("x".repeat(100), 10);
	assert.equal(preview.length, 10);
	assert.equal(preview, `${"x".repeat(9)}…`);
});

test("an empty or blank summary has no preview", () => {
	assert.equal(foldSummaryPreview(""), "");
	assert.equal(foldSummaryPreview("   \n\t\n"), "");
});

test("collapsed line carries the preview and the expand hint", () => {
	assert.equal(
		foldCollapsedText({ fromStep: 3, throughStep: 8 }, "Ran the suite", "ctrl+o to expand"),
		"Folded steps 3–8 — Ran the suite (ctrl+o to expand)",
	);
});

test("collapsed line drops the hint when there is nothing to expand", () => {
	assert.equal(foldCollapsedText({ fromStep: 3, throughStep: 8 }, "  ", "ctrl+o to expand"), "Folded steps 3–8");
});

test("expanded view keeps the whole summary, indented", () => {
	assert.equal(
		foldExpandedText({ fromStep: 3, throughStep: 8 }, "Ran the suite\n8 passed, 0 failed"),
		"Folded steps 3–8\n  Ran the suite\n  8 passed, 0 failed",
	);
});

test("expanded view of a blank summary is just the headline", () => {
	assert.equal(foldExpandedText({ fromStep: 3, throughStep: 8 }, "\n"), "Folded steps 3–8");
});

test("foldResultText switches on the expand state", () => {
	const details = { fromStep: 3, throughStep: 8 };
	assert.equal(
		foldResultText(details, "Ran the suite", "ctrl+o to expand", false),
		"Folded steps 3–8 — Ran the suite (ctrl+o to expand)",
	);
	assert.equal(foldResultText(details, "Ran the suite", "ctrl+o to expand", true), "Folded steps 3–8\n  Ran the suite");
});

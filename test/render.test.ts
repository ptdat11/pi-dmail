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
	foldAdvisoryText,
	foldCollapsedText,
	foldEconomicsLine,
	foldExpandedText,
	foldHeadline,
	foldHeadroomLine,
	foldPredictedActualLine,
	foldResultText,
	foldSkippedLine,
	foldSummaryPreview,
} from "../render.ts";
import { evaluateEconomics } from "../economics.ts";

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

test("skipped line is empty when nothing was skipped", () => {
	assert.equal(foldSkippedLine(undefined), "");
	assert.equal(foldSkippedLine(0), "");
});

test("skipped line names the count", () => {
	assert.equal(foldSkippedLine(2), "folds skipped: 2");
	assert.equal(foldSkippedLine(1), "folds skipped: 1");
});

test("collapsed text appends the skipped line only when N > 0", () => {
	assert.equal(
		foldCollapsedText({ fromStep: 3, throughStep: 8, skipped: 2 }, "Ran the suite", "ctrl+o to expand"),
		"Folded steps 3–8 — Ran the suite (ctrl+o to expand)\nfolds skipped: 2",
	);
	assert.equal(
		foldCollapsedText({ fromStep: 3, throughStep: 8, skipped: 0 }, "Ran the suite", "ctrl+o to expand"),
		"Folded steps 3–8 — Ran the suite (ctrl+o to expand)",
	);
	assert.equal(
		foldCollapsedText({ fromStep: 3, throughStep: 8 }, "Ran the suite", "ctrl+o to expand"),
		"Folded steps 3–8 — Ran the suite (ctrl+o to expand)",
	);
});

test("expanded view appends the skipped line after the summary", () => {
	assert.equal(
		foldExpandedText({ fromStep: 3, throughStep: 8, skipped: 2 }, "Ran the suite\n8 passed"),
		"Folded steps 3–8\n  Ran the suite\n  8 passed\nfolds skipped: 2",
	);
	assert.equal(
		foldExpandedText({ fromStep: 3, throughStep: 8, skipped: 0 }, "Ran the suite"),
		"Folded steps 3–8\n  Ran the suite",
	);
});

test("a skipped count still shows when the summary is blank", () => {
	assert.equal(
		foldCollapsedText({ fromStep: 3, skipped: 1 }, "  ", "ctrl+o to expand"),
		"Folded step 3\nfolds skipped: 1",
	);
	assert.equal(foldExpandedText({ fromStep: 3, skipped: 1 }, "\n"), "Folded step 3\nfolds skipped: 1");
});

test("foldResultText switches on the expand state", () => {
	const details = { fromStep: 3, throughStep: 8 };
	assert.equal(
		foldResultText(details, "Ran the suite", "ctrl+o to expand", false),
		"Folded steps 3–8 — Ran the suite (ctrl+o to expand)",
	);
	assert.equal(foldResultText(details, "Ran the suite", "ctrl+o to expand", true), "Folded steps 3–8\n  Ran the suite");
});

test("foldResultText passes the skipped count through both views", () => {
	const details = { fromStep: 3, throughStep: 8, skipped: 3 };
	assert.equal(
		foldResultText(details, "Ran the suite", "ctrl+o to expand", false),
		"Folded steps 3–8 — Ran the suite (ctrl+o to expand)\nfolds skipped: 3",
	);
	assert.equal(
		foldResultText(details, "Ran the suite", "ctrl+o to expand", true),
		"Folded steps 3–8\n  Ran the suite\nfolds skipped: 3",
	);
});

// --- Advisory economics lines (ticket 04) ---------------------------------
// Every fold result carries estimated tokens removed, the cache verdict, a
// window-headroom warning, and predicted-vs-actual. Strictly advisory: the
// lines render, nothing here can refuse or alter a fold.

test("economics line reports tokens removed, savings, and cache verdict", () => {
	const economics = evaluateEconomics({
		archiveTokens: 50_000,
		memoTokens: 2_000,
		keptAfterTokens: 5_000,
		contextTokens: 60_000,
		contextWindow: 160_000,
	});
	assert.equal(
		foldEconomicsLine({ economics }),
		"~48k tokens removed · saves ~4.8k/req · cache: pays-back (breaks even in 2 requests)",
	);
});

test("economics line reports added tokens when the fold is a cost", () => {
	const economics = evaluateEconomics({
		archiveTokens: 1_000,
		memoTokens: 4_000,
		contextTokens: 20_000,
		contextWindow: 160_000,
	});
	assert.equal(
		foldEconomicsLine({ economics }),
		"~3k tokens added · costs ~300/req · cache: never-pays",
	);
});

test("economics line says why the cache verdict is unknown", () => {
	const economics = evaluateEconomics({ archiveTokens: 30_000, memoTokens: 1_000 });
	assert.equal(
		foldEconomicsLine({ economics }),
		"~29k tokens removed · saves ~2.9k/req · cache: unknown (rebuild unknowable)",
	);
});

test("economics line is empty when the result carries no economics", () => {
	assert.equal(foldEconomicsLine({}), "");
	assert.equal(foldAdvisoryText({ fromStep: 1, throughStep: 2 }), "");
});

test("headroom line warns as context approaches the reserve", () => {
	const near = evaluateEconomics({
		archiveTokens: 10_000,
		memoTokens: 1_000,
		contextTokens: 60_000,
		contextWindow: 80_000,
		reserveTokens: 16_384,
	});
	assert.equal(
		foldHeadroomLine({ economics: near }),
		"window headroom ~20k — within one 16.4k reserve of backstop compaction",
	);

	const inside = evaluateEconomics({
		archiveTokens: 10_000,
		memoTokens: 1_000,
		contextTokens: 65_000,
		contextWindow: 80_000,
		reserveTokens: 16_384,
	});
	assert.equal(
		foldHeadroomLine({ economics: inside }),
		"window headroom ~15k — inside the 16.4k reserve; backstop compaction fires now",
	);

	const calm = evaluateEconomics({
		archiveTokens: 10_000,
		memoTokens: 1_000,
		contextTokens: 20_000,
		contextWindow: 160_000,
	});
	assert.equal(foldHeadroomLine({ economics: calm }), "");
	assert.equal(foldHeadroomLine({}), "");
});

test("predicted-vs-actual line: predicted now, actual awaits scoring", () => {
	const economics = evaluateEconomics({
		archiveTokens: 50_000,
		memoTokens: 2_000,
		keptAfterTokens: 5_000,
		contextTokens: 60_000,
		contextWindow: 160_000,
	});
	assert.equal(
		foldPredictedActualLine({ economics }),
		"predicted: saves ~4.8k/req, breaks even in 2 requests · actual: not yet measured",
	);

	const unknown = evaluateEconomics({ archiveTokens: 30_000, memoTokens: 1_000 });
	assert.equal(
		foldPredictedActualLine({ economics: unknown }),
		"predicted: saves ~2.9k/req · actual: not yet measured",
	);
	assert.equal(foldPredictedActualLine({}), "");
});

test("collapsed text carries the advisory before the skip count", () => {
	const economics = evaluateEconomics({
		archiveTokens: 50_000,
		memoTokens: 2_000,
		keptAfterTokens: 5_000,
		contextTokens: 60_000,
		contextWindow: 160_000,
	});
	assert.equal(
		foldCollapsedText({ fromStep: 3, throughStep: 8, economics, skipped: 2 }, "Ran the suite", "ctrl+o to expand"),
		"Folded steps 3–8 — Ran the suite (ctrl+o to expand)\n" +
			"~48k tokens removed · saves ~4.8k/req · cache: pays-back (breaks even in 2 requests)\n" +
			"folds skipped: 2",
	);
});

test("expanded text carries advisory plus predicted-vs-actual", () => {
	const economics = evaluateEconomics({
		archiveTokens: 50_000,
		memoTokens: 2_000,
		keptAfterTokens: 5_000,
		contextTokens: 60_000,
		contextWindow: 160_000,
	});
	assert.equal(
		foldExpandedText({ fromStep: 3, throughStep: 8, economics }, "Ran the suite\n8 passed"),
		"Folded steps 3–8\n  Ran the suite\n  8 passed\n" +
			"~48k tokens removed · saves ~4.8k/req · cache: pays-back (breaks even in 2 requests)\n" +
			"predicted: saves ~4.8k/req, breaks even in 2 requests · actual: not yet measured",
	);
});

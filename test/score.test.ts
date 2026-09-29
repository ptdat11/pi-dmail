/**
 * Ticket 06: the aggregate scoring seam.
 *
 * `scoreSessions` turns per-fold predicted-vs-measured pairs (from recorded
 * sessions, never a live one) into one decision: retire the OCC gate or keep
 * it. The bar is fixed at 90% of predicted — measured savings may not fall
 * more than 10% short of what the advisory promised. No scored folds means
 * insufficient evidence, which keeps the gate.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CACHE_RATIO, cacheRatioOf } from "../economics.ts";
import { RETIRE_BAR, renderScore, scoreSessions, type FoldProfile, type ScoreInput } from "../profile.ts";

function predicted(savingsPerRequestTokens: number) {
	return { removedTokens: savingsPerRequestTokens, savingsPerRequestTokens, rebuildTokens: null, breakEvenRequests: null };
}

function actual(savingsPerRequestTokens: number) {
	return { measuredAt: "2026-01-01T00:00:07.000Z", removedTokens: savingsPerRequestTokens, savingsPerRequestTokens };
}

/**
 * Minimal profile for aggregation: `scoreSessions` reads only sessionFile +
 * folds (`ScoreInput`), so the fixture carries exactly those. The omitted
 * fields were never read, so dropping `requests: []` cannot change what any
 * assertion observes.
 */
function fakeProfile(sessionFile: string, folds: Array<Partial<FoldProfile>>): ScoreInput {
	return {
		sessionFile,
		folds: folds.map(
			(fold): FoldProfile => ({
				recordId: "f1",
				fromStep: 1,
				fromEntryId: "a1",
				toEntryId: "a2",
				summaryChars: 15,
				effectiveAtRequest: 2,
				predicted: null,
				actual: null,
				measuredRequests: 0,
				...fold,
			}),
		),
	};
}

test("score: measured savings at the 90% bar retire the gate", () => {
	const report = scoreSessions([
		fakeProfile("s1.jsonl", [{ predicted: predicted(100), actual: actual(90), measuredRequests: 2 }]),
	]);

	assert.equal(RETIRE_BAR, 0.9);
	assert.equal(report.sessions, 1);
	assert.equal(report.predictedFolds, 1);
	assert.equal(report.scoredFolds, 1);
	assert.equal(report.comparedFolds, 1);
	// Weighted by the requests each fold was measured over: 100×2 vs 90×2.
	assert.equal(report.predictedSavings, 200);
	assert.equal(report.measuredSavings, 180);
	assert.ok(Math.abs((report.accuracy ?? 0) - 0.9) < 1e-9, `accuracy ${report.accuracy}`);
	assert.equal(report.verdict, "retire");

	const text = renderScore(report);
	assert.match(text, /RETIRE the OCC gate/);
	assert.match(text, /90\.0%/);
});

test("score: savings below the bar keep the gate", () => {
	const report = scoreSessions([
		fakeProfile("s1.jsonl", [{ predicted: predicted(100), actual: actual(89), measuredRequests: 1 }]),
	]);

	assert.equal(report.verdict, "keep");
	assert.ok((report.accuracy ?? 1) < RETIRE_BAR, `accuracy ${report.accuracy}`);
	assert.match(renderScore(report), /KEEP the OCC gate/);
});

test("score: no scored folds keeps the gate as insufficient evidence", () => {
	const noPredictions = scoreSessions([fakeProfile("s1.jsonl", [{}])]);
	assert.equal(noPredictions.predictedFolds, 0);
	assert.equal(noPredictions.scoredFolds, 0);
	assert.equal(noPredictions.verdict, "keep");
	assert.equal(noPredictions.accuracy, null);
	assert.match(renderScore(noPredictions), /KEEP the OCC gate/);
	assert.match(renderScore(noPredictions), /insufficient evidence/);

	// Predictions exist but nothing was ever measured (fold never rendered).
	const neverMeasured = scoreSessions([
		fakeProfile("s1.jsonl", [{ predicted: predicted(100), actual: null, measuredRequests: 0 }]),
	]);
	assert.equal(neverMeasured.predictedFolds, 1);
	assert.equal(neverMeasured.scoredFolds, 0);
	assert.equal(neverMeasured.verdict, "keep");
	assert.match(renderScore(neverMeasured), /insufficient evidence/);
});

test("score: aggregates across sessions with each fold weighted by measured requests", () => {
	const report = scoreSessions([
		fakeProfile("s1.jsonl", [{ predicted: predicted(20), actual: actual(20), measuredRequests: 1 }]),
		fakeProfile("s2.jsonl", [{ predicted: predicted(100), actual: actual(50), measuredRequests: 2 }]),
	]);

	assert.equal(report.sessions, 2);
	assert.equal(report.predictedSavings, 20 + 200);
	assert.equal(report.measuredSavings, 20 + 100);
	assert.ok(Math.abs((report.accuracy ?? 0) - 120 / 220) < 1e-9, `accuracy ${report.accuracy}`);
	assert.equal(report.verdict, "keep");
});

test("score: the report lists per-fold rows and the scored/unscored split", () => {
	const report = scoreSessions([
		fakeProfile("s1.jsonl", [
			{ recordId: "fold-a", predicted: predicted(10), actual: actual(10), measuredRequests: 3 },
			{ recordId: "fold-b", predicted: predicted(10), actual: null, measuredRequests: 0 },
		]),
	]);

	const text = renderScore(report);
	assert.match(text, /fold-a/);
	assert.match(text, /fold-b/);
	assert.match(text, /scored 1 of 2 predicted folds \(1 unscored\)/);
	assert.match(text, /s1\.jsonl/);
});

test("score: cacheRatioOf inverts the prediction's own pricing", () => {
	// The model's `savings = removed × cacheRatio`, inverted per prediction, so
	// the measured side is always priced on exactly the predicted basis — a
	// session's real cache prices can never move accuracy across the bar.
	assert.equal(cacheRatioOf({ removedTokens: 2000, savingsPerRequestTokens: 200 }), 0.1);
	assert.equal(cacheRatioOf({ removedTokens: 2000, savingsPerRequestTokens: 20 }), 0.01);
	assert.equal(cacheRatioOf({ removedTokens: -100, savingsPerRequestTokens: -10 }), 0.1);
	// Degenerate or corrupt predictions fall back to the module default.
	assert.equal(cacheRatioOf({ removedTokens: 0, savingsPerRequestTokens: 0 }), DEFAULT_CACHE_RATIO);
	assert.equal(cacheRatioOf({ removedTokens: 2000, savingsPerRequestTokens: -5 }), DEFAULT_CACHE_RATIO);
});

test("score: a predicted cost fold is measured but never compared", () => {
	const report = scoreSessions([
		fakeProfile("s1.jsonl", [{ predicted: predicted(-100), actual: actual(-9), measuredRequests: 2 }]),
	]);

	// The advisory expected a cost fold and the measurement found one — but a
	// non-positive prediction has no promise to hold against, so it stays out
	// of the ratio and the report says so instead of hiding it.
	assert.equal(report.scoredFolds, 1);
	assert.equal(report.comparedFolds, 0);
	assert.equal(report.accuracy, null);
	assert.equal(report.verdict, "keep");
	assert.match(renderScore(report), /insufficient evidence: no positive/);
	assert.match(renderScore(report), /totals \(0 compared\)/);
});

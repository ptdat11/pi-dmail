// Advisory economics: pure module. Hand-built synthetic inputs (archive tokens,
// memo tokens, kept-suffix tokens, cache price ratio, window headroom) → verdict
// + estimated savings. Every number here is hand-checkable; nothing in this file
// may touch pi. Strictly advisory: no input combination may throw.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFAULT_CACHE_RATIO,
	DEFAULT_RESERVE_TOKENS,
	FAST_PAYBACK_REQUESTS,
	type Economics,
	evaluateEconomics,
} from "../economics.ts";

test("an unknowable kept-suffix degrades the cache verdict instead of assuming an empty one", () => {
	// A cut that runs to the newest step in view (ticket 13): what follows it is the round
	// that will write the fold, which is not in this view. `keptAfterTokens: null` says
	// that; pricing it as zero would promise a rebuild of the memo alone and a fast
	// break-even the fold will not actually have.
	const e = evaluateEconomics({
		archiveTokens: 50_000,
		memoTokens: 2_000,
		keptAfterTokens: null,
		contextTokens: 60_000,
		contextWindow: 160_000,
		reserveTokens: 16_384,
	});

	assert.equal(e.removedTokens, 48_000, "the archive is still measured");
	assert.equal(e.estimatedSavingsTokens, 4_800, "so is the saving it buys per request");
	assert.equal(e.rebuildTokens, null, "the rebuild cannot be priced from this view");
	assert.equal(e.breakEvenRequests, null, "and so break-even has no number to report");
	assert.equal(e.cacheVerdict, "unknown", "the verdict says unknown instead of guessing");
	// Nothing is gated on it: the fold proceeds and the advisory still rides along.
	assert.equal(e.verdict, "savings");
});

test("savings verdict: archive far larger than memo, rebuild pays back fast", () => {
	const e = evaluateEconomics({
		archiveTokens: 50_000,
		memoTokens: 2_000,
		keptAfterTokens: 5_000,
		contextTokens: 60_000,
		contextWindow: 160_000,
		reserveTokens: 16_384,
	});

	// removed = 50_000 − 2_000 = 48_000; savings/request = 48_000 × 0.1 = 4_800.
	assert.equal(e.verdict, "savings");
	assert.equal(e.removedTokens, 48_000);
	assert.equal(e.estimatedSavingsTokens, 4_800);
	// rebuild = memo 2_000 + kept-after 5_000 = 7_000 rewritten fresh once; the
	// surviving prefix stays prefix-cache resident, so window usage is excluded.
	assert.equal(e.rebuildTokens, 7_000);
	// break-even = ceil(7_000 / 4_800) = 2 requests.
	assert.equal(e.breakEvenRequests, 2);
	assert.equal(e.cacheVerdict, "pays-back");
	assert.equal(e.headroom.headroomTokens, 100_000);
	assert.equal(e.headroom.nearReserve, false);
	assert.equal(e.headroom.insideReserve, false);
	// Predicted-vs-actual: predicted is populated, actual awaits scoring (ticket 06).
	assert.deepEqual(e.predicted, {
		removedTokens: 48_000,
		savingsPerRequestTokens: 4_800,
		rebuildTokens: 7_000,
		breakEvenRequests: 2,
	});
	assert.equal(e.actual, null);
});

test("break-even verdict: archive equals memo", () => {
	const e = evaluateEconomics({
		archiveTokens: 5_000,
		memoTokens: 5_000,
		contextTokens: 20_000,
		contextWindow: 160_000,
	});

	assert.equal(e.verdict, "break-even");
	assert.equal(e.removedTokens, 0);
	assert.equal(e.estimatedSavingsTokens, 0);
	// Nothing removed → no per-request savings → the cache never pays back.
	assert.equal(e.cacheVerdict, "never-pays");
	assert.equal(e.breakEvenRequests, null);
});

test("cost verdict: memo exceeds the archive (fold adds tokens)", () => {
	const e = evaluateEconomics({
		archiveTokens: 1_000,
		memoTokens: 4_000,
		contextTokens: 20_000,
		contextWindow: 160_000,
	});

	// removed = 1_000 − 4_000 = −3_000; savings = −3_000 × 0.1 = −300 (a cost).
	assert.equal(e.verdict, "cost");
	assert.equal(e.removedTokens, -3_000);
	assert.equal(e.estimatedSavingsTokens, -300);
	assert.equal(e.cacheVerdict, "never-pays");
});

test("slow-pays-back: small delta, fat memo amortises over many requests", () => {
	const e = evaluateEconomics({
		archiveTokens: 25_000,
		memoTokens: 20_000,
		keptAfterTokens: 5_000,
		contextTokens: 100_000,
		contextWindow: 160_000,
	});

	// savings = 5_000 × 0.1 = 500; rebuild = 20_000 + 5_000 = 25_000.
	assert.equal(e.estimatedSavingsTokens, 500);
	assert.equal(e.rebuildTokens, 25_000);
	assert.equal(e.breakEvenRequests, 50);
	assert.equal(e.cacheVerdict, "slow-pays-back");
	assert.ok(50 > FAST_PAYBACK_REQUESTS, "payback is beyond the fast threshold");
});

test("rebuild is memo + kept suffix, independent of window usage", () => {
	// Same fold, wildly different windows: the rebuild number must not move —
	// the surviving prefix stays prefix-cache resident either way.
	const small = evaluateEconomics({
		archiveTokens: 10_000,
		memoTokens: 1_000,
		keptAfterTokens: 4_000,
		contextTokens: 50_000,
		contextWindow: 80_000,
	});
	const huge = evaluateEconomics({
		archiveTokens: 10_000,
		memoTokens: 1_000,
		keptAfterTokens: 4_000,
		contextTokens: 500_000,
		contextWindow: 1_000_000,
	});
	// rebuild = 1_000 + 4_000 = 5_000; savings = 9_000 × 0.1 = 900 → ceil = 6.
	assert.equal(small.rebuildTokens, 5_000);
	assert.equal(small.breakEvenRequests, 6);
	assert.equal(huge.rebuildTokens, small.rebuildTokens);
	assert.equal(huge.breakEvenRequests, small.breakEvenRequests);
	// …while headroom still tracks the window: 30k ≤ 2 × 16_384 near, 500k calm.
	assert.equal(small.headroom.nearReserve, true);
	assert.equal(huge.headroom.nearReserve, false);
});

test("fast payback boundary: exactly FAST_PAYBACK_REQUESTS still pays back", () => {
	// removed = 10_000 → savings 1_000; rebuild = 5_000 + 5_000 = 10_000.
	// Deliberately usage-free: payback depends on the fold's own tokens, not on
	// how full the window is.
	const e = evaluateEconomics({
		archiveTokens: 15_000,
		memoTokens: 5_000,
		keptAfterTokens: 5_000,
	});
	assert.equal(e.breakEvenRequests, FAST_PAYBACK_REQUESTS);
	assert.equal(e.cacheVerdict, "pays-back");

	// One request further out flips to slow.
	const slow = evaluateEconomics({
		archiveTokens: 15_000,
		memoTokens: 5_000,
		keptAfterTokens: 6_000,
	});
	assert.equal(slow.breakEvenRequests, 11);
	assert.equal(slow.cacheVerdict, "slow-pays-back");
});

test("unknown cache verdict when the kept suffix is unavailable", () => {
	const e = evaluateEconomics({
		archiveTokens: 30_000,
		memoTokens: 1_000,
	});

	assert.equal(e.verdict, "savings");
	assert.equal(e.estimatedSavingsTokens, 2_900);
	// Without a kept-suffix measurement the one-time rewrite is unknowable…
	assert.equal(e.rebuildTokens, null);
	assert.equal(e.breakEvenRequests, null);
	assert.equal(e.cacheVerdict, "unknown");
	// …and headroom is unknown too (no usage): no warning, never a refusal.
	assert.equal(e.headroom.contextTokens, null);
	assert.equal(e.headroom.headroomTokens, null);
	assert.equal(e.headroom.nearReserve, false);
	assert.equal(e.headroom.insideReserve, false);
});

test("headroom: warning state as context approaches the reserve", () => {
	// window 80_000, reserve 16_384 → compaction line at 63_616 tokens.
	// 60_000 used → 20_000 headroom ≤ 2 × reserve: near, not inside.
	const near = evaluateEconomics({
		archiveTokens: 10_000,
		memoTokens: 1_000,
		contextTokens: 60_000,
		contextWindow: 80_000,
		reserveTokens: 16_384,
	});
	assert.equal(near.headroom.headroomTokens, 20_000);
	assert.equal(near.headroom.nearReserve, true);
	assert.equal(near.headroom.insideReserve, false);

	// 65_000 used → 15_000 headroom < reserve: past the compaction line.
	const inside = evaluateEconomics({
		archiveTokens: 10_000,
		memoTokens: 1_000,
		contextTokens: 65_000,
		contextWindow: 80_000,
		reserveTokens: 16_384,
	});
	assert.equal(inside.headroom.headroomTokens, 15_000);
	assert.equal(inside.headroom.nearReserve, true);
	assert.equal(inside.headroom.insideReserve, true);

	// Plentiful headroom: no warning state at all.
	const calm = evaluateEconomics({
		archiveTokens: 10_000,
		memoTokens: 1_000,
		contextTokens: 20_000,
		contextWindow: 160_000,
		reserveTokens: 16_384,
	});
	assert.equal(calm.headroom.headroomTokens, 140_000);
	assert.equal(calm.headroom.nearReserve, false);
	assert.equal(calm.headroom.insideReserve, false);
});

test("defaults: cache price ratio 0.1 and Pi's 16_384 reserve", () => {
	const e = evaluateEconomics({ archiveTokens: 10_000, memoTokens: 0 });

	assert.equal(DEFAULT_CACHE_RATIO, 0.1);
	assert.equal(DEFAULT_RESERVE_TOKENS, 16_384);
	assert.equal(e.estimatedSavingsTokens, 1_000);
	assert.equal(e.headroom.reserveTokens, 16_384);
	assert.equal(e.headroom.contextWindow, null);
});

test("degenerate inputs never throw — economics is advisory only", () => {
	const cases: Array<Parameters<typeof evaluateEconomics>[0]> = [
		{ archiveTokens: 0, memoTokens: 0 },
		{ archiveTokens: -5, memoTokens: -10 },
		{ archiveTokens: Number.NaN, memoTokens: 100 },
		{ archiveTokens: 100, memoTokens: Number.NaN },
		{ archiveTokens: Number.POSITIVE_INFINITY, memoTokens: 10 },
	];
	for (const input of cases) {
		const e: Economics = evaluateEconomics(input);
		assert.ok(e.verdict, "verdict always present");
		assert.equal(e.actual, null);
	}
});

// Extension-boundary seam for advisory economics (ticket 04): drive the real
// tool through the harness and assert our side of the contract. Every fold
// succeeds and carries its advisory — estimated tokens removed, cache verdict,
// window-headroom warning, predicted-vs-actual — and no fold is ever refused,
// delayed, or altered on economic grounds.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertFoldDetails, createHarness, threeStepSession } from "./harness/index.ts";
import { DEFAULT_RESERVE_TOKENS } from "../economics.ts";

test("the reserve we warn on is Pi's own compaction reserve", async () => {
	// The harness installs the resolve hooks that map pi's package specifier to
	// its global install, so this dynamic import lands on the real dist build.
	await createHarness();
	const pi = (await import("@earendil-works/pi-coding-agent")) as {
		DEFAULT_COMPACTION_SETTINGS: { reserveTokens: number };
	};
	assert.equal(DEFAULT_RESERVE_TOKENS, pi.DEFAULT_COMPACTION_SETTINGS.reserveTokens);
});

test("fold result carries estimated tokens removed and the cache verdict", async () => {
	const h = await createHarness({ fixture: threeStepSession() });
	await h.start();
	(h.ctx as { getContextUsage?: unknown }).getContextUsage = () => ({
		tokens: 60_000,
		contextWindow: 160_000,
		percent: 37.5,
	});

	const summary = "Opening exchange";
	const result = await h.execute({ fromStep: 1, summary });
	const details = assertFoldDetails(result, { fromStep: 1, throughStep: 5, fromEntryId: "e1", toEntryId: "e6" });

	assert.equal(h.pi.appended.length, 1, "the fold happened");
	assert.ok(details.economics.removedTokens > 0, "archive is larger than the memo");
	assert.equal(typeof details.economics.cacheVerdict, "string", "cache verdict present");

	// Raw fallback content names the economics without any render hook.
	assert.match(result.content[0].text, /^Folded steps 1 through 5\./);
	assert.match(result.content[0].text, /tokens removed/);
	assert.match(result.content[0].text, /cache: /);

	// The collapsed render shows the advisory too.
	const collapsed = h.render(result, { args: { fromStep: 1, summary } }).text();
	assert.match(collapsed, /tokens removed/);
	assert.match(collapsed, /cache: /);
});

test("window headroom warns as context approaches the reserve — and never blocks", async () => {
	// Near the line: 60k of an 80k window → 20k headroom, one reserve away.
	const near = await createHarness({ fixture: threeStepSession() });
	await near.start();
	(near.ctx as { getContextUsage?: unknown }).getContextUsage = () => ({
		tokens: 60_000,
		contextWindow: 80_000,
		percent: 75,
	});
	const nearResult = await near.execute({ fromStep: 1, summary: "Opening exchange" });
	assert.equal(near.pi.appended.length, 1, "fold still succeeds");
	const nearDetails = assertFoldDetails(nearResult, { fromStep: 1, throughStep: 5, fromEntryId: "e1", toEntryId: "e6" });
	assert.equal(nearDetails.economics.headroom.nearReserve, true);
	assert.match(nearResult.content[0].text, /window headroom ~20k — within one 16\.4k reserve/);

	// Past the line: 65k of 80k → inside Pi's reserve, backstop would fire now.
	const inside = await createHarness({ fixture: threeStepSession() });
	await inside.start();
	(inside.ctx as { getContextUsage?: unknown }).getContextUsage = () => ({
		tokens: 65_000,
		contextWindow: 80_000,
		percent: 81.25,
	});
	const insideResult = await inside.execute({ fromStep: 1, summary: "Opening exchange" });
	assert.equal(inside.pi.appended.length, 1, "fold still succeeds inside the reserve");
	const insideDetails = assertFoldDetails(insideResult, { fromStep: 1, throughStep: 5, fromEntryId: "e1", toEntryId: "e6" });
	assert.equal(insideDetails.economics.headroom.insideReserve, true);
	assert.match(insideResult.content[0].text, /window headroom ~15k — inside the 16\.4k reserve/);
});

test("a throwing usage probe degrades the advisory, never the fold", async () => {
	const h = await createHarness({ fixture: threeStepSession() });
	await h.start();
	(h.ctx as { getContextUsage?: unknown }).getContextUsage = () => {
		throw new Error("usage unavailable");
	};

	const result = await h.execute({ fromStep: 1, summary: "Opening exchange" });
	const details = assertFoldDetails(result, { fromStep: 1, throughStep: 5, fromEntryId: "e1", toEntryId: "e6" });

	assert.equal(h.pi.appended.length, 1, "the fold happened anyway");
	assert.equal(details.economics.headroom.contextTokens, null, "headroom unknown, not fatal");
	// The cache verdict needs no usage — only the fold's own tokens — so it stays real.
	assert.notEqual(details.economics.cacheVerdict, "unknown", "verdict computed without usage");
	assert.match(result.content[0].text, /cache: (pays-back|slow-pays-back|never-pays)/);
	assert.doesNotMatch(result.content[0].text, /window headroom/);
});

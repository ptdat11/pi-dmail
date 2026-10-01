/**
 * Re-fold acceptance tests, driven through the harness like pi would.
 *
 * `test/fold.test.ts` proves the algebra; these prove the wiring: that a re-fold
 * starting inside an already-folded region is accepted, that stacked re-folds
 * render with the original step markers, that `/dmail off` hands the full raw
 * transcript back, and that folding with nothing finished fails loudly instead
 * of appending an empty fold.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertFoldDetails, createHarness, SessionFixture } from "./harness/index.ts";
import { FOLD_TYPE } from "../fold.ts";

/** Plain text of one context message, whatever shape pi's message uses. */
function messageText(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map((part: any) => (typeof part === "string" ? part : (part?.text ?? JSON.stringify(part)))).join("");
	}
	return JSON.stringify(content ?? "");
}

/** Dispatch the context hook once and hand back its raw result (undefined = declined). */
async function dispatchContext(h: Awaited<ReturnType<typeof createHarness>>): Promise<unknown> {
	const [result] = await h.dispatch("context", { type: "context" }, h.ctx);
	return result;
}

/** The hook's rendered messages; empty when the hook declines (pi renders raw). */
async function contextMessages(h: Awaited<ReturnType<typeof createHarness>>): Promise<string[]> {
	const result = await dispatchContext(h);
	const messages = (result as { messages?: unknown[] } | undefined)?.messages;
	return (messages ?? []).map(messageText);
}

function summaryCount(messages: readonly string[]): number {
	return messages.reduce((n, text) => n + (text.match(/<summary>/g)?.length ?? 0), 0);
}

test("a re-fold from a start inside an existing fold region is refused, naming the marker that absorbs it", async () => {
	const h = await createHarness();
	await h.start();

	const first = await h.execute({ fromStep: 1, summary: "S1 covers the first two exchanges" });
	assertFoldDetails(first, { fromStep: 1, throughStep: 5, fromEntryId: "e1", toEntryId: "e6" });

	// Step 2's answer is already folded away. Starting there would leave S1 standing
	// beside a second summary covering the same transcript, so the fold refuses and
	// points at step 1 — the marker of the summary to absorb.
	await assert.rejects(
		h.execute({ fromStep: 2, summary: "S2 covers step 2" }),
		/inside a fold that already covers steps 1 – 5\. Fold from step 1 instead/,
	);
	assert.deepEqual(
		h.pi.appended.map((entry) => entry.customType),
		[FOLD_TYPE],
		"a refused fold appends nothing",
	);

	// Climbing to that marker folds: the new summary replaces S1 instead of stacking on it.
	const climbed = await h.execute({ fromStep: 1, throughStep: 5, summary: "S1 and S2 together" });
	assertFoldDetails(climbed, { fromStep: 1, throughStep: 5, fromEntryId: "e1", toEntryId: "e6" });
	const messages = await contextMessages(h);
	assert.equal(summaryCount(messages), 1, "the older memo is replaced, not left beside the new one");
	assert.ok(messages.some((text) => text.includes("S1 and S2 together")));
	assert.ok(!messages.some((text) => text.includes("S1 covers the first two exchanges")), "the absorbed memo is gone from the view");

	// The surviving step keeps its branch number; folding never renumbers it.
	const lastKept = messages.findIndex((text) => text.includes("third answer"));
	assert.ok(lastKept > 0, "the step you are in is still rendered");
	assert.match(messages[lastKept - 1], /^\[step 6\]$/);
});

test("stacked re-folds render each surviving summary with its original step marker", async () => {
	const h = await createHarness();
	await h.start();
	await h.execute({ fromStep: 1, summary: "S1 covers step 1" });
	await h.execute({ fromStep: 1, summary: "S1 covers step 1, tightened" });

	// Same-start re-folds: newest wins at that start, and the step's own marker is
	// unchanged, because numbers never renumber.
	const messages = await contextMessages(h);
	assert.equal(summaryCount(messages), 1);

	const summaryAt = messages.findIndex((text) => text.includes("S1 covers step 1, tightened"));
	assert.ok(summaryAt > 0, "the newest summary renders");
	assert.match(messages[summaryAt - 1], /^\[step 1\]$/, "the summary keeps the step it starts at");

	// The surviving step keeps its branch number; folding never renumbers it.
	const lastKept = messages.findIndex((text) => text.includes("third answer"));
	assert.ok(lastKept > 0, "the step you are in is still rendered");
	assert.match(messages[lastKept - 1], /^\[step 6\]$/);
});

test("a same-start re-fold replaces the older summary, not stacks it", async () => {
	const h = await createHarness();
	await h.start();
	await h.execute({ fromStep: 1, summary: "first attempt" });
	await h.execute({ fromStep: 1, summary: "better summary" });

	const messages = await contextMessages(h);
	assert.equal(summaryCount(messages), 1, "exactly one summary after replacing at the same start");
	const summaryIndex = messages.findIndex((text) => text.includes("<summary>"));
	assert.ok(summaryIndex > 0, "a summary rendered");
	assert.match(messages[summaryIndex], /better summary/);
	assert.doesNotMatch(messages[summaryIndex], /first attempt/);
	assert.match(messages[summaryIndex - 1], /^\[step 1\]$/, "marker is the fold's original step");
});

test("/dmail off hands back the full raw transcript after stacked re-folds", async () => {
	const h = await createHarness();
	await h.start();
	await h.execute({ fromStep: 1, summary: "S1 covers the first two exchanges" });
	await h.execute({ fromStep: 1, summary: "S1 covers the first two exchanges, tightened" });

	const folded = await contextMessages(h);
	assert.equal(summaryCount(folded), 1);
	assert.ok(!folded.some((text) => text.includes("first answer")), "folded material is out of the view");

	// Nothing was deleted: the original six entries still sit, in order, untouched.
	assert.deepEqual(
		h.fixture.entries.slice(0, 6).map((entry) => entry.id),
		["e1", "e2", "e3", "e4", "e5", "e6"],
		"the original transcript is untouched",
	);

	await h.runCommand("dmail", "off");
	assert.equal(await dispatchContext(h), undefined, "disabled: the hook declines, pi renders raw");
	// The raw material pi falls back to is still there: only records were appended.
	const rawIds = h.ctx.sessionManager.buildContextEntries().map((entry: any) => entry.id);
	assert.ok(rawIds.includes("e2") && rawIds.includes("e4") && rawIds.includes("e6"), "raw steps still in view");

	await h.runCommand("dmail", "on");
	const restored = await contextMessages(h);
	assert.equal(summaryCount(restored), 1, "re-enabling replays the records");
	assert.ok(!restored.some((text) => text.includes("first answer")), "folded steps stay folded while enabled");

	// A third stacked re-fold (same start again) toggles just as cleanly.
	await h.execute({ fromStep: 1, summary: "S1 covers the first two exchanges, twice over" });
	const stacked = await contextMessages(h);
	assert.equal(summaryCount(stacked), 1, "each re-fold replaced the summary at that start");
	assert.ok(stacked.some((text) => text.includes("twice over")));
	assert.ok(!stacked.some((text) => text.includes("tightened")));

	await h.runCommand("dmail", "off");
	assert.equal(await dispatchContext(h), undefined, "raw again after three stacked folds");
	await h.runCommand("dmail", "on");
	assert.equal(summaryCount(await contextMessages(h)), 1, "and back again");
});

test("folding with nothing finished fails clearly instead of appending an empty fold", async () => {
	const fixture = new SessionFixture();
	fixture.user("only question");
	fixture.assistant("only answer");
	const h = await createHarness({ fixture });
	await h.start();

	// Step 1 is the question and step 2 the answer being written; step 2 is the one
	// you are in, so it is the one nothing may be cut at.
	await assert.rejects(
		h.execute({ fromStep: 2, summary: "fold myself" }),
		/Step 2 is the step you are in, so there is nothing finished to fold yet/,
	);
	assert.equal(h.pi.appended.length, 0, "no record was appended");

	// The view is unchanged: markers, no summaries.
	const messages = await contextMessages(h);
	assert.equal(summaryCount(messages), 0);
	assert.ok(messages.some((text) => text === "[step 1]"), "the question's own marker still renders");
	assert.ok(messages.some((text) => text === "[step 2]"), "and the answer's");
});

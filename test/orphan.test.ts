/**
 * Orphan-visibility acceptance tests, driven through the harness like pi would.
 *
 * A fold record sitting on the far side of the last compaction boundary is
 * invisible to replay — its steps are gone from the view — but today it is
 * dropped silently, so the tool result pretends the fold universe is complete.
 * These prove the ticket: such a record is never replayed, is counted, and the
 * count shows up everywhere the fold result is drawn. Records themselves are
 * never touched.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CustomEntry } from "@earendil-works/pi-coding-agent";
import { assertFoldDetails, createHarness, SessionFixture, threeStepSession } from "./harness/index.ts";
import { FOLD_TYPE } from "../fold.ts";

/** Plain text of one context message, whatever shape pi's message uses. */
function messageText(message: unknown): string {
	if (typeof message === "string") return message;
	if (message === null || typeof message !== "object") return JSON.stringify(message);
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (typeof part === "string") return part;
				if (part !== null && typeof part === "object" && "text" in part) {
					const text = (part as { text?: unknown }).text;
					if (text !== undefined) return String(text);
				}
				return JSON.stringify(part);
			})
			.join("");
	}
	return JSON.stringify(content ?? "");
}

/** The hook's rendered messages; empty when the hook declines (pi renders raw). */
async function contextMessages(h: Awaited<ReturnType<typeof createHarness>>): Promise<string[]> {
	const [result] = await h.dispatch("context", { type: "context" }, h.ctx);
	const messages = (result as { messages?: unknown[] } | undefined)?.messages;
	return (messages ?? []).map(messageText);
}

/**
 * Session shaped like a real orphan: a fold record written early, then two more
 * steps, then a compaction whose boundary drops the record's holder (and its
 * endpoints) out of the view.
 */
function orphanSession(): SessionFixture {
	const fx = threeStepSession(); // e1..e6, steps 1–3
	fx.foldRecord({ fromEntryId: "e2", toEntryId: "e6", summary: "orphan summary", fromStep: 1 }); // e7
	fx.user("fourth question"); // e8
	fx.assistant("fourth answer"); // e9, step 4
	fx.user("fifth question"); // e10
	fx.assistant("fifth answer"); // e11, step 5
	fx.compaction({ summary: "earlier work", firstKeptEntryId: "e8" }); // e12
	return fx;
}

test("a pre-boundary fold record is skipped by replay, counted, and the count is rendered", async () => {
	const fixture = orphanSession();
	const h = await createHarness({ fixture });
	await h.start();

	// The tool still works for the visible steps, and reports the orphan.
	const result = await h.execute({ fromStep: 4, summary: "step 4 only" });
	assertFoldDetails(result, {
		fromStep: 4,
		throughStep: 4,
		fromEntryId: "e9",
		toEntryId: "e11",
		skipped: 1,
	});
	assert.match(result.content[0].text, /folds skipped: 1/, "raw content fallback carries the count");

	// Both drawn views carry it too.
	const collapsed = h.render(result, { args: { summary: "step 4 only" } }).text();
	assert.match(collapsed, /folds skipped: 1/, "collapsed view carries the count");
	const expanded = h.render(result, { args: { summary: "step 4 only" }, expanded: true }).text();
	assert.match(expanded, /folds skipped: 1/, "expanded view carries the count");

	// Replay: the in-view fold applies, the orphan's summary never appears.
	const messages = await contextMessages(h);
	assert.ok(messages.some((text) => text.includes("step 4 only")), "the new fold replayed");
	assert.ok(!messages.some((text) => text.includes("orphan summary")), "the orphan never replayed");

	// Determinism: replaying the same session again renders identically, count included.
	assert.deepEqual(await contextMessages(h), messages, "a second replay yields identical output");

	// Nothing was modified or removed: the orphan record is still on disk, byte-identical.
	// find() narrows only with an explicit predicate: `CustomEntry` is the union
	// member that carries `data`.
	const orphan = fixture.entries.find(
		(entry): entry is CustomEntry => entry.type === "custom" && entry.customType === FOLD_TYPE,
	);
	assert.deepEqual(orphan?.data, {
		fromEntryId: "e2",
		toEntryId: "e6",
		summary: "orphan summary",
		fromStep: 1,
	});
});

test("an orphan whose endpoints are still in view is still never replayed", async () => {
	const fx = threeStepSession(); // e1..e6
	// Holder written early, pointing forward at steps that survive the boundary:
	// without the era check this would validate and replay.
	fx.foldRecord({ fromEntryId: "e9", toEntryId: "e11", summary: "forward orphan", fromStep: 4 }); // e7
	fx.user("fourth question"); // e8
	fx.assistant("fourth answer"); // e9, step 4
	fx.user("fifth question"); // e10
	fx.assistant("fifth answer"); // e11, step 5
	fx.compaction({ summary: "earlier work", firstKeptEntryId: "e9" }); // e12 — view starts after the holder

	const h = await createHarness({ fixture: fx });
	await h.start();

	const messages = await contextMessages(h);
	assert.ok(!messages.some((text) => text.includes("forward orphan")), "holder out of era: never replayed");

	const result = await h.execute({ fromStep: 4, summary: "step 4 only" });
	assert.equal(result.details.skipped, 1, "counted anyway");
	assert.match(result.content[0].text, /folds skipped: 1/);
});

test("without a boundary nothing is skipped: no count in content or drawn views", async () => {
	const h = await createHarness();
	await h.start();

	const result = await h.execute({ fromStep: 1, summary: "steps 1-2" });
	assert.equal(result.details.skipped, undefined, "no skipped key when nothing was skipped");
	assert.ok(!result.content[0].text.includes("folds skipped"), "content stays clean");
	assert.ok(!h.render(result, { args: { summary: "steps 1-2" } }).text().includes("folds skipped"));
	assert.ok(
		!h.render(result, { args: { summary: "steps 1-2" }, expanded: true }).text().includes("folds skipped"),
	);
});

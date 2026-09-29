/**
 * Preview-mode acceptance tests (ticket 05), driven through the harness like
 * pi would: estimates without commitment.
 *
 * The `preview` flag reports exactly what a real fold over the same inputs
 * would — same validation, same numbers — while appending nothing and leaving
 * the view untouched. `/dmail price` prints those estimates on demand, folds
 * nothing, and never involves the agent.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertFoldDetails, createHarness, SessionFixture, threeStepSession } from "./harness/index.ts";
import { foldEconomicsLine } from "../render.ts";

const SUMMARY = "Opening exchange";

type Harness = Awaited<ReturnType<typeof createHarness>>;

/** Give the advisory a usage probe so headroom is a real number. */
function stubUsage(h: Harness): void {
	(h.ctx as { getContextUsage?: unknown }).getContextUsage = () => ({
		tokens: 60_000,
		contextWindow: 160_000,
		percent: 37.5,
	});
}

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

/** The hook's rendered view; empty when the hook declines (no fold applied). */
async function contextMessages(h: Harness): Promise<string[]> {
	const [result] = await h.dispatch("context", { type: "context" }, h.ctx);
	const messages = (result as { messages?: unknown[] } | undefined)?.messages;
	return (messages ?? []).map(messageText);
}

/** The error a promise rejected with, or "" when it resolved. */
async function errorOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		return "";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/** The one line `/dmail price` reports for a cut. */
function lastNotification(h: Harness): string {
	const note = h.ui.notifications.at(-1);
	assert.ok(note, "the price command notified");
	return note.message;
}

test("preview reports the fold's numbers but appends nothing and leaves the view alone", async () => {
	const h = await createHarness({ fixture: threeStepSession() });
	await h.start();
	stubUsage(h);

	const before = await contextMessages(h);
	const preview = await h.execute({ fromStep: 1, summary: SUMMARY, preview: true });
	const after = await contextMessages(h);

	assert.deepEqual(after, before, "the view did not change");
	assert.equal(h.pi.appended.length, 0, "no fold record was appended");
	assert.equal(h.fixture.entries.length, 6, "no entry was written");
	assert.equal(h.pi.sentMessages.length, 0, "the agent was not involved");

	const details = assertFoldDetails(preview, { fromStep: 1, throughStep: 2, fromEntryId: "e2", toEntryId: "e6" });
	assert.equal(details.preview, true, "the result says it is a preview");
	assert.ok(details.economics.removedTokens > 0, "the estimate is real");

	// Raw fallback content names the commitment — and the absence of one.
	assert.match(preview.content[0].text, /^Preview: steps 1 through 2 would be replaced/);
	assert.match(preview.content[0].text, /Nothing was appended/);
	assert.match(preview.content[0].text, /tokens removed/);
	assert.match(preview.content[0].text, /cache: /);
});

test("a preview and a real fold over identical inputs report the same numbers", async () => {
	const h = await createHarness({ fixture: threeStepSession() });
	await h.start();
	stubUsage(h);

	const preview = await h.execute({ fromStep: 1, summary: SUMMARY, preview: true });
	const real = await h.execute({ fromStep: 1, summary: SUMMARY });

	const previewDetails = assertFoldDetails(preview, { fromStep: 1, throughStep: 2, fromEntryId: "e2", toEntryId: "e6" });
	const realDetails = assertFoldDetails(real, { fromStep: 1, throughStep: 2, fromEntryId: "e2", toEntryId: "e6" });
	assert.deepEqual(previewDetails.economics, realDetails.economics, "identical economics");

	// Everything after the headline — the advisory and skip count — is byte-identical.
	const previewTail = preview.content[0].text.split("\n").slice(1).join("\n");
	const realTail = real.content[0].text.split("\n").slice(1).join("\n");
	assert.equal(previewTail, realTail, "identical advisory lines");
	assert.notEqual(previewTail, "", "there was an advisory to compare");

	// Only the real fold committed: one record, and only it changed the view.
	assert.equal(h.pi.appended.length, 1, "just the real fold appended");
	assert.equal(h.fixture.entries.length, 7, "exactly the fold record was written");
	assert.equal((await contextMessages(h)).length > 0, true, "the real fold changed the view");

	// The rendered form carries the same numbers, under a preview headline.
	const rendered = h.render(preview, { args: { fromStep: 1, summary: SUMMARY } }).text();
	assert.match(rendered, /Would fold steps 1–2/);
	assert.ok(rendered.includes(foldEconomicsLine(previewDetails)), "same economics line when rendered");
});

test("preview refuses exactly what the fold refuses — and vice versa", async () => {
	const h = await createHarness({ fixture: threeStepSession() });
	await h.start();

	// No such step.
	assert.equal(
		await errorOf(h.execute({ fromStep: 99, summary: SUMMARY, preview: true })),
		await errorOf(h.execute({ fromStep: 99, summary: SUMMARY })),
		"unknown step: identical refusal",
	);
	assert.match(await errorOf(h.execute({ fromStep: 99, summary: SUMMARY, preview: true })), /There is no step 99\./);

	// Empty summary: a preview must not smuggle in a fold the real one would reject.
	assert.equal(
		await errorOf(h.execute({ fromStep: 1, summary: "   ", preview: true })),
		await errorOf(h.execute({ fromStep: 1, summary: "   " })),
		"empty summary: identical refusal",
	);
	assert.match(await errorOf(h.execute({ fromStep: 1, summary: "", preview: true })), /The summary is empty\./);

	// The step you are in: nothing finished after it.
	assert.equal(
		await errorOf(h.execute({ fromStep: 3, summary: SUMMARY, preview: true })),
		await errorOf(h.execute({ fromStep: 3, summary: SUMMARY })),
		"current step: identical refusal",
	);
	assert.match(
		await errorOf(h.execute({ fromStep: 3, summary: SUMMARY, preview: true })),
		/Step 3 is the step you are in/,
	);

	// Neither a preview nor a fold got through: nothing was appended or changed.
	assert.equal(h.pi.appended.length, 0);
	assert.equal(h.fixture.entries.length, 6);
});

test("a start folded out of view is refused identically by preview and fold", async () => {
	// A fold early, then a compaction whose boundary pushes that fold's step out
	// of the view: step 1 exists on the branch but is no longer addressable.
	const fx = threeStepSession(); // e1..e6, steps 1–3
	fx.foldRecord({ fromEntryId: "e2", toEntryId: "e6", summary: "orphan summary", fromStep: 1 }); // e7
	fx.user("fourth question"); // e8
	fx.assistant("fourth answer"); // e9, step 4
	fx.compaction({ summary: "earlier work", firstKeptEntryId: "e8" }); // e10
	const h = await createHarness({ fixture: fx });
	await h.start();

	const previewError = await errorOf(h.execute({ fromStep: 1, summary: SUMMARY, preview: true }));
	const foldError = await errorOf(h.execute({ fromStep: 1, summary: SUMMARY }));
	assert.equal(previewError, foldError, "identical refusal");
	assert.match(previewError, /already been folded out of view/);
	assert.equal(h.pi.appended.length, 0);
});

test("/dmail price prints estimates for every candidate cut and folds nothing", async () => {
	const h = await createHarness({ fixture: threeStepSession() });
	await h.start();
	stubUsage(h);

	await h.runCommand("dmail", "price");

	assert.equal(h.pi.appended.length, 0, "no fold record was appended");
	assert.equal(h.fixture.entries.length, 6, "no entry was written");
	assert.equal(h.pi.sentMessages.length, 0, "the agent was not involved");

	const message = lastNotification(h);
	assert.match(message, /Candidate cuts/);
	// Both candidate cuts: from step 1 (through 2) and from step 2. The tiny
	// fixture archive can be smaller than any real memo, so the economics line
	// may honestly read "added" — what matters is that it reports, never gates.
	assert.match(message, /Would fold steps 1–2/);
	assert.match(message, /Would fold step 2/);
	assert.match(message, /tokens (removed|added)/);
	assert.match(message, /· (saves|costs) ~/);
	assert.match(message, /cache: /);
});

test("/dmail price <step> with the same inputs prints the numbers preview would", async () => {
	const h = await createHarness({ fixture: threeStepSession() });
	await h.start();
	stubUsage(h);

	const preview = await h.execute({ fromStep: 1, summary: SUMMARY, preview: true });
	const details = assertFoldDetails(preview, { fromStep: 1, throughStep: 2, fromEntryId: "e2", toEntryId: "e6" });

	await h.runCommand("dmail", `price 1 ${SUMMARY}`);

	const message = lastNotification(h);
	assert.ok(
		message.includes(foldEconomicsLine(details)),
		`price prints the preview's numbers:\n${message}\nvs\n${foldEconomicsLine(details)}`,
	);
	assert.match(message, /Would fold steps 1–2/);
	assert.equal(h.pi.appended.length, 0, "still no fold");
	assert.equal(h.pi.sentMessages.length, 0, "the agent was not involved");
});

test("/dmail price reports the fold's validation errors instead of folding", async () => {
	const h = await createHarness({ fixture: threeStepSession() });
	await h.start();

	await h.runCommand("dmail", "price 99");
	const note = h.ui.notifications.at(-1);
	assert.ok(note);
	assert.equal(note.type, "error");
	assert.match(note.message, /There is no step 99\./);
	assert.equal(h.pi.appended.length, 0, "no fold record was appended");
	assert.equal(h.fixture.entries.length, 6, "no entry was written");
});

test("/dmail price says so when nothing is finished to fold", async () => {
	const fx = new SessionFixture();
	fx.user("only question");
	fx.assistant("only answer");
	const h = await createHarness({ fixture: fx });
	await h.start();

	await h.runCommand("dmail", "price");
	assert.match(lastNotification(h), /Nothing finished to fold/);
	assert.equal(h.pi.appended.length, 0);
	assert.equal(h.pi.sentMessages.length, 0);
});

test("preview and price report the same skipped-record count", async () => {
	// A fold record orphaned by a later compaction: replay counts it as skipped.
	const fx = threeStepSession(); // e1..e6, steps 1–3
	fx.foldRecord({ fromEntryId: "e2", toEntryId: "e6", summary: "early fold", fromStep: 1 }); // e7
	fx.user("fourth question"); // e8
	fx.assistant("fourth answer"); // e9, step 4
	fx.user("fifth question"); // e10
	fx.assistant("fifth answer"); // e11, step 5
	fx.compaction({ summary: "earlier work", firstKeptEntryId: "e8" }); // e12
	const h = await createHarness({ fixture: fx });
	await h.start();
	stubUsage(h);

	const preview = await h.execute({ fromStep: 4, summary: "Later work", preview: true });
	assert.match(preview.content[0].text, /folds skipped: 1/, "preview counts the orphaned record");

	await h.runCommand("dmail", "price");
	assert.match(lastNotification(h), /folds skipped: 1/, "price counts it too — same numbers, same caveats");
	assert.equal(h.pi.appended.length, 0);
});

test("the preview render is unmistakably not a fold", async () => {
	const h = await createHarness({ fixture: threeStepSession() });
	await h.start();
	stubUsage(h);

	const preview = await h.execute({ fromStep: 1, summary: SUMMARY, preview: true });
	const rendered = h.render(preview, { args: { fromStep: 1, summary: SUMMARY } }).text();

	assert.doesNotMatch(rendered, /^✓/, "no success checkmark: nothing succeeded yet");
	assert.match(rendered, /preview/);
	assert.match(rendered, /Would fold steps 1–2/);
	assert.match(rendered, /tokens removed/, "the advisory still renders");

	// The real fold keeps its old look.
	const real = await h.execute({ fromStep: 1, summary: SUMMARY });
	const realRendered = h.render(real, { args: { fromStep: 1, summary: SUMMARY } }).text();
	assert.match(realRendered, /^✓ Folded steps 1–2/);
});

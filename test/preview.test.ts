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

	const details = assertFoldDetails(preview, { fromStep: 1, throughStep: 5, fromEntryId: "e1", toEntryId: "e6" });
	assert.equal(details.preview, true, "the result says it is a preview");
	assert.ok(details.economics.removedTokens > 0, "the estimate is real");

	// Raw fallback content names the commitment — and the absence of one.
	assert.match(preview.content[0].text, /^Preview: steps 1 through 5 would be replaced/);
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

	const previewDetails = assertFoldDetails(preview, { fromStep: 1, throughStep: 5, fromEntryId: "e1", toEntryId: "e6" });
	const realDetails = assertFoldDetails(real, { fromStep: 1, throughStep: 5, fromEntryId: "e1", toEntryId: "e6" });
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
	assert.match(rendered, /Would fold steps 1–5/);
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
		await errorOf(h.execute({ fromStep: 6, summary: SUMMARY, preview: true })),
		await errorOf(h.execute({ fromStep: 6, summary: SUMMARY })),
		"current step: identical refusal",
	);
	assert.match(
		await errorOf(h.execute({ fromStep: 6, summary: SUMMARY, preview: true })),
		/Step 6 is the step you are in/,
	);

	// Neither a preview nor a fold got through: nothing was appended or changed.
	assert.equal(h.pi.appended.length, 0);
	assert.equal(h.fixture.entries.length, 6);
});

test("a start folded out of view is refused identically by preview and fold", async () => {
	// A fold early, then a compaction whose boundary pushes that fold's step out
	// of the view: step 1 exists on the branch but is no longer addressable.
	const fx = threeStepSession(); // e1..e6, steps 1–6
	fx.foldRecord({ fromEntryId: "e2", toEntryId: "e6", summary: "orphan summary", fromStep: 2 }); // e7
	fx.user("fourth question"); // e8, step 7
	fx.assistant("fourth answer"); // e9, step 8
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
	// Nothing is running, so every turn is a candidate — a question is a cut as much as
	// an answer — and every cut runs to the newest step: from 6 down to from 1. The tiny
	// fixture archive can be smaller than any real memo, so the economics line may
	// honestly read "added" — what matters is that it reports, never gates.
	assert.match(message, /Would fold step 6/);
	assert.match(message, /Would fold steps 5–6/);
	assert.match(message, /Would fold steps 1–6/);
	assert.ok(
		message.indexOf("Would fold step 6") < message.indexOf("Would fold steps 1–6"),
		"the newest cut is listed first, like every other list a fold reads",
	);
	assert.match(message, /tokens (removed|added)/);
	assert.match(message, /· (saves|costs) ~/);
	assert.match(message, /cache: /);
});

test("/dmail price with a round in flight prices the cuts that end before it", async () => {
	const h = await createHarness({ fixture: threeStepSession(), idle: false });
	await h.start();
	stubUsage(h);

	await h.runCommand("dmail", "price");

	const message = lastNotification(h);
	// The newest step is the round in progress, so no candidate starts or ends there.
	assert.match(message, /Would fold steps 1–5/);
	assert.match(message, /Would fold step 5/);
	assert.doesNotMatch(message, /step 6/, "the in-progress step is not a candidate while it runs");
	// Each cut keeps that round, so the rebuild is knowable and the verdict is real.
	assert.doesNotMatch(message, /rebuild unknowable/, "a cut that keeps a step can price its rebuild");
});

test("a cut that runs to the newest step says its rebuild is unknowable, and a cut that keeps a step does not", async () => {
	// Big steps so the archive clearly beats the stand-in memo: the honest "unknown"
	// verdict only surfaces when the cut actually saves, since "never-pays" outranks it.
	const bigSession = (): SessionFixture => {
		const big = (n: number) => "x".repeat(2_000) + ` step ${n}`;
		const fx = new SessionFixture();
		fx.user("q1");
		fx.assistant(big(1));
		fx.user("q2");
		fx.assistant(big(2));
		fx.user("q3");
		fx.assistant(big(3));
		return fx;
	};

	const idleRun = await createHarness({ fixture: bigSession() });
	await idleRun.start();
	stubUsage(idleRun);
	await idleRun.runCommand("dmail", "price");
	const idleMessage = lastNotification(idleRun);
	assert.match(idleMessage, /cache: unknown \(rebuild unknowable\)/, "nothing follows an open-ended cut yet");
	// Every candidate ends at the newest step, so every row is open-ended: a list where
	// only the last one is would mean the others were priced with a kept suffix. There
	// are six — one per turn, questions included.
	assert.equal(
		(idleMessage.match(/rebuild unknowable/g) ?? []).length,
		6,
		"all six open-ended candidates report an unknowable rebuild",
	);

	const busyRun = await createHarness({ fixture: bigSession(), idle: false });
	await busyRun.start();
	stubUsage(busyRun);
	await busyRun.runCommand("dmail", "price 1 3");
	const busyMessage = lastNotification(busyRun);
	assert.doesNotMatch(busyMessage, /rebuild unknowable/, "a cut that keeps the next step can price its rebuild");
});

test("/dmail price <step> with the same inputs prints the numbers preview would", async () => {
	// In flight, because `preview` is the tool's own view of the same range: the tool can
	// only ever fold a range that ends below its own round, and price must agree with it.
	const h = await createHarness({ fixture: threeStepSession(), idle: false });
	await h.start();
	stubUsage(h);

	const preview = await h.execute({ fromStep: 1, summary: SUMMARY, preview: true });
	const details = assertFoldDetails(preview, { fromStep: 1, throughStep: 5, fromEntryId: "e1", toEntryId: "e6" });

	await h.runCommand("dmail", `price 1 ${SUMMARY}`);

	const message = lastNotification(h);
	assert.ok(
		message.includes(foldEconomicsLine(details)),
		`price prints the preview's numbers:\n${message}\nvs\n${foldEconomicsLine(details)}`,
	);
	assert.match(message, /Would fold steps 1–5/);
	assert.equal(h.pi.appended.length, 0, "still no fold");
	assert.equal(h.pi.sentMessages.length, 0, "the agent was not involved");
});

test("/dmail price <start> <end> prints the figures for exactly the range the fold would freeze", async () => {
	const h = await createHarness({ fixture: threeStepSession() });
	await h.start();
	stubUsage(h);

	const preview = await h.execute({ fromStep: 1, throughStep: 1, summary: SUMMARY, preview: true });
	const details = assertFoldDetails(preview, { fromStep: 1, throughStep: 1, fromEntryId: "e1", toEntryId: "e2" });

	await h.runCommand("dmail", `price 1 1 ${SUMMARY}`);

	const message = lastNotification(h);
	assert.ok(
		message.includes(foldEconomicsLine(details)),
		`price with an end prints the preview's numbers:\n${message}\nvs\n${foldEconomicsLine(details)}`,
	);
	assert.match(message, /Would fold step 1/);
	assert.equal(h.pi.appended.length, 0, "still no fold");
	assert.equal(h.pi.sentMessages.length, 0, "the agent was not involved");
});

test("/dmail price <start> <end> reports the fold's own refusal for an end that is not one", async () => {
	const h = await createHarness({ fixture: threeStepSession() });
	await h.start();

	await h.runCommand("dmail", "price 1 7");

	const note = h.ui.notifications.at(-1);
	assert.equal(note?.type, "error");
	assert.match(note?.message ?? "", /There is no step 7 to fold through\. Ends: \[6, 5, 4, 3, 2, 1\]\./);
	assert.equal(h.pi.appended.length, 0, "no fold record on a refused range");
});

test("/dmail price refuses the newest step as an end while a round is in flight", async () => {
	const h = await createHarness({ fixture: threeStepSession(), idle: false });
	await h.start();

	await h.runCommand("dmail", "price 1 6");

	const note = h.ui.notifications.at(-1);
	assert.equal(note?.type, "error", "an end that is not one is an error, not a priced cut");
	assert.match(note?.message ?? "", /There is no step 6 to fold through\. Ends: \[5, 4, 3, 2, 1\]\./);
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

test("/dmail price still prices the lone request when nothing else is foldable", async () => {
	const fx = new SessionFixture();
	fx.user("only question");
	fx.assistant("only answer");
	// In flight: the answer is the round being written, so the request it answers is
	// the only cut left. It is priced like any other step.
	const h = await createHarness({ fixture: fx, idle: false });
	await h.start();

	await h.runCommand("dmail", "price");
	assert.match(lastNotification(h), /Would fold step 1/, "the one cut left is the request");
	assert.equal(h.pi.appended.length, 0);
	assert.equal(h.pi.sentMessages.length, 0);
});

test("/dmail price says so when there is nothing to fold at all", async () => {
	// A request nobody has answered: it is the round in progress, so there is no
	// candidate either — and the list says so rather than printing an empty one.
	const fx = new SessionFixture();
	fx.user("a request nobody has answered yet");
	const h = await createHarness({ fixture: fx, idle: false });
	await h.start();

	await h.runCommand("dmail", "price");
	assert.match(lastNotification(h), /Nothing finished to fold/);
	assert.equal(h.pi.appended.length, 0);
	assert.equal(h.pi.sentMessages.length, 0);
});

test("preview and price report the same skipped-record count", async () => {
	// A fold record orphaned by a later compaction: replay counts it as skipped.
	const fx = threeStepSession(); // e1..e6, steps 1–6
	fx.foldRecord({ fromEntryId: "e2", toEntryId: "e6", summary: "early fold", fromStep: 2 }); // e7
	fx.user("fourth question"); // e8, step 7
	fx.assistant("fourth answer"); // e9, step 8
	fx.user("fifth question"); // e10, step 9
	fx.assistant("fifth answer"); // e11, step 10
	fx.compaction({ summary: "earlier work", firstKeptEntryId: "e8" }); // e12
	const h = await createHarness({ fixture: fx });
	await h.start();
	stubUsage(h);

	const preview = await h.execute({ fromStep: 8, summary: "Later work", preview: true });
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
	assert.match(rendered, /Would fold steps 1–5/);
	assert.match(rendered, /tokens removed/, "the advisory still renders");

	// The real fold keeps its old look.
	const real = await h.execute({ fromStep: 1, summary: SUMMARY });
	const realRendered = h.render(real, { args: { fromStep: 1, summary: SUMMARY } }).text();
	assert.match(realRendered, /^✓ Folded steps 1–5/);
});

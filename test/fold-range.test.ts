/**
 * The two-end fold (ticket 12) at the tool seam: `send_dmail` now takes an
 * optional inclusive `throughStep`. Omitted, the end stays frozen at the last
 * completed step exactly as before; given, the fold stops there and the record's
 * exclusive `toEntryId` is the entry of the step AFTER the end — a step start,
 * which is what keeps a tool call and its result on the same side of the cut.
 *
 * A step is one message turn, so both endpoints may be a request or an answer;
 * only a tool result is off limits. The default fixture numbers e1→1 (question),
 * e2→2 (answer), e3→3, e4→4, e5→5, e6→6 (the round in progress).
 *
 * Every case goes through the harness (the extension's real registration), so
 * the refusal copy, the record, and the result details are the ones a session sees.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FoldRecord } from "../fold.ts";
import { assertFoldDetails, createHarness, SessionFixture, threeStepSession, type Harness } from "./harness/index.ts";

const SUMMARY = "Opening exchange: the goal and the two decisions later steps depend on.";

/** The fold record the extension last appended. */
function lastRecord(h: Harness): FoldRecord {
	return h.pi.appended.at(-1)!.data as FoldRecord;
}

/** The error message a rejected tool call carried, or "" when it resolved. */
async function failureOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		return "";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

test("throughStep stops the fold there: the record ends at the step after the end", async () => {
	const h = await createHarness();
	await h.start();

	// One turn is one step: step 1 is the question, step 2 the answer it produced.
	const result = await h.execute({ fromStep: 1, throughStep: 1, summary: SUMMARY });

	assertFoldDetails(result, { fromStep: 1, throughStep: 1, fromEntryId: "e1", toEntryId: "e2" });
	const record = lastRecord(h);
	assert.equal(record.fromEntryId, "e1", "the record starts at the chosen start, request and all");
	assert.equal(record.toEntryId, "e2", "the exclusive end is step 2's entry, so the answer is kept");
	assert.ok(String(result.content[0].text).startsWith("Folded steps 1 through 1."), "the headline names the chosen range");
	assert.ok(
		h.ui.notifications.some((note) => note.message.includes("Folded steps 1–1.")),
		"the notify line names the same range",
	);
});

test("an omitted throughStep keeps the frozen end: the last completed step", async () => {
	const h = await createHarness();
	await h.start();

	const result = await h.execute({ fromStep: 1, summary: SUMMARY });

	assertFoldDetails(result, { fromStep: 1, throughStep: 5, fromEntryId: "e1", toEntryId: "e6" });
	assert.equal(lastRecord(h).toEntryId, "e6", "the round in progress is still the first kept entry");
});

test("A == B is legal: one step is a range", async () => {
	const h = await createHarness();
	await h.start();

	const result = await h.execute({ fromStep: 2, throughStep: 2, summary: SUMMARY });
	assertFoldDetails(result, { fromStep: 2, throughStep: 2, fromEntryId: "e2", toEntryId: "e3" });
});

test("an end older than the start refuses, naming the ends that are valid", async () => {
	const h = await createHarness();
	await h.start();

	const message = await failureOf(h.execute({ fromStep: 2, throughStep: 1, summary: SUMMARY }));
	assert.match(message, /There is no step 1 to fold through\. Ends: \[5, 4, 3, 2\]\./);
	assert.equal(h.pi.appended.length, 0, "a refused fold appends nothing");
});

test("the step you are in is never a valid end", async () => {
	const h = await createHarness();
	await h.start();

	const message = await failureOf(h.execute({ fromStep: 1, throughStep: 6, summary: SUMMARY }));
	assert.match(
		message,
		/There is no step 6 to fold through\. Ends: \[5, 4, 3, 2, 1\]\./,
		"valid ends are listed latest first, and the round in progress is not among them",
	);
	assert.equal(h.pi.appended.length, 0, "a refused fold appends nothing");
});

test("preview with an explicit end reports the same range and folds nothing", async () => {
	const h = await createHarness();
	await h.start();

	const result = await h.execute({ fromStep: 1, throughStep: 1, summary: SUMMARY, preview: true });

	const details = assertFoldDetails(result, { fromStep: 1, throughStep: 1, fromEntryId: "e1", toEntryId: "e2" });
	assert.equal(details.preview, true, "preview flag rides the details");
	assert.equal(h.pi.appended.length, 0, "preview appends no record");
	assert.ok(String(result.content[0].text).startsWith("Preview: steps 1 through 1 would be replaced"), "the preview copy names the chosen end");
});

/** A ladder whose third turn is a tool call: e4 is its result and carries no step. */
function toolResultSession(): SessionFixture {
	const fx = new SessionFixture();
	fx.user("first question"); // e1 → step 1
	fx.assistant("first answer"); // e2 → step 2
	fx.toolCall("bash", { command: "ls" }); // e3 → step 3
	fx.toolResult("tc3", "bash", "a file"); // e4, no step
	fx.user("second question"); // e5 → step 4
	fx.assistant("second answer"); // e6 → step 5, the round in progress
	return fx;
}

test("the chosen end never splits a tool call from its result", async () => {
	// e1→1 (question), e2→2 (answer), e3→3 (tool call) whose result is e4 and is no
	// step at all, e5→4 (question), e6→5 (the round in progress).
	const fx = new SessionFixture();
	fx.user("first question");
	fx.assistant("first answer");
	fx.toolCall("bash", { command: "ls" });
	fx.toolResult("tc3", "bash", "a file");
	fx.user("second question");
	fx.assistant("second answer");
	const h = await createHarness({ fixture: fx });
	await h.start();

	// Folding "through step 3" means the tool call and its result both go; the record
	// must stop at step 4's entry, never at the tool result's.
	const result = await h.execute({ fromStep: 1, throughStep: 3, summary: SUMMARY });
	assertFoldDetails(result, { fromStep: 1, throughStep: 3, fromEntryId: "e1", toEntryId: "e5" });

	const record = lastRecord(h);
	assert.equal(record.fromEntryId, "e1", "the record starts where the user chose");
	assert.equal(record.toEntryId, "e5", "the exclusive end is step 4's entry, not the tool result's");

	// And the fold replays: a record that cut the pair would have been skipped as invalid.
	const [context] = (await h.dispatch("context", { type: "context" }, h.ctx)) as any[];
	assert.ok(context?.messages?.length, "the fold applies to the context view");
});

test("a fold may end on a request: the answer goes, the next question stays", async () => {
	const h = await createHarness();
	await h.start();

	// Steps 1–2 are the opening question and its answer; step 3 is the next question.
	const result = await h.execute({ fromStep: 1, throughStep: 2, summary: SUMMARY });

	assertFoldDetails(result, { fromStep: 1, throughStep: 2, fromEntryId: "e1", toEntryId: "e3" });
	assert.equal(lastRecord(h).toEntryId, "e3", "the exclusive end is the next question's entry");
	assert.ok(String(result.content[0].text).startsWith("Folded steps 1 through 2."), "the headline names the range");
});

test("the opening request is step 1, so folding it needs no special case", async () => {
	const h = await createHarness();
	await h.start();

	const result = await h.execute({ fromStep: 1, summary: SUMMARY });

	assertFoldDetails(result, { fromStep: 1, throughStep: 5, fromEntryId: "e1", toEntryId: "e6" });
	assert.equal(lastRecord(h).fromEntryId, "e1", "the record starts at the opening request itself");
	assert.ok(String(result.content[0].text).startsWith("Folded steps 1 through 5."), "no invented step number");

	const [context] = (await h.dispatch("context", { type: "context" }, h.ctx)) as any[];
	const rendered = JSON.stringify(context?.messages ?? []);
	assert.ok(!rendered.includes("first question"), "the request itself is gone from the view");
	assert.ok(rendered.includes(SUMMARY.slice(0, 20)), "replaced by the summary in its place");
	assert.ok(rendered.includes("third answer"), "while the round in progress still renders");
});

test("a range whose two ends are both requests is legal", async () => {
	const h = await createHarness({ fixture: toolResultSession() });
	await h.start();

	// Step 1 is a question and step 4 is a question: both are ends, and the exchange
	// between them — the answer, the tool call and its result — goes as a unit.
	const legal = await h.execute({ fromStep: 1, throughStep: 4, summary: SUMMARY });
	assertFoldDetails(legal, { fromStep: 1, throughStep: 4, fromEntryId: "e1", toEntryId: "e6" });
	assert.equal(lastRecord(h).toEntryId, "e6", "the exclusive end is the answer after the second question");

	// The tool result is the one entry no range can name: it has no step number, so
	// the seam refuses to invent one and says what the real ends are. A fresh session
	// so the refusal is the end check, not the mid-fold one the fold above provokes.
	const fresh = await createHarness({ fixture: toolResultSession() });
	await fresh.start();
	const message = await failureOf(fresh.execute({ fromStep: 3, throughStep: 99, summary: SUMMARY }));
	assert.match(message, /There is no step 99 to fold through\. Ends: \[4, 3\]\./);
});

test("the tool says a step is one message turn", async () => {
	const h = await createHarness();
	const schema = h.tool().parameters as any;
	assert.match(
		schema.properties.fromStep.description,
		/A step is one message turn: the user's and the assistant's alike\./,
		"the agent is told requests are numbered too",
	);
});

test("the tool advertises throughStep as an optional parameter", async () => {
	const h = await createHarness();
	const schema = h.tool().parameters as any;
	assert.ok(schema.properties.throughStep, "the parameter is in the schema the agent sees");
	assert.ok(!schema.required?.includes("throughStep"), "and omitting it stays legal");
	assert.match(h.tool().description, /through `throughStep`/, "the description explains the default end");
});

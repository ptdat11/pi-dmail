/**
 * The two-end fold (ticket 12) at the tool seam: `send_dmail` now takes an
 * optional inclusive `throughStep`. Omitted, the end stays frozen at the last
 * completed step exactly as before; given, the fold stops there and the record's
 * exclusive `toEntryId` is the entry of the step AFTER the end — a step start,
 * which is what keeps a tool call and its result on the same side of the cut.
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
	// steps: 1 = e2, 2 = e4, 3 = e6 (the step in progress)
	const h = await createHarness();
	await h.start();

	const result = await h.execute({ fromStep: 1, throughStep: 1, summary: SUMMARY });

	assertFoldDetails(result, { fromStep: 1, throughStep: 1, fromEntryId: "e2", toEntryId: "e4" });
	const record = lastRecord(h);
	assert.equal(record.fromEntryId, "e2", "the record starts at the chosen start");
	assert.equal(record.toEntryId, "e4", "the exclusive end is step 2's entry, so step 2 is kept");
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

	assertFoldDetails(result, { fromStep: 1, throughStep: 2, fromEntryId: "e2", toEntryId: "e6" });
	assert.equal(lastRecord(h).toEntryId, "e6", "the step in progress is still the first kept entry");
});

test("A == B is legal: one step is a range", async () => {
	const h = await createHarness();
	await h.start();

	const result = await h.execute({ fromStep: 2, throughStep: 2, summary: SUMMARY });
	assertFoldDetails(result, { fromStep: 2, throughStep: 2, fromEntryId: "e4", toEntryId: "e6" });
});

test("an end older than the start refuses, naming the ends that are valid", async () => {
	const h = await createHarness();
	await h.start();

	const message = await failureOf(h.execute({ fromStep: 2, throughStep: 1, summary: SUMMARY }));
	assert.match(message, /There is no step 1 to fold through\. Ends: \[2\]\./);
	assert.equal(h.pi.appended.length, 0, "a refused fold appends nothing");
});

test("the step you are in is never a valid end", async () => {
	const h = await createHarness();
	await h.start();

	const message = await failureOf(h.execute({ fromStep: 1, throughStep: 3, summary: SUMMARY }));
	assert.match(message, /There is no step 3 to fold through\. Ends: \[2, 1\]\./, "valid ends are listed latest first");
	assert.equal(h.pi.appended.length, 0, "a refused fold appends nothing");
});

test("preview with an explicit end reports the same range and folds nothing", async () => {
	const h = await createHarness();
	await h.start();

	const result = await h.execute({ fromStep: 1, throughStep: 1, summary: SUMMARY, preview: true });

	const details = assertFoldDetails(result, { fromStep: 1, throughStep: 1, fromEntryId: "e2", toEntryId: "e4" });
	assert.equal(details.preview, true, "preview flag rides the details");
	assert.equal(h.pi.appended.length, 0, "preview appends no record");
	assert.ok(String(result.content[0].text).startsWith("Preview: steps 1 through 1 would be replaced"), "the preview copy names the chosen end");
});

test("the chosen end never splits a tool call from its result", async () => {
	// step 1 = e2, step 2 = e4 (tool call) whose result is e5, step 3 = e6.
	const fx = new SessionFixture();
	fx.user("first question");
	fx.assistant("first answer");
	fx.toolCall("bash", { command: "ls" });
	fx.toolResult("tc3", "bash", "a file");
	fx.user("second question");
	fx.assistant("second answer");
	const h = await createHarness({ fixture: fx });
	await h.start();

	// Folding "through step 2" means the tool call and its result both go; the record
	// must stop at step 3's entry, never at the tool result's.
	const result = await h.execute({ fromStep: 1, throughStep: 2, summary: SUMMARY });
	assertFoldDetails(result, { fromStep: 1, throughStep: 2, fromEntryId: "e2", toEntryId: "e6" });

	const record = lastRecord(h);
	assert.equal(record.fromEntryId, "e2", "the record starts where the user chose");
	assert.equal(record.toEntryId, "e6", "the exclusive end is step 3's entry, not the tool result's");

	// And the fold replays: a record that cut the pair would have been skipped as invalid.
	const [context] = (await h.dispatch("context", { type: "context" }, h.ctx)) as any[];
	assert.ok(context?.messages?.length, "the fold applies to the context view");
});

test("the tool advertises throughStep as an optional parameter", async () => {
	const h = await createHarness();
	const schema = h.tool().parameters as any;
	assert.ok(schema.properties.throughStep, "the parameter is in the schema the agent sees");
	assert.ok(!schema.required?.includes("throughStep"), "and omitting it stays legal");
	assert.match(h.tool().description, /through `throughStep`/, "the description explains the default end");
});

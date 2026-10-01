/**
 * Tests for the replayed prompt's second copy of the summary.
 *
 * The seam being defended: replay injects one `<summary>` chip per applied
 * record, and the `send_dmail` call that wrote it stays in the view — the step
 * doing the folding is never inside its own range — so without this pass the
 * body of the summary rides along in that call's `arguments` on every request.
 * One chip, one redaction.
 *
 * The pure tests drive `dedupe.ts` directly. The last one is the seam: the real
 * tool, a real record, the real `context` hook.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { redactFoldCalls, type AppliedFold } from "../dedupe.ts";
import { createHarness, threeStepSession } from "./harness/index.ts";

const SUMMARY = "Ran the suite: 8 passed. Ships as tool call, result, and one test.";

/** Assistant message whose only content is one call to the folding tool. */
function call(args: Record<string, unknown>, id = "tc1", name = "send_dmail") {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
	};
}

/** The result pi would record for a folded call: headline, advisory, skip line. */
function result(id = "tc1", details: Record<string, unknown> = {}, text?: string) {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "send_dmail",
		content: [
			{
				type: "text",
				text:
					text ??
					"Folded steps 1 through 4. They are replaced by your summary from the next request on.\n" +
						"~1.2k tokens removed · saves ~1.1k/req · cache: helpful\n" +
						"folds skipped: 2",
			},
		],
		details,
	};
}

/** Arguments of the (only) call in a message. */
function argsOf(message: unknown): Record<string, unknown> {
	const content = (message as { content: { arguments: Record<string, unknown> }[] }).content;
	return content[0].arguments;
}

/** The result text as the model would read it. */
function textOf(message: unknown): string {
	return (message as { content: { text: string }[] }).content.map((block) => block.text).join("\n");
}

const applied: AppliedFold[] = [{ fromStep: 1, summary: SUMMARY }];

test("the folded call keeps its range and loses the summary body", () => {
	const out = redactFoldCalls([call({ fromStep: 1, throughStep: 4, summary: SUMMARY }), result()], {
		toolName: "send_dmail",
		applied,
	});
	assert.deepEqual(argsOf(out[0]), { fromStep: 1, throughStep: 4 });
	assert.ok(!JSON.stringify(out[0]).includes("Ran the suite"), "the body is gone from the call");
});

test("a stated end rides along; a default one is not invented", () => {
	const stated = redactFoldCalls([call({ fromStep: 1, throughStep: 4, summary: SUMMARY })], {
		toolName: "send_dmail",
		applied,
	});
	assert.equal(argsOf(stated[0]).throughStep, 4);
	// throughStep omitted: the end was resolved at fold time and named by the headline.
	const implied = redactFoldCalls([call({ fromStep: 1, summary: SUMMARY })], {
		toolName: "send_dmail",
		applied,
	});
	assert.deepEqual(argsOf(implied[0]), { fromStep: 1 });
});

test("the result keeps the headline and the advisory, and drops the skip count", () => {
	const economics = { removedTokens: 1200, estimatedSavingsTokens: 1100, cacheVerdict: "helpful" } as const;
	const out = redactFoldCalls(
		[call({ fromStep: 1, summary: SUMMARY }), result("tc1", { economics })],
		{ toolName: "send_dmail", applied },
	);
	const text = textOf(out[1]);
	assert.match(text, /^Folded steps 1 through 4\./, "the headline survives: what went, and that it takes effect now");
	assert.match(text, /~1.2k tokens removed/, "the advisory rides along — it is the cue to keep folding");
	assert.ok(!text.includes("folds skipped"), "the skip count is dropped: replay just re-decided it");
});

test("a preview has no chip, so its arguments stay the only copy", () => {
	const preview = { fromStep: 1, throughStep: 4, summary: SUMMARY, preview: true };
	const out = redactFoldCalls([call(preview, "tc9"), result("tc9", {}, "Preview: steps 1 through 4 …")], {
		toolName: "send_dmail",
		applied,
	});
	assert.deepEqual(argsOf(out[0]), preview, "preview arguments are untouched");
	assert.match(textOf(out[1]), /^Preview:/, "and so is its result");
});

test("a call no applied record claims is untouched", () => {
	const refused = { fromStep: 9, summary: SUMMARY };
	const otherSummary = { fromStep: 1, summary: "something else" };
	const out = redactFoldCalls([call(refused, "tc1"), call(otherSummary, "tc2")], {
		toolName: "send_dmail",
		applied,
	});
	assert.deepEqual(argsOf(out[0]), refused);
	assert.deepEqual(argsOf(out[1]), otherSummary);
});

test("another tool's call and a parallel block survive", () => {
	const message = {
		role: "assistant",
		content: [
			{ type: "text", text: "folding and reading" },
			{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } },
			{ type: "toolCall", id: "tc2", name: "send_dmail", arguments: { fromStep: 1, summary: SUMMARY } },
		],
	};
	const out = redactFoldCalls([message, result("tc2", {}, "Folded steps 1 through 4.")], {
		toolName: "send_dmail",
		applied,
	});
	const blocks = (out[0] as { content: Record<string, unknown>[] }).content;
	assert.deepEqual(blocks[0], { type: "text", text: "folding and reading" });
	assert.deepEqual(blocks[1].arguments, { path: "a.ts" }, "the other tool's call is untouched");
	assert.deepEqual(blocks[2].arguments, { fromStep: 1 }, "only the folded call is rewritten");
	assert.match(textOf(out[1]), /^Folded steps 1 through 4\./, "and only its own result is trimmed");
});

test("two identical folds redact exactly two calls", () => {
	const calls = [call({ fromStep: 1, summary: SUMMARY }, "tc1"), call({ fromStep: 1, summary: SUMMARY }, "tc2")];
	const out = redactFoldCalls(calls, {
		toolName: "send_dmail",
		applied: [
			{ fromStep: 1, summary: SUMMARY },
			{ fromStep: 1, summary: SUMMARY },
		],
	});
	assert.deepEqual(argsOf(out[0]), { fromStep: 1 });
	// One record left over, no second claim: nothing to redact.
	const once = redactFoldCalls(calls, { toolName: "send_dmail", applied });
	assert.ok(JSON.stringify(argsOf(once[1])).includes(SUMMARY), "the unmatched call keeps its body");
});

test("structure survives: same messages, same length, nothing dropped", () => {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "hi" }] },
		call({ fromStep: 1, summary: SUMMARY }),
		result(),
	];
	const out = redactFoldCalls(messages, { toolName: "send_dmail", applied });
	assert.equal(out.length, messages.length);
	assert.deepEqual(
		out.map((m) => m.role),
		messages.map((m) => m.role),
	);
});

test("unfamiliar shapes pass through instead of throwing", () => {
	const weird = [
		{ role: "assistant", content: "a string, not blocks" },
		{ role: "toolResult", toolCallId: "tc1", toolName: "send_dmail", content: [] },
		{ role: "bashExecution", command: "ls" },
	];
	const out = redactFoldCalls(weird, { toolName: "send_dmail", applied });
	assert.deepEqual(out, weird);
});

test("replay is deterministic: the same session sends the same bytes", () => {
	const messages = [call({ fromStep: 1, throughStep: 4, summary: SUMMARY }), result()];
	const once = redactFoldCalls(messages, { toolName: "send_dmail", applied });
	const twice = redactFoldCalls(messages, { toolName: "send_dmail", applied });
	assert.equal(JSON.stringify(once), JSON.stringify(twice), "byte-identical — prompt caching keeps working");
});

// Seam: a session as it really looks after the model folds — the record, the
// call that wrote it, and its result — put through the real `context` hook.
test("the replayed view carries the summary once, and the call only its range", async () => {
	const fixture = threeStepSession();
	// The call as the model wrote it, paired with its result under the same id.
	const callEntry = fixture.toolCall("send_dmail", { fromStep: 1, summary: SUMMARY }) as any;
	const callId = callEntry.message.content[0].id;
	fixture.toolResult(
		callId,
		"send_dmail",
		"Folded steps 1 through 1. They are replaced by your summary.\nfolds skipped: 0",
	);
	// Step 1 folds; the step that folded it (a later one) stays in the view.
	fixture.foldRecord({ fromEntryId: "e2", toEntryId: "e4", summary: SUMMARY, fromStep: 1 });

	const h = await createHarness({ fixture });
	await h.start();
	const [context] = (await h.dispatch("context", { type: "context" }, h.ctx)) as any[];
	const view = JSON.stringify(context.messages);

	assert.equal((view.match(/<summary>/g) ?? []).length, 1, "one chip");
	assert.equal((view.match(/Ran the suite/g) ?? []).length, 1, "the body appears once — in the chip");

	const survived = context.messages.find((message: any) =>
		Array.isArray(message.content) && message.content.some((block: any) => block.name === "send_dmail"),
	);
	const call = survived.content.find((block: any) => block.name === "send_dmail");
	assert.deepEqual(call.arguments, { fromStep: 1 }, "the surviving call carries only its range");
	assert.ok(!view.includes("folds skipped"), "and its result lost the skip line");
});
/**
 * The injected policy is the extension's only instruction channel (tickets 10 +
 * follow-up): an enabled session must gain the fold-timing guidance — fold when
 * a task completes so past folds stay valid, preview before committing — while a
 * disabled session must see no D-Mail guidance at all (instructing the model to
 * fold on a request that will not be folded is the one thing guaranteed to confuse it).
 * The policy teaches only how to send D-Mail: no user commands, no picker. It
 * rides the existing policy, so it inherits and must not contradict the
 * non-destructive framing: folding changes what is shown, never what happened.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "./harness/index.ts";

async function dispatchPrompt(h: Awaited<ReturnType<typeof createHarness>>) {
	const [result] = await h.dispatch("before_agent_start", { systemPrompt: "BASE PROMPT" });
	return result as { systemPrompt: string } | undefined;
}

test("an enabled session's system prompt carries the fold-timing guidance", async () => {
	const h = await createHarness();
	await h.start();

	const result = await dispatchPrompt(h);
	assert.ok(result, "the hook yields a rewritten prompt while enabled");

	assert.ok(result.systemPrompt.startsWith("BASE PROMPT"), "the existing prompt survives, policy appended");
	assert.match(result.systemPrompt, /# REQUIRE: Folding your context/, "the policy is injected");
	// The guidance pieces, anchored to the section's own phrasing so a future
	// edit that drops the guidance cannot pass vacuously.
	assert.match(result.systemPrompt, /## Fold timing/, "the fold-timing section is present");
	assert.match(result.systemPrompt, /\*\*Fold when a task completes\..*closed a task\nthat is still closed/s,
		"fold at task completion, so past folds stay valid");
	assert.match(result.systemPrompt, /\*\*Preview before you commit\.\*\*.*`preview` parameter/s,
		"preview before committing");
	// The policy teaches how to send D-Mail only — no user-facing commands.
	assert.doesNotMatch(result.systemPrompt, /\/(dmail|send-dmail)\b/,
		"no user commands leak into the policy");
	// Non-destructive framing stays intact alongside the new guidance.
	assert.match(result.systemPrompt, /not what happened/, "the non-destructive framing is preserved");
});

test("a disabled session's system prompt contains no dmail guidance", async () => {
	const h = await createHarness();
	h.pi.setFlag("dmail-disabled", true);
	await h.start();

	const result = await dispatchPrompt(h);
	assert.equal(result, undefined, "the hook yields nothing while disabled");
});

test("`/dmail off` withholds the policy as well", async () => {
	const h = await createHarness();
	await h.start();
	await h.runCommand("dmail", "off");

	const result = await dispatchPrompt(h);
	assert.equal(result, undefined, "the hook yields nothing after /dmail off");
});

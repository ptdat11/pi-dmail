/**
 * The injected policy is the extension's only instruction channel (ticket 10):
 * an enabled session must gain the fold-timing and ladder guidance — free-form
 * timing, large-and-rare over small-and-frequent, re-folding stale ladders,
 * preview/price before committing, and the user's picker — while a disabled
 * session must see no D-Mail guidance at all (instructing the model to fold on
 * a request that will not be folded is the one thing guaranteed to confuse it).
 * The guidance rides the existing policy, so it inherits and must not
 * contradict the non-destructive framing: folding changes what is shown, never
 * what happened.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "./harness/index.ts";

async function dispatchPrompt(h: Awaited<ReturnType<typeof createHarness>>) {
	const [result] = await h.dispatch("before_agent_start", { systemPrompt: "BASE PROMPT" });
	return result as { systemPrompt: string } | undefined;
}

test("an enabled session's system prompt carries the ladder guidance", async () => {
	const h = await createHarness();
	await h.start();

	const result = await dispatchPrompt(h);
	assert.ok(result, "the hook yields a rewritten prompt while enabled");

	assert.ok(result.systemPrompt.startsWith("BASE PROMPT"), "the existing prompt survives, policy appended");
	assert.match(result.systemPrompt, /# REQUIRE: Folding your context/, "the policy is injected");
	// The five pieces of ticket 10's guidance, anchored to the section's own
	// phrasing so a future edit that drops the guidance cannot pass vacuously.
	assert.match(result.systemPrompt, /Fold timing is \*\*free-form\*\*/, "fold timing is free-form");
	assert.match(result.systemPrompt, /Each fold sits on a \*\*ladder\*\*/, "the ladder model is named");
	assert.match(result.systemPrompt, /\*\*Fold large and rare rather than small\s+and frequent\./,
		"large-and-rare rather than small-and-frequent");
	assert.match(result.systemPrompt, /\*\*Re-fold stale ladders\.\*\*/, "stale ladders get re-folded");
	assert.match(result.systemPrompt, /\*\*Preview before you commit\.\*\*.*\/dmail price \[step\]/s,
		"preview/price before committing");
	assert.match(result.systemPrompt, /The user can pin the cut point.*`\/dmail fold` picker/s,
		"the user can pin a cut point via the picker");
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

// Smoke test: drive the real send_dmail tool through the harness — register the
// extension against fake pi, execute a fold, and render the folded view.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CANCEL, createFakeUi, createHarness, SessionFixture, threeStepSession } from "./index.ts";
import { FOLD_TYPE } from "../../fold.ts";

test("harness registers the extension like pi would", async () => {
	const h = await createHarness();

	assert.ok(h.pi.tools.get("send_dmail"), "send_dmail tool registered");
	assert.ok(h.pi.commands.get("dmail"), "/dmail command registered");
	assert.ok(h.pi.commands.get("send-dmail"), "/send-dmail command registered");
	assert.ok(h.pi.flags.get("dmail-disabled"), "dmail-disabled flag registered");
	assert.ok(h.pi.hooks.get("session_start")?.length, "session_start hook registered");
	assert.ok(h.pi.hooks.get("context")?.length, "context hook registered");

	await h.start();
	assert.ok(
		h.ui.statuses.some((s) => s.key.trim() === "dmail"),
		"session_start painted the status badge",
	);
});

test("smoke: execute folds steps and renderResult renders the folded view", async () => {
	const fixture = threeStepSession(); // e1..e6; steps 1–3 are the assistant messages e2, e4, e6
	const h = await createHarness({ fixture });
	await h.start();

	const summary = "Opening exchange";
	const result = await h.execute({ fromStep: 1, summary });

	// The fold record lands both in pi's appends and on the session itself.
	assert.equal(h.pi.appended.length, 1);
	assert.deepEqual(h.pi.appended[0], {
		customType: FOLD_TYPE,
		data: { fromEntryId: "e2", toEntryId: "e6", summary, fromStep: 1 },
	});
	const persisted = fixture.entries.at(-1);
	assert.equal(persisted?.type, "custom");
	assert.equal((persisted as any)?.customType, FOLD_TYPE);

	// Tool result text and details.
	assert.deepEqual(result.details, { fromStep: 1, throughStep: 2, fromEntryId: "e2", toEntryId: "e6" });
	assert.equal(
		result.content[0].text,
		"Folded steps 1 through 2. They are replaced by your summary from the next request on.",
	);

	// The user-facing notification.
	assert.deepEqual(h.ui.notifications, [
		{ message: "Folded steps 1–2. In effect from the next request.", type: "info" },
	]);

	// Collapsed render: plain-text folded view via the real Text component.
	const collapsed = h.render(result, { args: { fromStep: 1, summary } });
	const collapsedText = collapsed.text();
	assert.match(collapsedText, /✓/);
	assert.match(collapsedText, /Folded steps 1–2/);
	assert.match(collapsedText, /Opening exchange/);

	// Expanded render: full summary body.
	const expandedText = h.render(result, { args: { fromStep: 1, summary }, expanded: true }).text();
	assert.match(expandedText, /Folded steps 1–2/);
	assert.match(expandedText, /Opening exchange/);
});

test("smoke: execute refuses to fold into the current or a missing step", async () => {
	const h = await createHarness();
	await h.start();

	await assert.rejects(h.execute({ fromStep: 3, summary: "fold myself" }), /Step 3 is the step you are in/);
	await assert.rejects(h.execute({ fromStep: 9, summary: "nonexistent" }), /There is no step 9/);
	await assert.rejects(h.execute({ fromStep: 1, summary: "   " }), /The summary is empty/);
	assert.equal(h.pi.appended.length, 0, "no fold record on refused folds");
});

test("smoke: dmail-disabled flag turns folding off for the session", async () => {
	const h = await createHarness();
	h.pi.setFlag("dmail-disabled", true);
	await h.start();

	await assert.rejects(h.execute({ fromStep: 1, summary: "anything" }), /D-Mail is disabled/);
	assert.equal(h.pi.appended.length, 0);
});

test("fake UI records calls and returns scripted selections, values, and cancels", async () => {
	const ui = createFakeUi();

	ui.scriptSelect("alpha");
	ui.scriptInput(CANCEL);
	ui.scriptConfirm(true);

	assert.equal(await ui.ui.select("Pick", ["alpha", "beta"]), "alpha");
	assert.equal(await ui.ui.input("Name"), undefined);
	assert.equal(await ui.ui.confirm("Sure?", "really?"), true);

	assert.equal(ui.selects.length, 1);
	assert.deepEqual(ui.selects[0], { title: "Pick", options: ["alpha", "beta"] });
	assert.equal(ui.inputs.length, 1);
	assert.equal(ui.confirms.length, 1);

	// Unscripted interaction fails loudly rather than silently cancelling.
	await assert.rejects(ui.ui.select("Unscripted", []), /no scripted response/);
});

test("fixture builders chain ids and build compaction boundaries", async () => {
	const fx = new SessionFixture();
	const u1 = fx.user("hi");
	const a1 = fx.assistant("hello");
	const compaction = fx.compaction({ summary: "earlier work", firstKeptEntryId: a1.id });
	fx.user("next");
	const fold = fx.foldRecord({ fromEntryId: u1.id, toEntryId: a1.id, summary: "s", fromStep: 1 });

	assert.deepEqual(
		fx.entries.map((e) => e.id),
		["e1", "e2", "e3", "e4", "e5"],
	);
	assert.equal(fx.entries[1].parentId, "e1");
	assert.equal(compaction.type, "compaction");
	assert.equal(fold.type, "custom");
	assert.ok(fx.entries.every((e, i) => i === 0 || Date.parse(e.timestamp) >= Date.parse(fx.entries[i - 1].timestamp)));
});

test("harness: the session view starts at a compaction boundary and folds see it", async () => {
	const fixture = threeStepSession(); // e1..e6, steps 1–3
	const compaction = fixture.compaction({ summary: "earlier work", firstKeptEntryId: "e5" }); // e7
	const h = await createHarness({ fixture });

	// Real buildContextEntries(): compaction first, then kept entries, dropping e1–e4.
	assert.deepEqual(
		h.ctx.sessionManager.buildContextEntries().map((e) => e.id),
		[compaction.id, "e5", "e6"],
	);

	await h.start();
	// Steps behind the boundary are gone from view, so the fold tool refuses them…
	await assert.rejects(h.execute({ fromStep: 1, summary: "gone" }), /already been folded out of view/);
	// …while the surviving step is still listable.
	await assert.rejects(h.execute({ fromStep: 9, summary: "nope" }), /Visible steps: \[3\]/);
	assert.equal(h.pi.appended.length, 0, "no fold record on refused folds");
});

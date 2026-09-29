/**
 * `/dmail fold` acceptance tests (ticket 07), driven through the extension
 * boundary like pi would: the user owns the cut point, the agent owns the prose.
 *
 * The picker runs off the replayed view — visible steps plus collapsed rows for
 * already-folded regions — and selecting a row pins only the START. The pinned
 * start reaches the agent through the standard prompt path (plain when idle,
 * `{deliverAs:"followUp"}` when the agent is busy), `/send-dmail` is an alias
 * of the same command, and cancelling and headless sessions change nothing.
 *
 * The TUI path is pi's `ui.custom` (a scrollable /tree-style component); fake-ui
 * records the component so tests can read the rows and the rendered lines
 * without a live terminal. Missing `custom` falls back to `ui.select`; missing
 * interactive UI falls back to a printed list.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FoldPickerComponent } from "../picker-ui.ts";
import type { FoldPickerRow } from "../picker.ts";
import { assertFoldDetails, CANCEL, createHarness, SessionFixture } from "./harness/index.ts";

/** The pinned prompt as text, whatever type sendUserMessage recorded. */
function messageText(content: unknown): string {
	return typeof content === "string" ? content : JSON.stringify(content);
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

/** Five visible steps; step 2 already folded — the picker must collapse it. */
function foldedFiveStepSession(): SessionFixture {
	const fx = new SessionFixture();
	fx.user("q1");
	fx.assistant("alpha one — the goal and the constraints decided there");
	fx.user("q2");
	fx.assistant("alpha two — the venue is booked\nsecond line of step two");
	fx.user("q3");
	fx.assistant("alpha three — travel arranged");
	fx.user("q4");
	fx.assistant("alpha four — invitations sent\nsecret second line");
	fx.user("q5");
	fx.assistant("alpha five — replies pending");
	fx.foldRecord({ fromEntryId: "e4", toEntryId: "e6", summary: "Venue booked: the hall.", fromStep: 2 });
	return fx;
}

/** First `/dmail fold` with a cancel: records the component without pinning anything. */
async function captureRows(h: Harness): Promise<FoldPickerRow[]> {
	h.ui.scriptCustom(CANCEL);
	await h.runCommand("dmail", "fold");
	return [...(h.ui.customs[0].component as FoldPickerComponent).rows];
}

test("the picker lists every finished step with role, peek and a quiet ~Nk estimate, region collapsed", async () => {
	const h = await createHarness({ fixture: foldedFiveStepSession() });
	await h.start();

	const labels = (await captureRows(h)).map((row) => row.label);

	assert.deepEqual(
		labels.map((label) => label.split("  ")[0]),
		["1", "[2]", "3", "4"],
		"one row per visible step, the folded step collapsed to its bracketed range",
	);
	for (const label of labels) {
		assert.match(label, / ~\+?\d[\d.]*k?$/, `row carries a quiet ~Nk estimate: ${label}`);
	}
	assert.match(labels[0], /^1  assistant: alpha one — the goal and the constraints decided there  ~/);
	assert.match(labels[1], /^\[2\]  fold: Venue booked: the hall\.  ~/, "the region row peeks at its summary");
	assert.match(labels[3], /^4  assistant: alpha four — invitations sent  ~/);
	assert.ok(!labels[3].includes("secret second line"), "preview is the first line only");

	// What the TUI actually renders: title, legend, cursor, position footer.
	const lines = (h.ui.customs[0].component as FoldPickerComponent).render(120).join("\n");
	assert.match(lines, /Fold from which step/, "title");
	assert.match(lines, /latest finished step/, "legend: the end resolves to the latest finished step");
	assert.match(lines, /~ ≈ tokens this cut removes/, "legend explains the quiet estimate");
	assert.match(lines, /› /, "cursor marks the selected row");
	assert.match(lines, /\(1\/4\)/, "position footer");

	// Cancelling changes nothing.
	assert.equal(h.pi.sentMessages.length, 0, "cancel sends no prompt");
	assert.equal(h.pi.appended.length, 0, "cancel appends no fold record");
	assert.match(h.ui.notifications.at(-1)?.message ?? "", /Cancelled — nothing was folded/);
});

test("picking a row pins only the start and delivers it through the prompt path", async () => {
	const h = await createHarness({ fixture: foldedFiveStepSession() });
	await h.start();

	h.ui.scriptCustom(1);
	await h.runCommand("dmail", "fold");

	assert.equal(h.pi.sentMessages.length, 1, "one pinned prompt to the agent");
	const { content, options: msgOptions } = h.pi.sentMessages[0];
	assert.match(messageText(content), /pinned the cut point: fold from step 1 through step 4/, "start pinned, end is the latest finished step");
	assert.match(messageText(content), /send_dmail\(fromStep=1/, "the agent folds from exactly the pinned step");
	assert.match(messageText(content), /folded on their behalf/, "the agent confirms the fold to the user");
	assert.equal(msgOptions?.deliverAs, undefined, "idle agent → plain send");
	assert.match(h.ui.notifications.at(-1)?.message ?? "", /Pinned step 1/, "the command acknowledges the choice");
});

test("picking a collapsed folded-region row is a legal start", async () => {
	const h = await createHarness({ fixture: foldedFiveStepSession() });
	await h.start();

	h.ui.scriptCustom(2); // the "[2]  fold: …" row
	await h.runCommand("dmail", "fold");

	assert.equal(h.pi.sentMessages.length, 1);
	assert.match(messageText(h.pi.sentMessages[0].content), /fold from step 2 through step 4/);
	assert.match(h.ui.notifications.at(-1)?.message ?? "", /Pinned step 2/);

	// …and the fold tool accepts that pinned start: the agent can really fold from it.
	const result = await h.execute({
		fromStep: 2,
		summary: "Venue booked: the hall; travel and invitations follow.",
	});
	assertFoldDetails(result, { fromStep: 2, throughStep: 4, fromEntryId: "e4", toEntryId: "e10" });
	assert.match(
		h.ui.notifications.at(-1)?.message ?? "",
		/^Folded steps 2–4\. In effect from the next request\. Folded on your behalf/,
		"the confirmation names the pinned start",
	);
});

test("a busy agent gets the pinned start through the follow-up delivery variant", async () => {
	const h = await createHarness({ fixture: foldedFiveStepSession(), idle: false });
	await h.start();

	await h.runCommand("dmail", "fold 3");

	assert.equal(h.pi.sentMessages[0].options?.deliverAs, "followUp");
	assert.match(h.ui.notifications.at(-1)?.message ?? "", /finishes the current turn/);
	assert.equal(h.ui.customs.length, 0, "an explicit start never opens the picker");
});

test("without an interactive UI the printed list still lets the user pin a start", async () => {
	const h = await createHarness({ fixture: foldedFiveStepSession() });
	await h.start();
	(h.ctx as { hasUI?: boolean }).hasUI = false; // json/print mode: headless

	await h.runCommand("dmail", "fold");

	const printed = h.ui.notifications.at(-1)?.message ?? "";
	assert.match(printed, /pin a start with \/dmail fold <step>/);
	assert.match(printed, /· \[2\]  fold: Venue booked: the hall\./, "the fallback list is the same row set");
	assert.match(printed, /· 4  assistant: alpha four — invitations sent/);
	assert.equal(h.pi.sentMessages.length, 0, "the printed list itself pins nothing");

	await h.runCommand("dmail", "fold 2");
	assert.equal(h.pi.sentMessages.length, 1, "an explicit start pins without any picker");
	assert.match(messageText(h.pi.sentMessages[0].content), /fold from step 2 through step 4/);
});

test("with ui.select but no ui.custom (rpc-style) the plain list still pins", async () => {
	const h = await createHarness({ fixture: foldedFiveStepSession() });
	await h.start();
	delete (h.ctx.ui as { custom?: unknown }).custom;

	h.ui.scriptSelect(CANCEL);
	await h.runCommand("dmail", "fold");
	assert.equal(h.ui.selects.length, 1, "falls back to ui.select");
	assert.match(h.ui.selects[0].title, /Fold from which step/);
	assert.match(h.ui.selects[0].title, /tokens this cut removes/, "the plain fallback carries the legend too");
	const options = h.ui.selects[0].options;
	assert.deepEqual(
		options.map((option) => option.split("  ")[0]),
		["1", "[2]", "3", "4"],
		"the plain list shows the same rows",
	);

	h.ui.scriptSelect(options[0]);
	await h.runCommand("dmail", "fold");
	assert.equal(h.pi.sentMessages.length, 1, "picking from the plain list pins");
	assert.match(messageText(h.pi.sentMessages[0].content), /fold from step 1 through step 4/);
});

test("a bad fold argument fails loudly and pins nothing", async () => {
	const h = await createHarness({ fixture: foldedFiveStepSession() });
	await h.start();

	await h.runCommand("dmail", "fold x");
	assert.match(h.ui.notifications.at(-1)?.message ?? "", /"x" is not a step number/);
	assert.equal(h.pi.sentMessages.length, 0);

	await h.runCommand("dmail", "fold 9");
	assert.match(h.ui.notifications.at(-1)?.message ?? "", /There is no step 9 to fold from/);
	assert.equal(h.pi.sentMessages.length, 0);
});

test("the agent folds from exactly the pinned step and the user is told", async () => {
	const h = await createHarness({ fixture: foldedFiveStepSession() });
	await h.start();

	await captureRows(h); // open once, as a user would
	h.ui.scriptCustom(1); // pin step 1
	await h.runCommand("dmail", "fold");

	// The agent authors the summary and performs the fold itself.
	const summary = "Goal and constraints, venue booked, travel, invitations.";
	const result = await h.execute({ fromStep: 1, summary });
	assertFoldDetails(result, { fromStep: 1, throughStep: 4, fromEntryId: "e2", toEntryId: "e10" });
	assert.equal(h.pi.appended.length, 1);
	assert.equal((h.pi.appended[0].data as { fromStep?: number }).fromStep, 1);

	assert.ok(
		h.ui.notifications.some(
			(n) =>
				n.message ===
				"Folded steps 1–4. In effect from the next request. Folded on your behalf from the step you pinned.",
		),
		"the user gets confirmation that the context was folded on their behalf",
	);
});

test("/send-dmail is an alias of /dmail fold: same picker, same pin path", async () => {
	const h = await createHarness({ fixture: foldedFiveStepSession() });
	await h.start();

	// Capture the row list through /dmail fold, then prove /send-dmail opens it.
	const foldRows = await captureRows(h);

	h.ui.scriptCustom(CANCEL);
	await h.runCommand("send-dmail");
	assert.deepEqual(
		[...(h.ui.customs[1].component as FoldPickerComponent).rows],
		[...foldRows],
		"the alias opens the identical picker",
	);
	assert.equal(h.pi.sentMessages.length, 0, "cancel through the alias changes nothing");

	// Picking through /send-dmail pins the same start via the same prompt path.
	h.ui.scriptCustom(1);
	await h.runCommand("send-dmail");
	assert.equal(h.pi.sentMessages.length, 1);
	assert.match(
		messageText(h.pi.sentMessages[0].content),
		/pinned the cut point: fold from step 1 through step 4/,
	);
	assert.equal(h.pi.sentMessages[0].options?.deliverAs, undefined, "idle → plain send");
	assert.match(h.ui.notifications.at(-1)?.message ?? "", /Pinned step 1/);
});

test("/send-dmail pins an explicit start without a picker; busy → followUp", async () => {
	const h = await createHarness({ fixture: foldedFiveStepSession(), idle: false });
	await h.start();

	// Errors and hints name the command that was actually typed.
	await h.runCommand("send-dmail", "x");
	assert.match(h.ui.notifications.at(-1)?.message ?? "", /Try \/send-dmail 2\./);
	assert.equal(h.pi.sentMessages.length, 0);

	await h.runCommand("send-dmail", "3");

	assert.equal(h.pi.sentMessages.length, 1);
	assert.equal(h.pi.sentMessages[0].options?.deliverAs, "followUp", "busy agent → followUp delivery");
	assert.match(messageText(h.pi.sentMessages[0].content), /fold from step 3 through step 4/);
	assert.match(h.ui.notifications.at(-1)?.message ?? "", /finishes the current turn/);
});

test("/send-dmail shares /dmail fold's guards", async () => {
	const h = await createHarness({ fixture: foldedFiveStepSession() });
	h.pi.setFlag("dmail-disabled", true);
	await h.start();

	await h.runCommand("send-dmail");
	assert.match(h.ui.notifications.at(-1)?.message ?? "", /D-Mail is off, so there is nothing to fold/);
	assert.equal(h.pi.sentMessages.length, 0, "a refused alias pins nothing");
});

test("a tool-call step previews like /tree: <tool_name>: <params>", async () => {
	const fx = new SessionFixture();
	fx.user("q1");
	fx.assistant("alpha one — first step");
	fx.user("q2");
	fx.toolCall("Bash", { command: "ls -la" });
	fx.user("q3");
	fx.assistant("alpha three — last step");
	const h = await createHarness({ fixture: fx });
	await h.start();

	const labels = (await captureRows(h)).map((row) => row.label);
	assert.deepEqual(
		labels.map((label) => label.split("  ")[0]),
		["1", "2"],
		"the step you are in is never a row",
	);
	assert.ok(
		labels[1].startsWith('2  assistant: Bash: {"command":"ls -la"}'),
		`the tool-call step carries its call instead of a blank peek: ${labels[1]}`,
	);
});

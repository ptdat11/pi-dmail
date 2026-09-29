/**
 * The hybrid compaction seam (ticket 08), driven through the harness like pi would.
 *
 * Pi documents `session_before_compact`'s *return* value only: a handler may
 * cancel the compaction or supply its own summary (`SessionBeforeCompactResult`).
 * Everything else a handler can do rides the same mutable `preparation` object
 * pi's own summarizer reads after the handlers run — that undocumented half is
 * where the splice lives.
 *
 * These tests pin *our side only* (spec, testing decisions): the guidance
 * channel mutated exactly as specified, every other field pi prepared left
 * byte-identical, and nothing returned so pi's default summarizer still runs.
 * They never assert how pi compacts internally — that would be re-testing pi's
 * contract as if it were ours. A pi upgrade that changes the shape we rely on
 * fails loudly twice: `tsc -p tsconfig.typecheck.json` against pi's real types
 * (the fixture below is typed `SessionBeforeCompactEvent`; index.ts's handler is
 * typed through pi's `on()` overload, which only accepts pi's literal event
 * names), and these runtime assertions.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import { createHarness, type Harness, SessionFixture } from "./harness/index.ts";

type Preparation = SessionBeforeCompactEvent["preparation"];
/** pi's message type, taken from the preparation itself — the contract we depend on. */
type PreparationMessage = Preparation["messagesToSummarize"][number];

/** The one-line instruction the splice prefixes (spec wording, pinned here). */
const INSTRUCTION = "Fold summaries may omit details; the raw messages below are authoritative.";

/** The era's two summaries, in order, as the channel must present them. */
const S1 = "S1: the third exchange";
const S2 = "S2: the fourth exchange";
const PRIOR = "prior compaction summary";

/**
 * A session with a compaction boundary in it:
 *
 *   e1–e7   old era, steps 1–3; one fold record (holder e5) written before the boundary
 *   e8      compaction, firstKeptEntryId "e6" → the current era starts at e6
 *   e9–e14  new era: two fold records (holders e11, e14) written after the boundary
 *
 * The boundary record's firstKeptEntryId ("e6") is deliberately *not* the
 * preparation's own firstKeptEntryId ("e10", pi's next cut): the era starts
 * where the last compaction kept, not where the next one will. A test can pass
 * a stale boundary id to exercise the conservative fallback.
 */
function seamSession(boundary: string = "e6"): SessionFixture {
	const fx = new SessionFixture();
	fx.user("first question"); // e1
	fx.assistant("first answer"); // e2   step 1
	fx.user("second question"); // e3
	fx.assistant("second answer"); // e4   step 2
	fx.foldRecord({ fromEntryId: "e2", toEntryId: "e4", summary: "old-era fold: steps 1-2" }); // e5, pre-boundary
	fx.user("third question"); // e6
	fx.assistant("third answer"); // e7   step 3
	fx.compaction({ summary: PRIOR, firstKeptEntryId: boundary }); // e8
	fx.user("fourth question"); // e9
	fx.assistant("fourth answer"); // e10  step 4
	fx.foldRecord({ fromEntryId: "e7", toEntryId: "e10", summary: S1 }); // e11
	fx.user("fifth question"); // e12
	fx.assistant("fifth answer"); // e13  step 5
	fx.foldRecord({ fromEntryId: "e10", toEntryId: "e13", summary: S2 }); // e14
	return fx;
}

function userMsg(text: string): PreparationMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

/**
 * A preparation as pi hands it to the hook: raw material list, turn-prefix
 * material, token estimate, file-op bookkeeping (Sets), boundary, settings —
 * everything the seam must leave alone. `previousSummary` is added per test.
 */
function barePreparation(): Preparation {
	return {
		firstKeptEntryId: "e10",
		messagesToSummarize: [userMsg("raw message pi is about to summarize")],
		turnPrefixMessages: [userMsg("raw turn prefix material")],
		isSplitTurn: false,
		tokensBefore: 48_000,
		fileOps: {
			read: new Set<string>(["src/old.ts"]),
			written: new Set<string>(["src/new.ts"]),
			edited: new Set<string>(),
		},
		settings: { enabled: true, reserveTokens: 4_000, keepRecentTokens: 8_000 },
	};
}

/**
 * Fire the compaction hook once, exactly as pi would, and assert our side of
 * the contract on the way out: nothing returned (no cancel, no supplied
 * summary), custom instructions passed through, and the branch read but never
 * written.
 */
async function runSeam(h: Harness, preparation: Preparation): Promise<void> {
	const event: SessionBeforeCompactEvent = {
		type: "session_before_compact",
		preparation,
		branchEntries: h.fixture.entries,
		customInstructions: "one line per finding",
		reason: "threshold",
		willRetry: false,
		signal: new AbortController().signal,
	};
	const branchBefore = structuredClone(event.branchEntries);

	const [result] = (await h.dispatch("session_before_compact", event, h.ctx)) as [
		SessionBeforeCompactResult | undefined,
	];

	assert.equal(result, undefined, "no cancel and no supplied summary — pi's default summarizer runs");
	assert.equal(event.customInstructions, "one line per finding", "pi's custom instructions pass through untouched");
	assert.deepEqual(event.branchEntries, branchBefore, "the branch is read, never written");
}

test("the seam splices the era's fold summaries into the prior-summary channel, chronological", async () => {
	const h = await createHarness({ fixture: seamSession() });
	await h.start();

	assert.ok(
		h.pi.hooks.has("session_before_compact"),
		"a handler is registered under pi's pre-compaction event name",
	);

	const preparation: Preparation = { ...barePreparation(), previousSummary: PRIOR };
	const before = structuredClone(preparation);

	await runSeam(h, preparation);

	assert.equal(
		preparation.previousSummary,
		[INSTRUCTION, PRIOR, S1, S2].join("\n\n"),
		"instruction first, then pi's prior summary, then the era's summaries in chronological order",
	);
	const channel = preparation.previousSummary;
	assert.ok(
		channel !== undefined && !channel.includes("old-era fold"),
		"a fold held before the boundary is out of the era and stays out of the channel",
	);

	// Everything else pi prepared is untouched: raw material list, turn-prefix
	// material, token estimate, file-op bookkeeping (Sets included), and the
	// boundary itself.
	assert.deepEqual(
		{ ...preparation, previousSummary: null },
		{ ...before, previousSummary: null },
		"only previousSummary changes; every other prepared field is byte-identical",
	);
});

test("with no prior summary, the channel is created from the fold summaries alone", async () => {
	const h = await createHarness({ fixture: seamSession() });
	await h.start();

	const preparation = barePreparation(); // no previousSummary yet
	const before = structuredClone(preparation);

	await runSeam(h, preparation);

	assert.equal(
		preparation.previousSummary,
		[INSTRUCTION, S1, S2].join("\n\n"),
		"created if absent: instruction, then the chronological chain",
	);
	assert.deepEqual(
		{ ...preparation, previousSummary: null },
		{ ...before, previousSummary: null },
		"creating the channel still touches nothing else",
	);
});

test("a session with no folds leaves the channel exactly as pi would have left it", async () => {
	const h = await createHarness(); // default session: no compaction, no folds
	await h.start();

	const withPrior: Preparation = { ...barePreparation(), previousSummary: PRIOR };
	const withPriorBefore = structuredClone(withPrior);
	await runSeam(h, withPrior);
	assert.deepEqual(withPrior, withPriorBefore, "channel byte-identical to what pi handed in");

	const withoutPrior = barePreparation(); // no channel yet
	const withoutPriorBefore = structuredClone(withoutPrior);
	await runSeam(h, withoutPrior);
	assert.deepEqual(withoutPrior, withoutPriorBefore, "absent stays absent: no instruction, no empty channel");
});

test("a re-fold that superseded an earlier summary splices the replacement, not the superseded originals", async () => {
	const fx = seamSession();
	// S3 reaches back to S1's start (e7) and through S2's (e10): coverage
	// suppression collapses the whole era chain to S3 alone.
	fx.foldRecord({ fromEntryId: "e7", toEntryId: "e13", summary: "S3: steps 3-4 re-folded" }); // e15
	const h = await createHarness({ fixture: fx });
	await h.start();

	const preparation: Preparation = { ...barePreparation(), previousSummary: PRIOR };
	await runSeam(h, preparation);

	assert.equal(
		preparation.previousSummary,
		[INSTRUCTION, PRIOR, "S3: steps 3-4 re-folded"].join("\n\n"),
		"the seam replays (not lists): S1 and S2 are suppressed by S3's range",
	);
});

test("with folding disabled for the session, compaction sees exactly what pi prepared", async () => {
	const h = await createHarness({ fixture: seamSession() });
	h.pi.setFlag("dmail-disabled", true);
	await h.start();

	const preparation: Preparation = { ...barePreparation(), previousSummary: PRIOR };
	const before = structuredClone(preparation);

	await runSeam(h, preparation);

	assert.deepEqual(preparation, before, "disabled is a decision: the channel is left exactly as pi left it");
});

test("fold records that exist but fall outside the era never reach the channel", async () => {
	const fx = seamSession();
	// Drop the era's two fold records: the branch still carries a fold record
	// (the pre-boundary one), just none the current era can replay.
	for (const id of ["e14", "e11"]) {
		const at = fx.entries.findIndex((entry) => entry.id === id);
		assert.ok(at >= 0, `fixture holds ${id}`);
		fx.entries.splice(at, 1);
	}
	const h = await createHarness({ fixture: fx });
	await h.start();

	const preparation: Preparation = { ...barePreparation(), previousSummary: PRIOR };
	const before = structuredClone(preparation);

	await runSeam(h, preparation);

	assert.deepEqual(
		preparation,
		before,
		"records exist but none replay in this era: the channel is left exactly as pi left it",
	);
});

test("a stale compaction boundary falls back without leaking pre-boundary material", async () => {
	// The kept entry id points somewhere no longer in the branch: the era must
	// fall back to entries after the boundary record, never before it.
	const h = await createHarness({ fixture: seamSession("e-vanished") });
	await h.start();

	const preparation: Preparation = { ...barePreparation(), previousSummary: PRIOR };
	await runSeam(h, preparation);

	// In the fallback era, S1's holder (e11) survives but its range starts
	// before the boundary (e7), so it can never splice; S2 lives entirely
	// inside, and the pre-boundary record stays out as well.
	assert.equal(
		preparation.previousSummary,
		[INSTRUCTION, PRIOR, S2].join("\n\n"),
		"conservative era: only material wholly after the boundary record is spliced",
	);
});

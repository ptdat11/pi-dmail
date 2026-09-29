/**
 * Unit tests for the fold algebra in `fold.ts`.
 *
 * Everything here drives `foldContext` with plain strings: `convert` emits the
 * entry id, `summaryMessage` emits `<summary-name>`, and `beforeEntry` emits the
 * `[step N]` marker. The rendered list is then asserted literally, because the
 * shape of the output — what appears, in what order, with which marker — is the
 * whole contract.
 *
 * The properties under test are the re-fold rules: a newer fold whose range
 * contains an older fold's start replaces that summary, an overlap without
 * containment keeps both, a same-start re-fold means newest wins, and suppressed
 * records never take a summary with them.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	foldContext,
	numberSteps,
	planReplay,
	wrapSummary,
	type FoldOptions,
	type FoldRecord,
	type FoldResult,
	type LocatedFold,
} from "../fold.ts";

/** One transcript node. `step` marks assistant messages (step boundaries); `tool` marks their results. */
interface Entry {
	id: string;
	kind: "user" | "step" | "tool";
}

const user = (id: string): Entry => ({ id, kind: "user" });
const step = (id: string): Entry => ({ id, kind: "step" });
const tool = (id: string): Entry => ({ id, kind: "tool" });

/**
 * A four-step ladder with tool results:
 *
 *   idx 0 u1 | 1 a1 | 2 r1 | 3 u2 | 4 a2 | 5 r2 | 6 u3 | 7 a3 | 8 r3 | 9 u4 | 10 a4
 *
 * Steps 1–3 are foldable; a4 is the step you are in.
 */
function ladder(): Entry[] {
	return [
		user("u1"),
		step("a1"),
		tool("r1"),
		user("u2"),
		step("a2"),
		tool("r2"),
		user("u3"),
		step("a3"),
		tool("r3"),
		user("u4"),
		step("a4"),
	];
}

const rec = (fromEntryId: string, toEntryId: string, summary: string, fromStep?: number): FoldRecord => ({
	fromEntryId,
	toEntryId,
	summary,
	...(fromStep === undefined ? {} : { fromStep }),
});

/** Branch numbering as index.ts derives it: a1→1, a2→2, a3→3, a4→4. */
function branchSteps(entries: Entry[] = ladder()): Map<string, number> {
	const map = new Map<string, number>();
	numberSteps(entries, (entry) => entry.kind === "step").forEach((s) => map.set(s.entryId, s.step));
	return map;
}

/** Replay entries through the algebra with the wiring the context hook uses. */
function run(entries: Entry[], folds: FoldRecord[], stepOf: Map<string, number> = branchSteps()): FoldResult<string> {
	const options: FoldOptions<Entry, string> = {
		convert: (entry) => [entry.id],
		summaryMessage: (_wrapped, fold) => `<${fold.summary}>`,
		beforeEntry: (entry) => {
			const step = stepOf.get(entry.id);
			return step === undefined ? undefined : `[step ${step}]`;
		},
		isStepStart: (entry) => entry.kind === "step",
	};
	return foldContext(entries, folds, options);
}

/** The rendered message list — what every ordering assertion asserts against. */
function render(entries: Entry[], folds: FoldRecord[], stepOf: Map<string, number> = branchSteps()): string[] {
	return run(entries, folds, stepOf).messages;
}

/** Entry ids that survived the fold, recovered from the rendered messages. */
function keptIds(messages: readonly string[], entries: Entry[]): Set<string> {
	const ids = new Set(entries.map((entry) => entry.id));
	return new Set(messages.filter((message) => ids.has(message)));
}

/**
 * The pairing invariant: an assistant and the tool results that answer it are
 * kept or dropped together — never one without the other.
 */
function assertPaired(entries: Entry[], folds: FoldRecord[]): void {
	const kept = keptIds(render(entries, folds), entries);
	for (let i = 0; i < entries.length; i++) {
		if (entries[i].kind !== "step") continue;
		let j = i + 1;
		while (j < entries.length && entries[j].kind === "tool") j++;
		const stepKept = kept.has(entries[i].id);
		for (let k = i + 1; k < j; k++) {
			assert.equal(
				kept.has(entries[k].id),
				stepKept,
				`assistant ${entries[i].id} and result ${entries[k].id} must be kept or dropped together`,
			);
		}
	}
}

test("canonical ladder: a re-fold from S2's step replaces S2 and S3, keeps S1", () => {
	// Before the re-fold the view is (S1, S2, S3, Raw): three adjacent folds.
	const before = [rec("a1", "a2", "S1", 1), rec("a2", "a3", "S2", 2), rec("a3", "a4", "S3", 3)];
	assert.deepEqual(render(ladder(), before), [
		"u1",
		"[step 1]",
		"<S1>",
		"[step 2]",
		"<S2>",
		"[step 3]",
		"<S3>",
		"[step 4]",
		"a4",
	]);

	// Re-folding from S2's step through the end: (S1, S2′) — one summary where
	// the newer range contains an older start, one marker per surviving summary.
	const after = [...before, rec("a2", "a4", "S2 prime", 2)];
	assert.deepEqual(render(ladder(), after), ["u1", "[step 1]", "<S1>", "[step 2]", "<S2 prime>", "[step 4]", "a4"]);
});

test("a partial re-fold keeps summaries the newer range does not contain", () => {
	// Same start as the canonical re-fold, but stopping at a3: S3's start lies
	// outside the newer range, so it stays.
	const folds = [
		rec("a1", "a2", "S1", 1),
		rec("a2", "a3", "S2", 2),
		rec("a3", "a4", "S3", 3),
		rec("a2", "a3", "S2 prime", 2),
	];
	assert.deepEqual(render(ladder(), folds), [
		"u1",
		"[step 1]",
		"<S1>",
		"[step 2]",
		"<S2 prime>",
		"[step 3]",
		"<S3>",
		"[step 4]",
		"a4",
	]);
});

test("overlap without containment renders both summaries unchanged", () => {
	// The re-fold starts inside the older fold's region but does not reach back
	// to the older start, so nothing is suppressed.
	const folds = [rec("a1", "a4", "S1", 1), rec("a3", "a4", "S3", 3)];
	assert.deepEqual(render(ladder(), folds), ["u1", "[step 1]", "<S1>", "[step 3]", "<S3>", "[step 4]", "a4"]);
	assertPaired(ladder(), folds);
});

test("a re-fold whose start is inside an older region still renders both", () => {
	// The tool-level scenario from the ticket: fold steps 1–2, then re-fold from
	// step 2. The older start (step 1) is not contained by [step 2, end), so both
	// summaries survive.
	const folds = [rec("a1", "a3", "S1", 1), rec("a2", "a4", "S2 prime", 2)];
	assert.deepEqual(render(ladder(), folds), [
		"u1",
		"[step 1]",
		"<S1>",
		"[step 2]",
		"<S2 prime>",
		"[step 4]",
		"a4",
	]);
	assertPaired(ladder(), folds);
});

test("same start: the newest summary wins", () => {
	const folds = [rec("a1", "a3", "S1", 1), rec("a1", "a3", "S1 prime", 1)];
	assert.deepEqual(render(ladder(), folds), [
		"u1",
		"[step 1]",
		"<S1 prime>",
		"[step 3]",
		"a3",
		"r3",
		"u4",
		"[step 4]",
		"a4",
	]);
});

test("a re-fold from an earlier step swallows the summaries it contains", () => {
	// Records arrive newest-last; a later record starting earlier still wins over
	// every start inside its range.
	const folds = [rec("a2", "a4", "S2", 2), rec("a1", "a4", "S1", 1)];
	assert.deepEqual(render(ladder(), folds), ["u1", "[step 1]", "<S1>", "[step 4]", "a4"]);
});

test("a skipped record never suppresses a valid one", () => {
	const folds = [
		rec("a1", "a2", "S1", 1),
		rec("a1", "a2", "   "), // blank summary
		rec("ghost", "a2", "S"), // start not in context
		rec("a1", "ghost", "S"), // end not in context
		rec("a2", "a1", "S"), // end not after start
		rec("a1", "r1", "S"), // start not a step boundary
		rec("r1", "a3", "S"), // end not a step boundary
	];
	const result = run(ladder(), folds);

	assert.deepEqual(result.applied, [folds[0]], "only the valid record took effect");
	assert.deepEqual(
		result.skipped.map((s) => s.why).sort(),
		[
			"blank-summary",
			"end-not-a-step-boundary",
			"end-not-after-start",
			"end-not-in-context",
			"start-not-a-step-boundary",
			"start-not-in-context",
		],
	);
	assert.deepEqual(result.messages, [
		"u1",
		"[step 1]",
		"<S1>",
		"[step 2]",
		"a2",
		"r2",
		"u3",
		"[step 3]",
		"a3",
		"r3",
		"u4",
		"[step 4]",
		"a4",
	]);
});

test("markers show the fold's original step number; numbers never renumber", () => {
	// Branch numbering with gaps (an earlier step left the view under compaction):
	// the marker comes from the branch, not from the position in the rendered list.
	const stepOf = new Map([
		["a1", 1],
		["a2", 3],
		["a3", 4],
		["a4", 5],
	]);
	// The record's own fromStep (3) agrees with the branch map, as the tool writes
	// it; the marker still comes from the map, not from the position in the list.
	assert.deepEqual(render(ladder(), [rec("a2", "a4", "S2", 3)], stepOf), [
		"u1",
		"[step 1]",
		"a1",
		"r1",
		"u2",
		"[step 3]",
		"<S2>",
		"[step 5]",
		"a4",
	]);
});

test("numberSteps numbers step starts in branch order", () => {
	assert.deepEqual(numberSteps(ladder(), (entry) => entry.kind === "step"), [
		{ step: 1, entryId: "a1", index: 1 },
		{ step: 2, entryId: "a2", index: 4 },
		{ step: 3, entryId: "a3", index: 7 },
		{ step: 4, entryId: "a4", index: 10 },
	]);
});

test("a record anchored on a tool result is refused, not honoured", () => {
	const entries = ladder();
	const folds = [rec("r1", "a3", "split"), rec("a1", "r2", "split")];
	const result = run(entries, folds);
	assert.deepEqual(
		result.skipped.map((s) => s.why),
		["start-not-a-step-boundary", "end-not-a-step-boundary"],
	);
	assert.equal(result.applied.length, 0, "neither record took effect");
});

test("every acceptance fold set keeps assistants paired with their tool results", () => {
	const entries = ladder();
	const sets: FoldRecord[][] = [
		[rec("a1", "a2", "S1", 1), rec("a2", "a3", "S2", 2), rec("a3", "a4", "S3", 3), rec("a2", "a4", "S2p", 2)],
		[rec("a1", "a3", "S1", 1), rec("a2", "a4", "S2p", 2)],
		[rec("a1", "a4", "S1", 1)],
		[rec("a1", "a3", "S1", 1), rec("a1", "a3", "S1 prime", 1)],
		[],
	];
	for (const folds of sets) assertPaired(entries, folds);
});

test("replay is idempotent and reports what took effect", () => {
	const folds = [rec("a1", "a2", "S1", 1), rec("a2", "a4", "S2", 2)];
	const first = render(ladder(), folds);
	const second = render(ladder(), folds);
	assert.deepEqual(second, first);

	const result = run(ladder(), folds);
	// Suppressed records still took effect: their range is folded away even when
	// their summary is replaced.
	assert.deepEqual(result.applied, folds);
	assert.deepEqual(result.skipped, []);
});

test("changed is true only when the output differs from a plain conversion", () => {
	const plain = { convert: (entry: Entry) => [entry.id], summaryMessage: () => "<S>" };
	assert.equal(foldContext(ladder(), [], plain).changed, false, "no folds, no markers: untouched");
	assert.equal(foldContext(ladder(), [rec("a1", "a2", "S1")], plain).changed, true, "a fold rewrites the view");

	// With step markers wired in, the view always differs — markers are the feature.
	const marked = { ...plain, beforeEntry: (entry: Entry) => `[${entry.id}]` };
	assert.equal(foldContext(ladder(), [], marked).changed, true, "markers alone count as changed");
});

test("wrapSummary trims and wraps in the stable tags", () => {
	assert.equal(wrapSummary("  padded  "), "<summary>\npadded\n</summary>");
});

// ---------------------------------------------------------------------------
// Orphan skips: records written before the boundary of the last compaction.
// The era check runs on the record's *holder*, so a record whose endpoints are
// still in view cannot slip across the boundary and fold the current era.
// ---------------------------------------------------------------------------

/** A record paired with the id of the session entry that holds it. */
const held = (holderEntryId: string, from: string, to: string, summary: string, fromStep?: number): LocatedFold => ({
	holderEntryId,
	...rec(from, to, summary, fromStep),
});

const planOpts = { isStepStart: (entry: Entry) => entry.kind === "step" };

test("a record held outside the era is counted, never replayed", () => {
	// The holder left the view with the last compaction, but both endpoints are
	// still in the view — without the era check this orphan would fold the ladder
	// it has no business touching.
	const orphan = held("gone", "a1", "a4", "written before the compaction", 1);
	const live = held("r3", "a1", "a2", "still in era", 1);

	const plan = planReplay(ladder(), [orphan, live], planOpts);
	assert.deepEqual(plan.inEra, [live], "only in-era records may reach replay");
	assert.deepEqual(plan.skipped, [{ fold: orphan, why: "record-out-of-era" }], "and the orphan is counted");

	// Counted ≠ rendered: replaying the in-era records shows nothing of the orphan.
	assert.ok(!render(ladder(), plan.inEra).some((line) => line.includes("written before the compaction")));
});

test("in-era records that fail validation are counted too", () => {
	const blank = held("r3", "a1", "a2", "   ");
	const plan = planReplay(ladder(), [blank], planOpts);
	assert.deepEqual(plan.inEra, [], "a blank summary takes no effect");
	assert.deepEqual(plan.skipped, [{ fold: blank, why: "blank-summary" }]);
});

test("an all-valid, all-in-era set skips nothing", () => {
	const folds = [held("r3", "a1", "a2", "S1", 1), held("r3", "a2", "a4", "S2", 2)];
	const plan = planReplay(ladder(), folds, planOpts);
	assert.equal(plan.inEra.length, 2);
	assert.equal(plan.skipped.length, 0, "N = 0: nothing to report");
});

test("planning is deterministic and never rewrites a record", () => {
	const folds = [held("gone", "a1", "a4", "orphan", 1), held("r3", "a1", "a2", "S1", 1)];
	const snapshot = JSON.parse(JSON.stringify(folds));

	const first = planReplay(ladder(), folds, planOpts);
	const second = planReplay(ladder(), folds, planOpts);
	assert.deepEqual(second, first, "the same session plans to the same split and the same count");
	assert.equal(second.skipped.length, 1);
	assert.deepEqual(folds, snapshot, "records are append-only: never mutated, never dropped");
});

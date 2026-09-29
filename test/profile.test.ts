/**
 * Tests for the offline D-Mail profiler.
 *
 * The session is synthetic so the numbers are checkable by hand: two large
 * assistant steps, a fold that replaces the first one, and a final request that
 * must show the saving. The point is not the exact constants but the shape —
 * no-fold requests never gain, a marker costs a little, and an applied fold
 * saves the folded content minus the summary.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { analyzeSession, listSessions, renderScore, renderSummary, resolveSessionPath, scoreSessions, sessionDirForCwd } from "../profile.ts";

const BIG = "x".repeat(4000); // ~1000 estimated tokens at chars/4

interface BuildOptions {
	/** Insert a dmail.fold record after step 2, replacing step 1. */
	withFold?: boolean;
	/** Omit usage.cost to exercise the "provider reported no cost" path. */
	withCost?: boolean;
	/** Uncached input tokens reported at the fold-start request (default 100). */
	foldStartInput?: number;
	/** Ticket-04 predicted economics recorded on the fold record. */
	predicted?: Record<string, unknown>;
	/** Place the fold record after the last request: declared but never applied. */
	foldAtEnd?: boolean;
}

/** Fixed provider rates ($/M tokens) so a session's implied rates are checkable by hand. */
const RATES = { input: 0.1, cacheRead: 0.001, output: 0.2 };

function costFor(input: number, cacheRead: number, output: number): Record<string, number> {
	const total = input * RATES.input + cacheRead * RATES.cacheRead + output * RATES.output;
	return {
		input: (input * RATES.input) / 1e6,
		cacheRead: (cacheRead * RATES.cacheRead) / 1e6,
		cacheWrite: 0,
		output: (output * RATES.output) / 1e6,
		total: total / 1e6,
	};
}

function entry(id: string, parentId: string | null, timestamp: string, extra: Record<string, unknown>): string {
	return JSON.stringify({ id, parentId, timestamp, ...extra });
}

function assistant(
	id: string,
	parentId: string | null,
	timestamp: string,
	input: number,
	cacheRead: number,
	withCost = true,
): string {
	return entry(id, parentId, timestamp, {
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: BIG }],
			api: "test",
			provider: "test",
			model: "test-model",
			usage: {
				input,
				output: 10,
				cacheRead,
				cacheWrite: 0,
				totalTokens: input + cacheRead + 10,
				...(withCost ? { cost: costFor(input, cacheRead, 10) } : {}),
			},
			stopReason: "stop",
			timestamp: Date.parse(timestamp),
		},
	});
}

function buildSession(options: BuildOptions = {}): string {
	const withCost = options.withCost ?? true;
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: "sess-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" }),
		entry("u1", null, "2026-01-01T00:00:01.000Z", {
			type: "message",
			message: { role: "user", content: BIG, timestamp: Date.parse("2026-01-01T00:00:01.000Z") },
		}),
		assistant("a1", "u1", "2026-01-01T00:00:02.000Z", 100, 0, withCost),
		entry("t1", "a1", "2026-01-01T00:00:03.000Z", {
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: BIG }],
				isError: false,
				timestamp: Date.parse("2026-01-01T00:00:03.000Z"),
			},
		}),
		assistant("a2", "t1", "2026-01-01T00:00:04.000Z", 100, 1000, withCost),
	];
	const foldRecord = () =>
		entry("f1", options.foldAtEnd ? "a3" : "a2", options.foldAtEnd ? "2026-01-01T00:00:08.000Z" : "2026-01-01T00:00:05.000Z", {
			type: "custom",
			customType: "dmail.fold",
			data: {
				fromEntryId: "a1",
				toEntryId: "a2",
				summary: "folded step one",
				fromStep: 1,
				...(options.predicted ? { predicted: options.predicted } : {}),
			},
		});
	const foldsEarly = options.withFold && !options.foldAtEnd;
	if (foldsEarly) lines.push(foldRecord());
	lines.push(
		entry("u2", foldsEarly ? "f1" : "a2", "2026-01-01T00:00:06.000Z", {
			type: "message",
			message: { role: "user", content: BIG, timestamp: Date.parse("2026-01-01T00:00:06.000Z") },
		}),
		assistant("a3", "u2", "2026-01-01T00:00:07.000Z", options.foldStartInput ?? 100, 2000, withCost),
	);
	if (options.withFold && options.foldAtEnd) lines.push(foldRecord());
	return `${lines.join("\n")}\n`;
}

// --- Ticket 06: fold scoring -------------------------------------------------
// A fold carrying ticket-04 predictions must come back with a measured
// counter-side computed from the recorded requests: the leave-one-out marginal
// (rebuild the request without this fold) valued at the prediction's own cache
// ratio, so predicted and measured are priced like-for-like. Read-only:
// nothing here writes back.

const PREDICTED = { removedTokens: 2000, savingsPerRequestTokens: 20, rebuildTokens: 80, breakEvenRequests: 4 };

test("fold scoring: predicted carried through, actual measured from usage", async () => {
	const profile = await analyzeSession(buildSession({ withFold: true, predicted: PREDICTED }));
	const fold = profile.folds[0];

	assert.deepEqual(fold.predicted, PREDICTED);
	// The fold renders for exactly one request (the final one).
	assert.equal(fold.measuredRequests, 1);
	assert.ok(fold.actual, "measured actual expected for an applied fold");
	// Marginal ≈ archive (2000) − summary (~9) ≈ 1991; bounded because the real
	// pi estimator may differ from the local chars/4 port.
	assert.ok(
		(fold.actual?.removedTokens ?? 0) >= 1700 && (fold.actual?.removedTokens ?? 0) <= 2200,
		`removedTokens ${fold.actual?.removedTokens} outside 1700–2200`,
	);
	// savings = removed × cacheRatio, with the ratio inverted from the recorded
	// prediction itself (20/2000 = 0.01) — never from the session's live prices.
	assert.ok(
		Math.abs((fold.actual?.savingsPerRequestTokens ?? -1) - (fold.actual?.removedTokens ?? 0) * 0.01) <= 0.5,
		"savings must be removedTokens × the prediction's cache ratio",
	);
	assert.equal(fold.actual?.measuredAt, "2026-01-01T00:00:07.000Z");
});

test("fold scoring: a fold without a recorded prediction is not measured", async () => {
	const profile = await analyzeSession(buildSession({ withFold: true }));
	const fold = profile.folds[0];
	assert.equal(fold.predicted, null);
	assert.equal(fold.actual, null);
	assert.equal(fold.measuredRequests, 0);
});

test("fold scoring: without usage cost the fold still scores identically", async () => {
	const profile = await analyzeSession(buildSession({ withFold: true, withCost: false, predicted: PREDICTED }));
	assert.equal(profile.cost, null);
	const fold = profile.folds[0];
	assert.ok(fold.actual, "removal is estimator-based and measurable without cost");
	assert.ok((fold.actual?.removedTokens ?? 0) >= 1700, `removedTokens ${fold.actual?.removedTokens}`);
	// Pricing comes from the prediction's own cache ratio, not from usage
	// rates — a session without usage.cost scores exactly like one with it.
	assert.ok(
		Math.abs((fold.actual?.savingsPerRequestTokens ?? -1) - (fold.actual?.removedTokens ?? 0) * 0.01) <= 0.5,
		"savings priced from the prediction basis without any cost rates",
	);
	assert.equal(fold.measuredRequests, 1);
});

test("fold scoring: a fold that never took effect has no measurement", async () => {
	const profile = await analyzeSession(buildSession({ withFold: true, foldAtEnd: true, predicted: PREDICTED }));
	const fold = profile.folds[0];
	assert.deepEqual(fold.predicted, PREDICTED);
	assert.equal(fold.effectiveAtRequest, null);
	assert.equal(fold.actual, null);
	assert.equal(fold.measuredRequests, 0);
});

test("aggregate score answers retire vs keep from recorded sessions", async () => {
	// Measured ≈ 20/req matches the recorded prediction exactly → retire.
	const retire = scoreSessions([
		await analyzeSession(buildSession({ withFold: true, predicted: PREDICTED }), "retire.jsonl"),
	]);
	assert.equal(retire.sessions, 1);
	assert.equal(retire.scoredFolds, 1);
	assert.equal(retire.comparedFolds, 1);
	assert.equal(retire.verdict, "retire");
	assert.match(renderScore(retire), /RETIRE the OCC gate/);
	assert.match(renderScore(retire), /retire\.jsonl/);

	// A prediction claiming 10× the removal lands at 10% accuracy → keep.
	// Pricing is inverted from the prediction itself (200/20000 = 0.01, the
	// same basis as the honest one), so only the removal claim differs.
	const keep = scoreSessions([
		await analyzeSession(
			buildSession({ withFold: true, predicted: { ...PREDICTED, removedTokens: 20_000, savingsPerRequestTokens: 200 } }),
			"keep.jsonl",
		),
	]);
	assert.equal(keep.verdict, "keep");
	assert.ok(Math.abs((keep.accuracy ?? 0) - 0.1) < 0.01, `accuracy ${keep.accuracy}`);
	assert.match(renderScore(keep), /KEEP the OCC gate/);
});

test("single-session summary prints the fold scoring section", async () => {
	const profile = await analyzeSession(buildSession({ withFold: true, predicted: PREDICTED }), "s.jsonl");
	const summary = renderSummary(profile);
	assert.match(summary, /Fold scoring/);
	assert.match(summary, /predicted [\d,]+ removed · 20\/req/);
	assert.match(summary, /measured [\d,]+ removed · 20\/req over 1 request/);
	assert.match(summary, /\(100\.0% of predicted\)/);

	// Sessions without predictions never show the section.
	const plain = renderSummary(await analyzeSession(buildSession({ withFold: true })));
	assert.doesNotMatch(plain, /Fold scoring/);
});

test("session without folds: folding only costs the step markers", async () => {
	const profile = await analyzeSession(buildSession({ withFold: false }));

	assert.equal(profile.requests.length, 3);
	assert.equal(profile.totals.folds, 0);
	assert.equal(profile.totals.foldsApplied, 0);

	// Request 1 is the very first assistant message: its prompt has no assistant
	// step yet, so there is no marker and the two views are identical.
	assert.equal(profile.requests[0].saved, 0);

	// Request 2 sees step 1's marker, which only D-Mail emits: a small loss.
	assert.ok(profile.requests[1].saved < 0, "marker should cost a little");

	// No fold anywhere, so nothing should ever claim a saving.
	for (const request of profile.requests) assert.ok(request.saved <= 0);

	// The dollar range stays ordered even when the saving itself is negative.
	const second = profile.requests[1];
	assert.ok((second.savedCostLow ?? 0) <= (second.savedCostHigh ?? 0));
	assert.ok((second.savedCostHigh ?? 0) < 0);

	// No folds means no fold economics to report.
	assert.equal(profile.economics, null);
});

test("an applied fold shows up as a real saving at the next request", async () => {
	const profile = await analyzeSession(buildSession({ withFold: true }));

	assert.equal(profile.requests.length, 3);
	assert.equal(profile.totals.folds, 1);
	assert.equal(profile.totals.foldsApplied, 1);

	const first = profile.requests[0];
	const second = profile.requests[1];
	const third = profile.requests[2];

	// The fold lands after step 2, so neither earlier request may see it — and a
	// fold that does not exist yet must never be counted as skipped.
	assert.equal(first.foldsActive, 0);
	assert.equal(second.foldsActive, 0);
	assert.equal(first.skippedFolds, 0);
	assert.equal(second.skippedFolds, 0);
	assert.equal(first.foldStarted, false);
	assert.equal(second.foldStarted, false);

	// The third request stands after the fold record and must apply it.
	assert.equal(third.foldsActive, 1);
	assert.equal(third.foldStarted, true);

	// The folded view drops step 1's assistant text and its tool result (roughly
	// 2000 tokens) and adds a short summary, so the saving is large and positive.
	assert.ok(third.saved > 1000, `expected a large saving, got ${third.saved}`);
	assert.equal(profile.folds[0].effectiveAtRequest, 2);
	assert.equal(profile.folds[0].fromStep, 1);

	// Provider usage is reported verbatim next to the estimates.
	assert.equal(third.input, 100);
	assert.equal(third.cacheRead, 2000);
	assert.equal(third.actualPrompt, 2100);

	// Fold economics: one fold, one fold-start, baseline input = median of the
	// two non-fold-start requests (100), so this fold costs nothing above it.
	const e = profile.economics;
	assert.ok(e, "an applied fold must produce economics");
	assert.equal(e.foldStarts, 1);
	assert.equal(e.foldsApplied, 1);
	assert.equal(e.foldsPerStart, 1);
	assert.equal(e.baselineInput, 100);
	assert.equal(e.excessInput, 0);
	assert.equal(e.excessCost, 0);
	assert.equal(e.breakEvenRequests, 0);
	assert.ok(e.meanSaved !== null && e.meanSaved > 1000);
});

test("fold economics price a fold-start that paid above baseline", async () => {
	const profile = await analyzeSession(buildSession({ withFold: true, foldStartInput: 800 }));
	const e = profile.economics;
	assert.ok(e);

	// Baseline is still the median of the non-fold-start requests (100, 100);
	// the fold-start charged 800, so the re-prefill cost 700 tokens above it.
	assert.equal(e.baselineInput, 100);
	assert.equal(e.excessInput, 700);
	assert.ok(Math.abs((e.excessCost ?? 0) - (700 * RATES.input) / 1e6) < 1e-12);

	// The session saves >1000 tokens/request with the fold active, so the
	// re-prefill is repaid well within a single request.
	assert.ok(e.meanSaved !== null && e.meanSaved > 1000);
	assert.ok(e.breakEvenRequests !== null && e.breakEvenRequests > 0 && e.breakEvenRequests < 1);
});

test("json report is serializable and carries the totals", async () => {
	const profile = await analyzeSession(buildSession({ withFold: true }), "synthetic.jsonl");
	const roundTripped = JSON.parse(JSON.stringify(profile));

	assert.equal(roundTripped.sessionFile, "synthetic.jsonl");
	assert.equal(roundTripped.totals.requests, 3);
	assert.ok(roundTripped.totals.saved > 0);
	assert.equal(roundTripped.totals.foldsApplied, 1);
	assert.ok(roundTripped.economics, "economics must survive JSON round-trip");
	assert.equal(roundTripped.economics.foldStarts, 1);
});

test("usage.cost becomes marginal rates and a saved-dollar range", async () => {
	const profile = await analyzeSession(buildSession({ withFold: true }));
	const cost = profile.cost;
	assert.ok(cost, "the session reports cost");
	assert.equal(cost.reported, 3);

	// Rates are recovered from the session's own usage/cost pairs: 100 input and
	// 1000/2000 cacheRead tokens per request, at the fixed test rates.
	assert.ok(Math.abs((cost.rates.input ?? 0) - RATES.input) < 1e-9);
	assert.ok(Math.abs((cost.rates.cacheRead ?? 0) - RATES.cacheRead) < 1e-9);
	assert.ok(Math.abs((cost.rates.output ?? 0) - RATES.output) < 1e-9);
	// Blended prompt rate = prompt-side cost / prompt tokens (3300 here).
	assert.ok(Math.abs((cost.rates.blendedPrompt ?? 0) - (cost.promptSide / 3300) * 1e6) < 1e-9);

	// The saved-token range brackets the cached-prefix rate and the blended rate.
	assert.equal(cost.savedRates.low, cost.rates.cacheRead);
	assert.equal(cost.savedRates.high, cost.rates.blendedPrompt);
	assert.ok(Math.abs(cost.savedLow - (profile.totals.saved * cost.savedRates.low) / 1e6) < 1e-12);
	assert.ok(Math.abs(cost.savedHigh - (profile.totals.saved * cost.savedRates.high) / 1e6) < 1e-12);
	assert.ok(cost.savedLow < cost.savedHigh, "the range must not collapse");

	// The third request is the one the fold actually helps, in dollars too.
	assert.ok((profile.requests[2].savedCostLow ?? 0) > 0);
	assert.ok((profile.requests[2].savedCostHigh ?? 0) > (profile.requests[2].savedCostLow ?? 0));
});

test("a session without usage.cost reports no cost block", async () => {
	const profile = await analyzeSession(buildSession({ withCost: false }));
	assert.equal(profile.cost, null);
	assert.equal(profile.requests[0].cost, null);
	assert.equal(profile.requests[0].savedCostLow, null);
	assert.equal(profile.requests[0].savedCostHigh, null);
});

// ---------------------------------------------------------------------------
// Session discovery (--list)
// ---------------------------------------------------------------------------

test("sessionDirForCwd mirrors Pi's safePath encoding", async () => {
	const { sessionDirForCwd } = await import("../profile.ts");
	assert.equal(
		sessionDirForCwd("/home/user/project", "/agent"),
		join("/agent", "sessions", "--home-user-project--"),
	);
	// Colons (Windows drive letters) are part of Pi's unsafe set too.
	assert.equal(sessionDirForCwd("C:\\work\\app", "/agent"), join("/agent", "sessions", "--C--work-app--"));
});

test("listSessions finds a session, and --deep counts requests and folds", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "dmail-list-"));
	const cwd = "/tmp";
	const dir = sessionDirForCwd(cwd, agentDir);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "2026-01-01T00-00-00-000Z_sess-1.jsonl");
	writeFileSync(file, buildSession({ withFold: true }));

	// Shallow: header plus stat only, so the deep fields stay null.
	const shallow = await listSessions({ cwd, agentDir });
	assert.equal(shallow.length, 1);
	assert.equal(shallow[0].cwd, cwd);
	assert.equal(shallow[0].sessionId, "sess-1");
	assert.equal(shallow[0].requests, null);
	assert.equal(shallow[0].folds, null);

	// Deep: the active branch holds 3 assistant requests and 1 fold record.
	const deep = await listSessions({ cwd, agentDir, deep: true });
	assert.equal(deep.length, 1);
	assert.equal(deep[0].requests, 3);
	assert.equal(deep[0].folds, 1);
	assert.equal(deep[0].actualPrompt, 3300);
	assert.equal(Math.round(deep[0].cacheHitPct ?? 0), 91);

	// Query is a case-insensitive substring over cwd, id and file name; a
	// non-matching query searches everywhere and finds nothing.
	assert.equal((await listSessions({ cwd, agentDir, query: "SESS-1" })).length, 1);
	assert.equal((await listSessions({ cwd, agentDir, query: "no-such-session" })).length, 0);

	// all:true walks every project directory under the sessions root.
	assert.equal((await listSessions({ cwd: "/somewhere/else", agentDir, all: true, deep: true })).length, 1);

	rmSync(agentDir, { recursive: true, force: true });
});

test("listSessions returns nothing for an unknown project instead of throwing", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "dmail-list-"));
	assert.deepEqual(await listSessions({ cwd: "/nope", agentDir }), []);
	assert.deepEqual(await listSessions({ cwd: "/nope", agentDir, deep: true, query: "x" }), []);
	rmSync(agentDir, { recursive: true, force: true });
});

// ============================================================================
// Session resolution: the CLI should not force anyone to retype Pi's on-disk
// layout. These use the same shape Pi writes: <ts>_<session-id>.jsonl inside a
// project directory named after the working directory.
// ============================================================================

interface Fixture {
	agentDir: string;
	dir: string;
	/** Write a session and return its path. */
	write: (sessionId: string) => string;
}

function fixture(): Fixture {
	const agentDir = mkdtempSync(join(tmpdir(), "dmail-resolve-"));
	const dir = sessionDirForCwd("/tmp", agentDir);
	mkdirSync(dir, { recursive: true });
	return {
		agentDir,
		dir,
		write: (sessionId: string) => {
			const file = join(dir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
			writeFileSync(file, buildSession().replace('"id":"sess-1"', `"id":${JSON.stringify(sessionId)}`));
			return file;
		},
	};
}

test("resolveSessionPath accepts a bare session id prefix", async () => {
	const { agentDir, write } = fixture();
	const file = write("01a0a7b8-00a4-74a0-8efb-ca527b007cf4");

	const byPrefix = await resolveSessionPath("01a0a7b8", { agentDir });
	assert.equal(byPrefix.ok, true);
	assert.equal(byPrefix.ok && byPrefix.file, file);
	assert.match(byPrefix.ok ? (byPrefix.note ?? "") : "", /resolved/);

	// A full id and a full file name are exact matches too.
	assert.equal((await resolveSessionPath("01a0a7b8-00a4-74a0-8efb-ca527b007cf4", { agentDir })).ok, true);
	assert.equal((await resolveSessionPath("2026-01-01T00-00-00-000Z_01a0a7b8-00a4-74a0-8efb-ca527b007cf4.jsonl", { agentDir })).ok, true);

	rmSync(agentDir, { recursive: true, force: true });
});

test("resolveSessionPath accepts paths relative to the sessions root", async () => {
	const { agentDir, dir, write } = fixture();
	const file = write("01a0a7b8-00a4-74a0-8efb-ca527b007cf4");
	const project = file.slice(file.indexOf("sessions") + "sessions/".length);

	for (const relative of [project, project.slice(project.indexOf("/") + 1), `./${project}`]) {
		const resolution = await resolveSessionPath(relative, { agentDir });
		assert.equal(resolution.ok, true, `expected ${relative} to resolve`);
		assert.equal(resolution.ok && resolution.file, file);
	}

	// A real path is taken literally and never fuzzy-matched.
	const direct = await resolveSessionPath(file, { agentDir });
	assert.equal(direct.ok && direct.file, file);
	assert.equal(direct.ok ? direct.note : "note", null);

	rmSync(agentDir, { recursive: true, force: true });
});

test("resolveSessionPath reports ambiguity and misses instead of guessing", async () => {
	const { agentDir, write } = fixture();
	write("aaaaaaaa-1111-74a0-8efb-ca527b007cf4");
	write("aaaaaaaa-2222-74a0-8efb-ca527b007cf4");

	const ambiguous = await resolveSessionPath("aaaaaaaa", { agentDir });
	assert.equal(ambiguous.ok, false);
	assert.equal(ambiguous.ok ? "" : ambiguous.reason, "ambiguous");
	assert.equal(ambiguous.ok ? 0 : ambiguous.candidates.length, 2);
	assert.match(ambiguous.ok ? "" : ambiguous.message, /matches 2 sessions/);

	// A longer, unique prefix resolves the same pair.
	assert.equal((await resolveSessionPath("aaaaaaaa-1111", { agentDir })).ok, true);

	const missing = await resolveSessionPath("no-such-session", { agentDir });
	assert.equal(missing.ok ? "" : missing.reason, "not-found");
	assert.deepEqual(missing.ok ? [] : missing.candidates, []);

	// Too short to be meaningful, and not a file, so it is refused outright.
	const short = await resolveSessionPath("ab", { agentDir });
	assert.equal(short.ok ? "" : short.reason, "too-short");

	rmSync(agentDir, { recursive: true, force: true });
});

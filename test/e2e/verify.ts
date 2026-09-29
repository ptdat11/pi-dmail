#!/usr/bin/env node
/**
 * End-to-end seam verification (ticket 09) — hand-runnable, not a unit test.
 *
 * Runs a real local `pi --mode rpc` process with no network: fixture-provider.ts
 * registers a keyless mock provider, and this script drives pi through
 *
 *   1. two ordinary prompts, the second answered by a real `send_dmail` tool
 *      call, so the fixture session's fold record is written by pi itself;
 *   2. a real `compact`, whose summarization request pi's own code builds;
 *
 * and then asserts that the compaction summary derives from the fold summaries:
 * the folded narrative survives, the detail the fold dropped does not, and the
 * captured request proves the seam (not luck) is why. Clear PASS/FAIL per
 * assertion, exit 0 only when every assertion holds.
 *
 * Run it with `npm run verify:e2e` or `make verify-e2e`. It is deliberately NOT part
 * of `npm test` / CI: it needs an installed `pi` binary and drives a subprocess.
 */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DROPPED_DETAIL,
	FOLD_NARRATIVE,
	FOLD_TRIGGER,
	MODEL_ID,
	PROVIDER_ID,
} from "./fixture-provider.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const FIXTURE_ENTRY = join(here, "fixture-provider.ts");
const DMAIL_ENTRY = join(repoRoot, "index.ts");
const PI_BIN = process.env.PI_BIN ?? "pi";
const START_TIMEOUT_MS = 60_000;
const RUN_TIMEOUT_MS = 90_000;

// pi's session schema (docs/session-format.md): fold records are custom entries
// typed "dmail.fold"; compaction entries are top-level type "compaction".
const FOLD_TYPE_MARKER = '"dmail.fold"';
const COMPACTION_TYPE_MARKER = '"type":"compaction"';

type RpcRecord = { type: string; [key: string]: unknown };

/** Parse pi's JSONL, skipping malformed lines instead of throwing. */
function parseJsonl<T>(text: string): T[] {
	const records: T[] = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			records.push(JSON.parse(line) as T);
		} catch {
			// Malformed line: nothing useful to assert on it.
		}
	}
	return records;
}

/** Minimal JSONL client for `pi --mode rpc`: LF framing, id correlation. */
class Client {
	private child: ChildProcessWithoutNullStreams;
	private buffer = "";
	private nextId = 1;
	private readonly responses = new Map<string, (record: RpcRecord) => void>();
	private settled = false;
	private settledWaiters: (() => void)[] = [];
	private failure: string | undefined;
	readonly events: RpcRecord[] = [];
	stderr = "";

	constructor(child: ChildProcessWithoutNullStreams) {
		this.child = child;
		let stdoutBuffer = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBuffer += chunk.toString("utf8");
			let index = stdoutBuffer.indexOf("\n");
			while (index !== -1) {
				const line = stdoutBuffer.slice(0, index).replace(/\r$/, "");
				stdoutBuffer = stdoutBuffer.slice(index + 1);
				if (line.trim() !== "") this.dispatch(line);
				index = stdoutBuffer.indexOf("\n");
			}
		});
		child.stderr.on("data", (chunk: Buffer) => {
			this.stderr += chunk.toString("utf8");
		});
		// A dead pi (missing binary, crash) must fail in-flight commands fast
		// instead of leaving callers to hit the outer run timeout with no clue.
		const fail = (reason: string) => {
			if (this.failure) return;
			this.failure = reason;
			const pending = [...this.responses.values()];
			this.responses.clear();
			for (const resolvePending of pending) {
				resolvePending({ type: "response", success: false, error: reason });
			}
			const waiters = this.settledWaiters.splice(0);
			for (const waiter of waiters) waiter();
		};
		child.on("error", (error) => fail(`pi process error: ${error.message}`));
		child.on("exit", (code, signal) => fail(`pi exited unexpectedly (code ${code}, signal ${signal})`));
	}

	private dispatch(line: string): void {
		let record: RpcRecord;
		try {
			record = JSON.parse(line) as RpcRecord;
		} catch {
			return; // Diagnostics are on stderr; stdout stays protocol-only.
		}
		if (record.type === "response") {
			const id = typeof record.id === "string" ? record.id : "";
			const resolve = this.responses.get(id);
			if (resolve) {
				this.responses.delete(id);
				resolve(record);
			}
			return;
		}
		if (record.type === "agent_settled") {
			this.settled = true;
			const waiters = this.settledWaiters.splice(0);
			for (const waiter of waiters) waiter();
			return;
		}
		if (record.type === "extension_ui_request") {
			const method = String(record.method ?? "");
			// Fire-and-forget methods need no answer; dialogs would stall the
			// agent, so cancel them rather than leave pi waiting on a TUI.
			if (["select", "confirm", "input", "editor"].includes(method)) {
				this.write({ type: "extension_ui_response", id: record.id, cancelled: true });
			}
			return;
		}
		this.events.push(record);
	}

	private write(payload: RpcRecord): void {
		this.child.stdin.write(`${JSON.stringify(payload)}\n`);
	}

	/** Send a command, wait for its correlated response, return it. */
	async command(payload: RpcRecord): Promise<RpcRecord> {
		if (this.failure) return { type: "response", success: false, error: this.failure };
		const id = `req-${this.nextId++}`;
		const response = new Promise<RpcRecord>((resolvePromise) => {
			this.responses.set(id, resolvePromise);
		});
		try {
			this.write({ ...payload, id });
		} catch (error) {
			this.responses.delete(id);
			return { type: "response", success: false, error: `write failed: ${String(error)}` };
		}
		return response;
	}

	/** Send a prompt and wait until pi reports it will do no further work. */
	async prompt(message: string): Promise<void> {
		this.settled = false;
		const response = await this.command({ type: "prompt", message });
		if (response.success !== true) {
			throw new Error(`prompt rejected: ${String(response.error ?? "unknown error")}`);
		}
		await this.waitForSettled();
	}

	private waitForSettled(): Promise<void> {
		if (this.settled) return Promise.resolve();
		return new Promise<void>((resolvePromise) => {
			this.settledWaiters.push(resolvePromise);
		});
	}

	kill(): void {
		this.child.stdin.end();
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: NodeJS.Timeout;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

async function main(): Promise<number> {
	const work = await mkdtemp(join(tmpdir(), "dmail-e2e-"));
	const configDir = join(work, "config");
	const sessionDir = join(work, "sessions");
	const cwd = join(work, "cwd");
	const capturePath = join(work, "requests.jsonl");
	await mkdir(configDir, { recursive: true });
	await mkdir(sessionDir, { recursive: true });
	await mkdir(cwd, { recursive: true });
	// keepRecentTokens this small forces pi to cut the fixture session *before*
	// the folded-away step, so the summarizer really is offered the dropped
	// detail instead of the whole session sitting in the kept window.
	await writeFile(
		join(configDir, "settings.json"),
		`${JSON.stringify({ compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 50 } }, null, 2)}\n`,
	);
	await writeFile(capturePath, "");

	const args = [
		"--mode", "rpc",
		"--provider", PROVIDER_ID,
		"--model", MODEL_ID,
		"--session-dir", sessionDir,
		"--session-id", "e2e-seam",
		// Hermetic: no discovered extensions/skills/templates/context files,
		// only the two explicit -e paths below.
		"-ne", "-ns", "-np", "-nc",
		"-e", FIXTURE_ENTRY,
		"-e", DMAIL_ENTRY,
	];
	const child = spawn(PI_BIN, args, {
		cwd,
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: configDir,
			DMAIL_E2E_CAPTURE: capturePath,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	const client = new Client(child);
	const dead = new Promise<"dead">((resolvePromise) => {
		child.on("exit", () => resolvePromise("dead"));
		child.on("error", () => resolvePromise("dead"));
	});

	const checks: { name: string; ok: boolean; detail: string }[] = [];
	let failure: string | undefined;

	try {
		await withTimeout(
			(async () => {
				// Readiness: pi answers only once extensions (and the provider) are up.
				const state = await withTimeout(
					client.command({ type: "get_state" }),
					START_TIMEOUT_MS,
					"pi startup (get_state)",
				);
				if (state.success !== true) throw new Error(`get_state failed: ${String(state.error)}`);

				// 1. A real assistant turn carrying the detail that will be folded away.
				await client.prompt(
					`Say hello and record the fixture detail ${DROPPED_DETAIL} for the verification run.`,
				);

				// 2. A real send_dmail tool call, answered by pi's own tool path.
				await client.prompt(
					`Fold step 1 away right now with the send_dmail tool (fromStep 1) and your own summary. Do it. ${FOLD_TRIGGER}`,
				);

				// 3. A real compaction: pi builds the summarization request, the
				//    seam splices the era's fold summaries into it, the mock
				//    model answers the way pi's update prompt asks it to.
				const compact = await client.command({ type: "compact" });
				if (compact.success !== true) throw new Error(`compact failed: ${String(compact.error)}`);
				const summary = String((compact.data as Record<string, unknown> | undefined)?.summary ?? "");

				const sessionFile =
					String(((await client.command({ type: "get_state" })).data as Record<string, unknown>)?.sessionFile ?? "");

				// ---- assertions -------------------------------------------------
				const sessionText = sessionFile && existsSync(sessionFile) ? await readFile(sessionFile, "utf8") : "";
				type SessionLine = { data?: { summary?: string; fromEntryId?: string; toEntryId?: string } };
				const foldRecord = parseJsonl<SessionLine>(sessionText)
					.filter((entry) => JSON.stringify(entry).includes(FOLD_TYPE_MARKER))
					.find((entry) => entry.data?.summary?.includes(FOLD_NARRATIVE));
				checks.push({
					name: "fixture session carries a genuine dmail.fold record (written by pi's tool path)",
					ok: Boolean(foldRecord?.data?.fromEntryId && foldRecord.data.toEntryId),
					detail: foldRecord
						? `fromEntryId=${foldRecord.data?.fromEntryId} toEntryId=${foldRecord.data?.toEntryId}`
						: "no dmail.fold entry with the fold narrative found in " + (sessionFile || "no session file"),
				});

				const captured = parseJsonl<{ kind: string; text: string }>(await readFile(capturePath, "utf8"));
				const seamRequest = captured.find(
					(entry) => entry.kind === "summarization" && entry.text.includes("<previous-summary>"),
				);
				checks.push({
					name: "seam: the compaction request carries the fold summaries in <previous-summary>",
					ok: Boolean(seamRequest?.text.includes(FOLD_NARRATIVE)),
					detail: seamRequest
						? seamRequest.text.includes(FOLD_NARRATIVE)
							? "fold narrative present in the channel"
							: "channel present but fold narrative missing"
						: `no summarization request with <previous-summary> (captured ${captured.length} request(s): ${captured
								.map((entry) => entry.kind)
								.join(", ")})`,
				});
				checks.push({
					name: "control: the summarizer was offered the dropped detail in the raw conversation",
					ok: Boolean(seamRequest?.text.includes(DROPPED_DETAIL)),
					detail: !seamRequest
						? "no <previous-summary> request to evaluate the control on (see the seam assertion)"
						: seamRequest.text.includes(DROPPED_DETAIL)
							? "dropped detail present in the summarization input"
							: "dropped detail not in the summarization input — absence below would prove nothing",
				});
				checks.push({
					name: "compaction summary carries the folded narrative",
					ok: summary.includes(FOLD_NARRATIVE),
					detail: summary ? summary.slice(0, 400).replace(/\n/g, " ⏎ ") : "empty summary",
				});
				checks.push({
					name: "compaction summary omits the dropped detail",
					// Non-empty too: an empty summary would "omit" everything.
					ok: summary !== "" && !summary.includes(DROPPED_DETAIL),
					detail: summary === ""
						? "empty summary — absence would prove nothing"
						: summary.includes(DROPPED_DETAIL)
							? "dropped detail leaked into the summary"
							: "dropped detail absent from the summary",
				});

				const compactionEntry = parseJsonl<{ summary?: string }>(sessionText)
					.filter((entry) => JSON.stringify(entry).includes(COMPACTION_TYPE_MARKER))
					.pop();
				checks.push({
					name: "persisted compaction entry matches the reported summary",
					ok: Boolean(compactionEntry?.summary) &&
						compactionEntry?.summary === summary &&
						summary.includes(FOLD_NARRATIVE),
					detail: compactionEntry?.summary === summary && summary !== ""
						? "session file and compact response agree"
						: "compaction entry missing or differs from the compact response",
				});
			})(),
			RUN_TIMEOUT_MS,
			"the pi run",
		);
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}

	client.kill();
	const exited = await Promise.race([dead, new Promise<"alive">((r) => setTimeout(() => r("alive"), 5000))]);
	if (exited === "alive") child.kill("SIGKILL");

	const failed = checks.filter((check) => !check.ok);
	console.log("== dmail e2e: compaction seam verification ==");
	for (const check of checks) {
		console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name}`);
		console.log(`      ${check.detail}`);
	}
	if (failure) {
		console.log(`FAIL  run failed: ${failure}`);
	}
	if (failure || checks.length === 0) {
		console.log("\n--- pi stderr ---");
		console.log(client.stderr.slice(-4000) || "(empty)");
		console.log("\n--- pi events ---");
		console.log(client.events.map((event) => event.type).join(", ") || "(none)");
	}

	const ok = !failure && checks.length > 0 && failed.length === 0;
	console.log(`\nRESULT: ${ok ? "PASS" : "FAIL"} (${checks.length - failed.length}/${checks.length} assertions)`);
	console.log(`artifacts: ${work}${ok ? " (cleaned up)" : " (kept for inspection)"}`);
	if (ok) await rm(work, { recursive: true, force: true });
	return ok ? 0 : 1;
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});

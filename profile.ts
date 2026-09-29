/**
 * Offline context profiler for D-Mail.
 *
 * Reads one session JSONL file and, for every request that was actually made,
 * reports what the provider charged you (usage) next to what the context would
 * have been with and without folding. The comparison is exact where it can be:
 *
 *   - Measured: prompt size and cache split come straight from the persisted
 *     assistant `usage`, so they describe the request that really went out.
 *   - Reconstructed: the folded and raw message lists are rebuilt from the same
 *     branch with `foldContext` — the same pure function D-Mail itself uses — so
 *     the *difference* between them is the genuine effect of folding.
 *
 * "Raw" here means D-Mail disabled: no summaries and no `[step N]` markers,
 * which is exactly what the context hook sends when /dmail is off.
 *
 * What it cannot know: the system prompt and tool schemas are not stored in the
 * session file, and the estimator is a characters/4 heuristic, not the model's
 * real tokenizer. So the absolute estimate is deliberately short by two things:
 * unmodeled overhead (system prompt, tools, framing) and estimator error. Both
 * show up in `overhead` (actual − folded estimate). Treat the raw-vs-folded
 * delta as the trustworthy number, and `overhead` as a drift check: it should
 * not wander much across requests.
 *
 * Cost comes from the persisted `usage.cost`, and folded-away tokens are valued
 * with marginal rates derived from the same session's own usage/cost pairs, so
 * no price table is needed. The saving is a range, not a point, because the raw
 * counterfactual's cache behaviour cannot be observed: the low end charges the
 * extra tokens as a cached prefix, the high end at the session's blended prompt
 * rate. Output spend is unaffected by folding, so prompt-side spend is the
 * ceiling on any saving.
 *
 * Usage:
 *   node profile.ts <session.jsonl|session-id-prefix> [--last N] [--json] [--csv]
 *   node profile.ts --list [query] [--all] [--deep] [--json]
 *   node profile.ts --score [session...] [--all] [--json]
 *
 * A session argument that is not a readable file is resolved the friendly way:
 * a full path, a path relative to the sessions root
 * (`--proj--/<file>.jsonl`), or any unambiguous fragment of the session id.
 */
import { execSync } from "node:child_process";
import { closeSync, type Dirent, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	cacheRatioOf,
	type ActualEconomics,
	type PredictedEconomics,
} from "./economics.ts";
import { FOLD_TYPE, foldContext, numberSteps, type FoldRecord } from "./fold.ts";

// ============================================================================
// Optional Pi interop
//
// The extension runs inside Pi, where `@earendil-works/pi-coding-agent` is
// resolvable. A standalone `node profile.ts` invocation is not, so we locate the
// global install and import the real helpers, and fall back to faithful local
// ports if that fails. The real helpers keep the numbers identical to Pi's own
// context gauge; the ports keep the tool runnable with nothing installed.
// ============================================================================

/**
 * One parsed session entry: loose on every field but `id`, the key the fold
 * seam joins by (`foldContext`, `numberSteps`, `readFolds`' `recordId`) and that
 * Pi writes on every entry via `SessionEntryBase`. Raw JSON is still guarded at
 * the joins (`typeof entry.id === "string"`) — the header line has no id — so
 * pinning it here types the seam without pretending the parse is validated.
 */
type AnyEntry = Record<string, any> & { id: string };
type AnyMessage = Record<string, any>;

interface PiApi {
	parseSessionEntries?: (content: string) => AnyEntry[];
	buildContextEntries?: (entries: AnyEntry[], leafId: string | null, byId?: Map<string, AnyEntry>) => AnyEntry[];
	sessionEntryToContextMessages?: (entry: AnyEntry) => AnyMessage[];
	estimateTokens?: (message: AnyMessage) => number;
	calculateContextTokens?: (usage: AnyMessage) => number;
}

async function loadPi(): Promise<PiApi | undefined> {
	const candidates: string[] = [];
	const explicit = process.env.PI_CODING_AGENT_PACKAGE;
	if (explicit) candidates.push(explicit);
	try {
		const root = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		if (root) {
			candidates.push(
				pathToFileURL(join(root, "@earendil-works", "pi-coding-agent", "dist", "index.js")).href,
			);
		}
	} catch {
		// No global npm; the bare specifier below may still work inside a project.
	}
	candidates.push("@earendil-works/pi-coding-agent");
	for (const specifier of candidates) {
		try {
			return (await import(specifier)) as PiApi;
		} catch {
			// Try the next candidate.
		}
	}
	return undefined;
}

// ============================================================================
// Local ports (fallback only; see dist/core/session-manager.ts and
// dist/core/compaction/compaction.ts in the installed Pi package)
// ============================================================================

const ESTIMATED_IMAGE_CHARS = 4800;

function estimateTextAndImageContentChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const block of content) {
		if (block?.type === "text" && block.text) chars += block.text.length;
		else if (block?.type === "image") chars += ESTIMATED_IMAGE_CHARS;
	}
	return chars;
}

/** Pi's characters/4 heuristic, ported so numbers match without the package. */
function localEstimateTokens(message: AnyMessage): number {
	let chars = 0;
	switch (message.role) {
		case "user":
			return Math.ceil(estimateTextAndImageContentChars(message.content) / 4);
		case "assistant":
			for (const block of message.content ?? []) {
				if (block?.type === "text") chars += block.text.length;
				else if (block?.type === "thinking") chars += block.thinking.length;
				else if (block?.type === "toolCall") chars += block.name.length + JSON.stringify(block.arguments).length;
			}
			return Math.ceil(chars / 4);
		case "custom":
		case "toolResult":
			return Math.ceil(estimateTextAndImageContentChars(message.content) / 4);
		case "bashExecution":
			return Math.ceil((message.command.length + message.output.length) / 4);
		case "branchSummary":
		case "compactionSummary":
			return Math.ceil(message.summary.length / 4);
		default:
			return 0;
	}
}

function localEntryToMessages(entry: AnyEntry): AnyMessage[] {
	if (entry.type === "message") {
		const message = entry.message;
		if (
			(message.role === "user" || message.role === "assistant" || message.role === "toolResult") &&
			message.content == null
		) {
			return [{ ...message, content: [] }];
		}
		return [message];
	}
	if (entry.type === "custom_message") {
		return [
			{
				role: "custom",
				customType: entry.customType,
				content: entry.content ?? [],
				display: entry.display,
				details: entry.details,
				timestamp: Date.parse(entry.timestamp) || Date.now(),
			},
		];
	}
	if (entry.type === "branch_summary" && entry.summary) {
		return [
			{
				role: "branchSummary",
				summary: entry.summary,
				fromId: entry.fromId,
				timestamp: Date.parse(entry.timestamp) || Date.now(),
			},
		];
	}
	if (entry.type === "compaction") {
		return [
			{
				role: "compactionSummary",
				summary: entry.summary,
				tokensBefore: entry.tokensBefore,
				timestamp: Date.parse(entry.timestamp) || Date.now(),
			},
		];
	}
	return [];
}

function localParseSessionEntries(content: string): AnyEntry[] {
	const entries: AnyEntry[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// Skip malformed lines, same as Pi.
		}
	}
	return entries;
}

function localBranch(entries: AnyEntry[], leafId: string | null, byId: Map<string, AnyEntry>): AnyEntry[] {
	let leaf = leafId ? byId.get(leafId) : undefined;
	leaf ??= entries[entries.length - 1];
	if (!leaf) return [];
	const path: AnyEntry[] = [];
	let current: AnyEntry | undefined = leaf;
	while (current) {
		path.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return path.reverse();
}

function localBuildContextEntries(
	entries: AnyEntry[],
	leafId: string | null,
	byId: Map<string, AnyEntry>,
): AnyEntry[] {
	const path = localBranch(entries, leafId, byId);
	let compaction: AnyEntry | null = null;
	for (const entry of path) if (entry.type === "compaction") compaction = entry;
	if (!compaction) return path;
	const compactionIdx = path.findIndex((entry) => entry.id === compaction!.id);
	if (compactionIdx < 0) return path;
	const out = [compaction];
	let foundFirstKept = false;
	for (let i = 0; i < compactionIdx; i++) {
		const entry = path[i];
		if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
		if (foundFirstKept) out.push(entry);
	}
	out.push(...path.slice(compactionIdx + 1));
	return out;
}

// ============================================================================
// Reconstruction
// ============================================================================

interface FoldRecordWithId extends FoldRecord {
	/** The custom entry that carries this record, so a fold can be tracked over time. */
	recordId: string;
}

/**
 * Ticket-04 predictions are scored only if the two numbers scoring needs
 * exist. A malformed or partial prediction reads as "not recorded": the fold
 * still shows up (just unscored) rather than poisoning the arithmetic.
 */
function isPredictedEconomics(value: unknown): value is PredictedEconomics {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<PredictedEconomics>;
	return typeof candidate.removedTokens === "number" && typeof candidate.savingsPerRequestTokens === "number";
}

/**
 * Read `dmail.fold` entries, mirroring index.ts `readFolds` but keeping the id.
 * The record's persisted `actual` slot is deliberately ignored: it ships null
 * and stays null — sessions are append-only, so measured economics are
 * re-derived by the profiler for its report and never written back (06).
 */
function readFolds(entries: readonly AnyEntry[]): FoldRecordWithId[] {
	const folds: FoldRecordWithId[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== FOLD_TYPE) continue;
		const data = entry.data as Partial<FoldRecord> | undefined;
		if (!data) continue;
		if (typeof data.fromEntryId !== "string" || typeof data.toEntryId !== "string") continue;
		if (typeof data.summary !== "string") continue;
		folds.push({
			recordId: entry.id,
			fromEntryId: data.fromEntryId,
			toEntryId: data.toEntryId,
			summary: data.summary,
			fromStep: typeof data.fromStep === "number" ? data.fromStep : undefined,
			...(isPredictedEconomics(data.predicted) ? { predicted: data.predicted } : {}),
		});
	}
	return folds;
}

function isAssistantEntry(entry: AnyEntry): boolean {
	return entry.type === "message" && entry.message?.role === "assistant";
}

function userMessage(text: string, timestamp: number): AnyMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

interface MessageLists {
	folded: AnyMessage[];
	raw: AnyMessage[];
	activeFoldIds: string[];
	/** Folds whose summary was actually rendered this request (active minus suppressed). */
	renderedFoldIds: string[];
	skippedFolds: number;
}

/**
 * Build the two message lists for one request.
 *
 * `requestEntries` is the compaction-aware entry list as it stood when the
 * request was sent (everything up to the parent of the assistant message being
 * profiled). Folded keeps D-Mail's summaries and step markers; raw is the
 * no-D-Mail view: same messages, but no markers (markers are a D-Mail artifact)
 * and no folds.
 */
function buildMessageLists(
	requestEntries: readonly AnyEntry[],
	stepOfEntry: Map<string, number>,
	toMessages: (entry: AnyEntry) => AnyMessage[],
	folds: readonly FoldRecordWithId[],
): MessageLists {
	const marker = (entry: AnyEntry): AnyMessage | undefined => {
		const step = stepOfEntry.get(entry.id);
		return step === undefined ? undefined : userMessage(`[step ${step}]`, Date.parse(entry.timestamp) || Date.now());
	};

	const renderedFoldIds: string[] = [];
	const folded = foldContext<AnyEntry, AnyMessage>(requestEntries, folds, {
		convert: toMessages,
		summaryMessage: (text, fold) => {
			const recordId = (fold as FoldRecordWithId).recordId;
			if (typeof recordId === "string" && !renderedFoldIds.includes(recordId)) renderedFoldIds.push(recordId);
			return userMessage(text, Date.now());
		},
		beforeEntry: marker,
		isStepStart: isAssistantEntry,
	});
	const raw = foldContext<AnyEntry, AnyMessage>(requestEntries, [], {
		convert: toMessages,
		// Required by the seam's options but unreachable on this path: `folds` is
		// empty, so `summaryMessage` is never invoked (no record → no summary is
		// ever injected). It therefore does no `renderedFoldIds` bookkeeping — the
		// raw view must leave that untouched.
		summaryMessage: (text) => userMessage(text, Date.now()),
	});

	return {
		folded: folded.messages,
		raw: raw.messages,
		activeFoldIds: folded.applied.map((record) => (record as FoldRecordWithId).recordId),
		renderedFoldIds,
		skippedFolds: folded.skipped.length,
	};
}

// ============================================================================
// Session discovery
//
// Pi stores one JSONL per session under <agent-dir>/sessions/<encoded-cwd>/,
// where the directory name is the working directory with `/`, `\` and `:`
// replaced by `-` (mirroring Pi's own safePath). Reading the session header from
// the first line is enough to recover the real cwd, so listing stays cheap: only
// `--deep` parses whole files.
// ============================================================================

/** Pi's agent directory, honoring the same env override Pi itself uses. */
export function agentDirPath(): string {
	const explicit = process.env.PI_CODING_AGENT_DIR;
	if (explicit) return explicit.startsWith("~") ? join(homedir(), explicit.slice(1)) : resolve(explicit);
	return join(homedir(), ".pi", "agent");
}

/** Directory Pi keeps a given working directory's sessions in. */
export function sessionDirForCwd(cwd: string, agentDir = agentDirPath()): string {
	const safe = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(agentDir, "sessions", safe);
}

/** Read just the first chunk of a file, enough for the session header line. */
function readHead(file: string, bytes = 4096): string {
	const fd = openSync(file, "r");
	try {
		const buffer = Buffer.alloc(bytes);
		const read = readSync(fd, buffer, 0, bytes, 0);
		return buffer.subarray(0, read).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

export interface SessionSummary {
	file: string;
	/** Working directory the session ran in, from the session header. */
	cwd: string | null;
	sessionId: string | null;
	startedAt: string | null;
	modified: string;
	sizeBytes: number;
	/** Populated by `--deep` only; null means "not inspected". */
	requests: number | null;
	folds: number | null;
	actualPrompt: number | null;
	cacheHitPct: number | null;
}

/** Counts for the active branch without rebuilding any context (cheap). */
function lightCounts(entries: readonly AnyEntry[]): Pick<SessionSummary, "requests" | "folds" | "actualPrompt" | "cacheHitPct"> {
	const byId = new Map<string, AnyEntry>();
	for (const entry of entries) if (typeof entry.id === "string") byId.set(entry.id, entry);

	// Active branch: walk parent links back from the last identified entry.
	let cursor: AnyEntry | undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (typeof entries[i].id === "string") {
			cursor = entries[i];
			break;
		}
	}
	const seen = new Set<string>();
	let requests = 0;
	let folds = 0;
	let actualPrompt = 0;
	let cacheRead = 0;
	while (cursor && typeof cursor.id === "string" && !seen.has(cursor.id)) {
		seen.add(cursor.id);
		if (cursor.type === "custom" && cursor.customType === FOLD_TYPE) folds++;
		const usage = cursor.message?.usage;
		if (cursor.message?.role === "assistant" && usage && typeof usage.input === "number") {
			requests++;
			actualPrompt += (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
			cacheRead += usage.cacheRead ?? 0;
		}
		cursor = typeof cursor.parentId === "string" ? byId.get(cursor.parentId) : undefined;
	}
	return { requests, folds, actualPrompt, cacheHitPct: pct(cacheRead, actualPrompt) };
}

function readHeader(file: string): { cwd: string | null; sessionId: string | null; startedAt: string | null } {
	try {
		const firstLine = readHead(file).split("\n", 1)[0] ?? "";
		const header = JSON.parse(firstLine) as AnyEntry;
		return {
			cwd: typeof header.cwd === "string" ? header.cwd : null,
			sessionId: typeof header.id === "string" ? header.id : basename(file).replace(/\.jsonl$/, ""),
			startedAt: typeof header.timestamp === "string" ? header.timestamp : null,
		};
	} catch {
		return { cwd: null, sessionId: basename(file).replace(/\.jsonl$/, ""), startedAt: null };
	}
}

// ============================================================================
// Session resolution
//
// Naming a session should not require reproducing Pi's on-disk layout. Callers
// pass whatever they have -- a real path, a path relative to the sessions root,
// a file name, or just the first characters of the session id -- and get back
// one file, or the list of candidates that made it ambiguous.
// ============================================================================

/** Shortest fuzzy needle we accept, so "a" cannot match half the machine. */
const MIN_NEEDLE = 3;

type MatchStrength = "exact" | "prefix" | "contains";

const STRENGTH_ORDER: Record<MatchStrength, number> = { exact: 0, prefix: 1, contains: 2 };

export type SessionResolution =
	| { ok: true; file: string; note: string | null; alternatives: SessionSummary[] }
	| {
			ok: false;
			reason: "not-found" | "ambiguous" | "too-short";
			message: string;
			candidates: SessionSummary[];
		};

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/**
 * Turn a loose session reference into a real file path.
 *
 * Order: an existing path wins outright (never second-guessed), then the same
 * string interpreted relative to the sessions root, then fuzzy matching on the
 * session id and file name across every project. Only the strongest tier of
 * match is considered, so an exact id is never dragged down by a file name that
 * merely contains those characters.
 */
export async function resolveSessionPath(
	input: string,
	options: { cwd?: string; agentDir?: string } = {},
): Promise<SessionResolution> {
	const agentDir = options.agentDir ?? agentDirPath();

	if (isFile(input)) return { ok: true, file: resolve(input), note: null, alternatives: [] };

	const root = join(agentDir, "sessions");
	const rooted = join(root, input);
	if (isFile(rooted)) return { ok: true, file: rooted, note: null, alternatives: [] };

	const needle = basename(input).replace(/\.jsonl$/i, "").toLowerCase();
	if (needle.length < MIN_NEEDLE) {
		return {
			ok: false,
			reason: "too-short",
			message: `${JSON.stringify(input)} is not a session file, and fewer than ${MIN_NEEDLE} characters is too little to match a session id.`,
			candidates: [],
		};
	}

	const rows = await listSessions({ all: true, agentDir });
	const matches: { row: SessionSummary; strength: MatchStrength }[] = [];
	for (const row of rows) {
		const id = (row.sessionId ?? "").toLowerCase();
		const stem = basename(row.file).replace(/\.jsonl$/i, "").toLowerCase();
		let strength: MatchStrength | undefined;
		if (id === needle || stem === needle) strength = "exact";
		else if (id.startsWith(needle)) strength = "prefix";
		else if (stem.includes(needle)) strength = "contains";
		if (strength) matches.push({ row, strength });
	}

	if (matches.length === 0) {
		return { ok: false, reason: "not-found", message: `No session matches ${JSON.stringify(input)}.`, candidates: [] };
	}

	const bestStrength = Math.min(...matches.map((match) => STRENGTH_ORDER[match.strength]));
	const best = matches.filter((match) => STRENGTH_ORDER[match.strength] === bestStrength).map((match) => match.row);
	best.sort((a, b) => b.modified.localeCompare(a.modified));

	if (best.length > 1) {
		return {
			ok: false,
			reason: "ambiguous",
			message: `${JSON.stringify(input)} matches ${best.length} sessions. Give more of the session id.`,
			candidates: best.slice(0, 10),
		};
	}

	return { ok: true, file: best[0].file, note: `resolved ${JSON.stringify(input)} to ${best[0].file}`, alternatives: [] };
}

export interface ListOptions {
	/** Working directory whose project folder to list. Defaults to `process.cwd()`. */
	cwd?: string;
	/** List every project directory under the sessions root, not just one. */
	all?: boolean;
	/** Parse each session for request/fold/token counts. Slower. */
	deep?: boolean;
	/** Substring matched against cwd, session id and file name. */
	query?: string;
	agentDir?: string;
}

/**
 * Find session files. Shallow by default (header + stat only, so it stays fast
 * across large session trees); `deep` adds request/fold/usage counts.
 */
export async function listSessions(options: ListOptions = {}): Promise<SessionSummary[]> {
	const agentDir = options.agentDir ?? agentDirPath();
	const root = join(agentDir, "sessions");
	const cwd = options.cwd ?? process.cwd();
	const parseEntries = options.deep ? (await loadPi())?.parseSessionEntries ?? localParseSessionEntries : undefined;

	let dirs: string[];
	if (options.all) {
		// Annotated, not `ReturnType<typeof readdirSync>`: that resolves to the
		// buffer-encoding overload, typing `entry.name` as NonSharedBuffer when
		// this call (no `encoding`) actually returns Dirent<string>.
		let entries: Dirent<string>[];
		try {
			entries = readdirSync(root, { withFileTypes: true });
		} catch {
			return [];
		}
		dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
	} else {
		dirs = [sessionDirForCwd(cwd, agentDir)];
	}

	const summaries: SessionSummary[] = [];
	const query = options.query?.toLowerCase();

	for (const dir of dirs) {
		let files: string[];
		try {
			files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const name of files) {
			const file = join(dir, name);
			let stat: ReturnType<typeof statSync>;
			try {
				stat = statSync(file);
			} catch {
				continue;
			}
			const header = readHeader(file);
			const summary: SessionSummary = {
				file,
				...header,
				modified: stat.mtime.toISOString(),
				sizeBytes: stat.size,
				requests: null,
				folds: null,
				actualPrompt: null,
				cacheHitPct: null,
			};

			if (query) {
				const haystack = `${summary.cwd ?? ""} ${summary.sessionId ?? ""} ${name}`.toLowerCase();
				if (!haystack.includes(query)) continue;
			}

			if (options.deep && parseEntries) {
				try {
					Object.assign(summary, lightCounts(parseEntries(readFileSync(file, "utf8"))));
				} catch {
					/* unreadable or truncated: leave the deep fields null */
				}
			}

			summaries.push(summary);
		}
	}

	return summaries;
}

// ============================================================================
// Report
// ============================================================================

export interface RequestProfile {
	index: number;
	entryId: string;
	timestamp: string;
	time: string;
	model: string;
	/** Provider-reported prompt tokens: input + cacheRead + cacheWrite. */
	actualPrompt: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	/** cacheRead / actualPrompt, or null when the provider reported no usage. */
	cacheHitPct: number | null;
	/** Estimated tokens actually sent (markers + summaries included). */
	estFolded: number;
	/** Estimated tokens had D-Mail been off for this request. */
	estRaw: number;
	/** estRaw − estFolded. */
	saved: number;
	savedPct: number | null;
	/** Provider-reported cost for this request, or null when it reported none. */
	cost: number | null;
	/** Dollar value of `saved` at the cached-prefix marginal rate. */
	savedCostLow: number | null;
	/** Dollar value of `saved` at the blended prompt marginal rate. */
	savedCostHigh: number | null;
	/** actualPrompt − estFolded: unmodeled overhead plus estimator error. */
	overhead: number | null;
	/** Folds in effect for this request. */
	foldsActive: number;
	/** A fold took effect at this request compared with the previous one. */
	foldStarted: boolean;
	/** Fold records that could not be applied (compaction, corrupt, out of view). */
	skippedFolds: number;
}

export interface FoldProfile {
	recordId: string;
	fromStep?: number;
	fromEntryId: string;
	toEntryId: string;
	summaryChars: number;
	/** Index of the first request this fold was in effect for, if ever. */
	effectiveAtRequest: number | null;
	/** Ticket-04 advisory economics recorded at fold time; null for pre-04 folds. */
	predicted: PredictedEconomics | null;
	/**
	 * Ticket-06 measurement: the leave-one-out marginal of this fold over the
	 * requests where its summary actually rendered, valued at the session's own
	 * cache-read/fresh price ratio. Null when the fold never rendered (or has no
	 * prediction — pre-04 folds are not scored). Report-only: never written back
	 * into the session file.
	 */
	actual: ActualEconomics | null;
	/** Requests where this fold's summary rendered and was measured. */
	measuredRequests: number;
}

export interface CostBuckets {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	total: number;
}

export interface CostTotals extends CostBuckets {
	/** Requests whose cost the provider reported. */
	reported: number;
	/** input + cacheRead + cacheWrite: the ceiling on what folding could ever save. */
	promptSide: number;
	/** Implied dollars per million tokens, from this session's own usage/cost pairs. */
	rates: { input: number | null; cacheRead: number | null; output: number | null; blendedPrompt: number | null };
	/** Rates used to value folded-away tokens: cached prefix (low), blended prompt (high). */
	savedRates: { low: number; high: number };
	savedLow: number;
	savedHigh: number;
}

export interface ProfileTotals {
	requests: number;
	actualPrompt: number;
	cacheRead: number;
	cacheWrite: number;
	input: number;
	output: number;
	cacheHitPct: number | null;
	estFolded: number;
	estRaw: number;
	saved: number;
	savedPct: number | null;
	folds: number;
	foldsApplied: number;
	skippedFolds: number;
	meanOverhead: number | null;
}

/**
 * The session-level price of folding: what the re-prefills at fold-start
 * requests cost above a normal request's uncached input, versus what a
 * request with folds active gives back.
 */
export interface FoldEconomics {
	/** Requests where a new fold took effect and usage was reported. */
	foldStarts: number;
	/** Fold records that took effect at least once. */
	foldsApplied: number;
	/** foldsApplied / foldStarts; >1 means folds were batched into one re-prefill. */
	foldsPerStart: number | null;
	/** Median uncached input of requests that did not start a fold. */
	baselineInput: number | null;
	/** Uncached tokens charged above baseline at fold-start requests. */
	excessInput: number;
	/** Mean tokens saved per request while folds are active. */
	meanSaved: number | null;
	/** Requests of saving needed to repay the re-prefills; 0 when they were free. */
	breakEvenRequests: number | null;
	/** Dollar value of `excessInput` at the session's own input rate. */
	excessCost: number | null;
}

export interface Profile {
	sessionFile?: string;
	piHelpers: boolean;
	requests: RequestProfile[];
	folds: FoldProfile[];
	totals: ProfileTotals;
	/** null when no request in the session reported `usage.cost`. */
	cost: CostTotals | null;
	/** null when the session applied no folds. */
	economics: FoldEconomics | null;
}

// Both take `readonly number[]`: neither mutates its input (median sorts its
// own copy), so a caller's readonly array can be passed as-is. Widening the
// parameter — rather than copying at the call site — keeps ownership where the
// caller put it: a defensive copy would hand these functions a different array
// than the one the caller passed, changing mutation semantics for no gain.
function mean(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function pct(numerator: number, denominator: number): number | null {
	if (denominator <= 0) return null;
	return (numerator / denominator) * 100;
}

/** Provider-reported cost for one request, or null when the session records none. */
function readCost(usage: AnyMessage | undefined): CostBuckets | null {
	const raw = usage?.cost as AnyMessage | undefined;
	if (!raw || typeof raw !== "object") return null;
	const keys = ["input", "cacheRead", "cacheWrite", "output", "total"] as const;
	if (!keys.some((key) => typeof raw[key] === "number")) return null;
	const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
	const input = num(raw.input);
	const cacheRead = num(raw.cacheRead);
	const cacheWrite = num(raw.cacheWrite);
	const output = num(raw.output);
	return { input, cacheRead, cacheWrite, output, total: num(raw.total) || input + cacheRead + cacheWrite + output };
}

/**
 * Turn reported cost into marginal rates and a dollar value for the saved
 * tokens. Rates come from the session's own usage/cost pairs, so no price table
 * is needed. The result is a range: the raw counterfactual's cache behaviour is
 * unobservable, so the extra tokens are bracketed between the cached-prefix
 * rate and the blended prompt rate.
 */
function buildCostTotals(buckets: CostBuckets & { reported: number }, totals: ProfileTotals): CostTotals | null {
	const promptCost = buckets.input + buckets.cacheRead + buckets.cacheWrite;
	const promptTokens = totals.input + totals.cacheRead + totals.cacheWrite;
	if (buckets.reported === 0 || promptTokens <= 0) return null;

	const perMillion = (cost: number, tokens: number): number | null => (tokens > 0 ? (cost / tokens) * 1_000_000 : null);
	const rates = {
		input: perMillion(buckets.input, totals.input),
		cacheRead: perMillion(buckets.cacheRead, totals.cacheRead),
		output: perMillion(buckets.output, totals.output),
		blendedPrompt: perMillion(promptCost, promptTokens),
	};
	// A folded-away token is most plausibly part of a stable cached prefix, but it
	// could have been charged at the session's blended prompt rate. Bracket both.
	const low = rates.cacheRead ?? rates.blendedPrompt ?? 0;
	const high = Math.max(low, rates.blendedPrompt ?? low);
	// saved can be negative (markers cost a little before any fold lands), so sort
	// the two products to keep the reported range ordered whichever way it leans.
	const savedLow = (totals.saved * low) / 1_000_000;
	const savedHigh = (totals.saved * high) / 1_000_000;
	return {
		reported: buckets.reported,
		input: buckets.input,
		cacheRead: buckets.cacheRead,
		cacheWrite: buckets.cacheWrite,
		output: buckets.output,
		total: buckets.total,
		promptSide: promptCost,
		rates,
		savedRates: { low, high },
		savedLow: Math.min(savedLow, savedHigh),
		savedHigh: Math.max(savedLow, savedHigh),
	};
}

/**
 * Fold economics for one session. `baselineInput` is the median uncached input
 * of requests that did not start a fold — what a fold-start request would have
 * sent without the fold — so `excessInput` is the re-prefill's genuine extra
 * charge, and `breakEvenRequests` how many active-fold requests it takes to
 * repay it at the observed mean saving.
 */
function buildFoldEconomics(
	baselineInputs: readonly number[],
	foldStartInputs: readonly number[],
	requests: readonly RequestProfile[],
	foldsApplied: number,
	cost: CostTotals | null,
): FoldEconomics {
	const baseline = median(baselineInputs.length > 0 ? baselineInputs : foldStartInputs);
	const excessInput =
		baseline === null ? 0 : foldStartInputs.reduce((sum, value) => sum + Math.max(0, value - baseline), 0);
	const meanSaved = mean(requests.filter((request) => request.foldsActive > 0).map((request) => request.saved));
	const breakEvenRequests =
		excessInput === 0 ? 0 : meanSaved !== null && meanSaved > 0 ? excessInput / meanSaved : null;
	return {
		foldStarts: foldStartInputs.length,
		foldsApplied,
		foldsPerStart: foldStartInputs.length > 0 ? foldsApplied / foldStartInputs.length : null,
		baselineInput: baseline,
		excessInput,
		meanSaved,
		breakEvenRequests,
		excessCost: cost?.rates.input != null ? (excessInput * cost.rates.input) / 1_000_000 : null,
	};
}

/**
 * Analyze one session, given its raw JSONL content.
 *
 * Only the active branch is profiled: abandoned branches were not the context
 * that produced these requests, and mixing them would corrupt the walk.
 */
export async function analyzeSession(content: string, sessionFile?: string): Promise<Profile> {
	const pi = await loadPi();
	const parseEntries = pi?.parseSessionEntries ?? localParseSessionEntries;
	const buildContextEntries = pi?.buildContextEntries ?? localBuildContextEntries;
	const toMessages = pi?.sessionEntryToContextMessages ?? localEntryToMessages;
	const estimateTokens = pi?.estimateTokens ?? localEstimateTokens;
	const calculateContextTokens =
		pi?.calculateContextTokens ??
		((usage: AnyMessage) => usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite);

	const entries = parseEntries(content) as AnyEntry[];
	const byId = new Map<string, AnyEntry>();
	for (const entry of entries) if (typeof entry.id === "string") byId.set(entry.id, entry);

	const leafId = entries.length > 0 ? (entries[entries.length - 1]?.id ?? null) : null;
	const branch = localBranch(entries, leafId, byId);

	// Step numbers come from the branch, matching index.ts exactly, so a step
	// keeps its number even after the markers for folded steps stop being sent.
	const stepOfEntry = new Map(
		numberSteps(branch, isAssistantEntry).map((step) => [step.entryId, step.step] as const),
	);

	// Every fold record declared on the active branch, whether or not it applied.
	const declaredFolds = readFolds(branch);
	const effectiveAtRequest = new Map<string, number>();
	// Leave-one-out marginals per predicted fold: sum/count of
	// (estimate without this fold − estimate with all folds) over the requests
	// where the fold's summary actually rendered.
	const measurements = new Map<string, { sum: number; count: number; lastAt: string | null }>();

	const requests: RequestProfile[] = [];
	const costBuckets: CostBuckets & { reported: number } = {
		input: 0,
		cacheRead: 0,
		cacheWrite: 0,
		output: 0,
		total: 0,
		reported: 0,
	};
	let previousFoldsActive = 0;
	const baselineInputs: number[] = [];
	const foldStartInputs: number[] = [];

	for (const entry of branch) {
		if (!isAssistantEntry(entry)) continue;
		const message = entry.message as AnyMessage;
		const index = requests.length;

		// The prompt for this request is the context as of the entry before the
		// assistant reply, which is exactly the assistant's parent.
		const requestEntries = buildContextEntries(entries, entry.parentId ?? null, byId);
		// Only folds whose record is actually in this request's context count. A fold
		// declared later must not be reported as skipped just for not existing yet.
		const inContext = new Set(requestEntries.map((candidate) => candidate.id));
		const foldsHere = declaredFolds.filter((fold) => inContext.has(fold.recordId));
		const lists = buildMessageLists(requestEntries, stepOfEntry, toMessages, foldsHere);

		for (const recordId of lists.activeFoldIds) {
			if (!effectiveAtRequest.has(recordId)) effectiveAtRequest.set(recordId, index);
		}

		const estFolded = lists.folded.reduce((sum, m) => sum + estimateTokens(m), 0);
		const estRaw = lists.raw.reduce((sum, m) => sum + estimateTokens(m), 0);

		// Ticket 06: measure every predicted fold's marginal contribution. Only
		// while its own summary renders — a newer re-fold that suppresses it would
		// otherwise drag the comparison with predicted economics sideways.
		for (const fold of foldsHere) {
			if (!fold.predicted) continue;
			if (!lists.renderedFoldIds.includes(fold.recordId)) continue;
			const without = buildMessageLists(
				requestEntries,
				stepOfEntry,
				toMessages,
				foldsHere.filter((other) => other.recordId !== fold.recordId),
			);
			const withoutEst = without.folded.reduce((total, m) => total + estimateTokens(m), 0);
			const acc = measurements.get(fold.recordId) ?? { sum: 0, count: 0, lastAt: null };
			acc.sum += withoutEst - estFolded;
			acc.count++;
			acc.lastAt = entry.timestamp ?? acc.lastAt;
			measurements.set(fold.recordId, acc);
		}

		const usage = message.usage;
		const hasUsage = usage && typeof usage.input === "number";
		const input = hasUsage ? usage.input : 0;
		const cacheRead = hasUsage ? usage.cacheRead ?? 0 : 0;
		const cacheWrite = hasUsage ? usage.cacheWrite ?? 0 : 0;
		const output = hasUsage ? usage.output ?? 0 : 0;
		const cost = readCost(usage);
		if (cost) {
			costBuckets.input += cost.input;
			costBuckets.cacheRead += cost.cacheRead;
			costBuckets.cacheWrite += cost.cacheWrite;
			costBuckets.output += cost.output;
			costBuckets.total += cost.total;
			costBuckets.reported++;
		}
		// totalTokens includes output; the prompt is everything but the reply.
		const actualPrompt = hasUsage
			? calculateContextTokens(usage) - output
			: 0;
		const foldsActive = lists.activeFoldIds.length;
		const foldStarted = foldsActive > previousFoldsActive;
		if (hasUsage) (foldStarted ? foldStartInputs : baselineInputs).push(input);

		requests.push({
			index,
			entryId: entry.id,
			timestamp: entry.timestamp,
			time: (entry.timestamp ?? "").slice(11, 19),
			model: message.model ?? "?",
			actualPrompt,
			input,
			cacheRead,
			cacheWrite,
			output,
			cacheHitPct: hasUsage ? pct(cacheRead, actualPrompt) : null,
			estFolded,
			estRaw,
			saved: estRaw - estFolded,
			savedPct: pct(estRaw - estFolded, estRaw),
			cost: cost?.total ?? null,
			savedCostLow: null,
			savedCostHigh: null,
			overhead: hasUsage ? actualPrompt - estFolded : null,
			foldsActive,
			foldStarted,
			skippedFolds: lists.skippedFolds,
		});

		previousFoldsActive = foldsActive;
	}

	const sum = (pick: (request: RequestProfile) => number): number =>
		requests.reduce((total, request) => total + pick(request), 0);

	const totalActualPrompt = sum((r) => r.actualPrompt);
	const totalCacheRead = sum((r) => r.cacheRead);
	const totalEstRaw = sum((r) => r.estRaw);
	const totalEstFolded = sum((r) => r.estFolded);
	const totalSkipped = sum((r) => r.skippedFolds);
	const overheads = requests.map((r) => r.overhead).filter((value): value is number => value !== null);

	const totals: ProfileTotals = {
		requests: requests.length,
		actualPrompt: totalActualPrompt,
		cacheRead: totalCacheRead,
		cacheWrite: sum((r) => r.cacheWrite),
		input: sum((r) => r.input),
		output: sum((r) => r.output),
		cacheHitPct: pct(totalCacheRead, totalActualPrompt),
		estFolded: totalEstFolded,
		estRaw: totalEstRaw,
		saved: totalEstRaw - totalEstFolded,
		savedPct: pct(totalEstRaw - totalEstFolded, totalEstRaw),
		folds: declaredFolds.length,
		foldsApplied: declaredFolds.filter((record) => effectiveAtRequest.has(record.recordId)).length,
		skippedFolds: totalSkipped,
		meanOverhead: mean(overheads),
	};

	const cost = buildCostTotals(costBuckets, totals);
	if (cost) {
		for (const request of requests) {
			const low = (request.saved * cost.savedRates.low) / 1_000_000;
			const high = (request.saved * cost.savedRates.high) / 1_000_000;
			request.savedCostLow = Math.min(low, high);
			request.savedCostHigh = Math.max(low, high);
		}
	}

	// Price the measurement exactly as the prediction was priced: invert the
	// prediction's own `savings = removed × cacheRatio` (economics.ts). The
	// session's real cache prices stay out of it — mixing bases would let
	// pricing alone walk accuracy across the verdict bar, and scoring must be
	// like-for-like (ticket 06).
	const folds: FoldProfile[] = declaredFolds.map((record) => {
		const acc = measurements.get(record.recordId);
		const removed = acc && acc.count > 0 ? Math.round(acc.sum / acc.count) : null;
		const predicted = record.predicted ?? null;
		let actual: ActualEconomics | null = null;
		if (predicted && removed !== null) {
			actual = {
				measuredAt: acc?.lastAt ?? null,
				removedTokens: removed,
				savingsPerRequestTokens: Math.round(removed * cacheRatioOf(predicted)),
			};
		}
		return {
			recordId: record.recordId,
			fromStep: record.fromStep,
			fromEntryId: record.fromEntryId,
			toEntryId: record.toEntryId,
			summaryChars: record.summary.trim().length,
			effectiveAtRequest: effectiveAtRequest.get(record.recordId) ?? null,
			predicted,
			actual,
			measuredRequests: acc?.count ?? 0,
		};
	});

	const economics =
		totals.foldsApplied === 0
			? null
			: buildFoldEconomics(baselineInputs, foldStartInputs, requests, totals.foldsApplied, cost);

	return { sessionFile, piHelpers: pi !== undefined, requests, folds, totals, cost, economics };
}

// ============================================================================
// Rendering
// ============================================================================

function fmt(n: number): string {
	return Math.round(n).toLocaleString("en-US");
}

function fmtPct(value: number | null, digits = 1): string {
	return value === null ? "-" : `${value.toFixed(digits)}%`;
}

/** Dollars with just enough precision to stay readable at fractional-cent sizes. */
function fmtDollars(value: number | null): string {
	if (value === null) return "-";
	const magnitude = Math.abs(value);
	const digits = magnitude >= 1 ? 2 : magnitude >= 0.01 ? 3 : 4;
	// Round at the displayed precision first so tiny negatives render as $0, not $-0.0000.
	const rounded = Number(value.toFixed(digits));
	if (rounded === 0) return "$0";
	return `$${rounded.toFixed(digits)}`;
}

/** A dollar range, collapsed to a single value when the ends round together. */
function fmtDollarsRange(low: number | null, high: number | null): string {
	if (low === null || high === null) return "-";
	if (Math.abs(high - low) < 0.00005) return fmtDollars(low);
	return `${fmtDollars(low)}–${fmtDollars(high)}`;
}

function fmtRate(value: number | null): string {
	return value === null ? "-" : `$${value.toFixed(4)}`;
}

function renderTable(profile: Profile): string {
	const headers = [
		"#",
		"time",
		"model",
		"actual",
		"input",
		"cacheR",
		"cacheW",
		"hit%",
		"estFold",
		"estRaw",
		"saved",
		"$saved",
		"folds",
	];
	const rows = profile.requests.map((request) => [
		String(request.index + 1),
		request.time || "-",
		request.model.length > 26 ? `${request.model.slice(0, 25)}…` : request.model,
		fmt(request.actualPrompt),
		fmt(request.input),
		fmt(request.cacheRead),
		fmt(request.cacheWrite),
		fmtPct(request.cacheHitPct),
		fmt(request.estFolded),
		fmt(request.estRaw),
		request.saved > 0 ? `+${fmt(request.saved)}` : fmt(request.saved),
		fmtDollarsRange(request.savedCostLow, request.savedCostHigh),
		request.foldsActive === 0 ? "0" : `${request.foldsActive}${request.foldStarted ? "+" : ""}`,
	]);

	const widths = headers.map((header, column) =>
		Math.max(header.length, ...rows.map((row) => row[column].length), 0),
	);
	const line = (cells: string[]): string =>
		cells.map((cell, column) => (column < 3 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join("  ");

	const output = [line(headers), widths.map((width) => "-".repeat(width)).join("  "), ...rows.map(line)];
	return output.join("\n");
}

export function renderSummary(profile: Profile): string {
	const t = profile.totals;
	const lines: string[] = [];
	lines.push("");
	lines.push("Totals");
	lines.push(`  requests          ${t.requests}`);
	lines.push(`  provider prompt   ${fmt(t.actualPrompt)} tokens  (input ${fmt(t.input)}, cacheRead ${fmt(t.cacheRead)}, cacheWrite ${fmt(t.cacheWrite)})`);
	lines.push(`  cache hit         ${fmtPct(t.cacheHitPct)} of all prompt tokens served from cache`);
	lines.push(`  output            ${fmt(t.output)} tokens`);
	lines.push(
		`  estimated folded  ${fmt(t.estFolded)}   raw ${fmt(t.estRaw)}   saved ${fmt(t.saved)} (${fmtPct(t.savedPct)})`,
	);
	lines.push(`  folds             ${t.folds} declared, ${t.foldsApplied} applied, ${t.skippedFolds} skipped`);
	if (t.meanOverhead !== null) {
		lines.push(
			`  mean overhead     ${fmt(t.meanOverhead)} tokens/request (system prompt + tools + framing + chars/4 estimator gap)`,
		);
	}
	if (profile.economics) {
		const e = profile.economics;
		lines.push("");
		lines.push("Fold economics");
		lines.push(
			`  fold starts       ${e.foldStarts} request${e.foldStarts === 1 ? "" : "s"} paid a re-prefill  (${e.foldsPerStart === null ? "-" : e.foldsPerStart.toFixed(2)} folds applied per start)`,
		);
		lines.push(
			`  baseline input    ${e.baselineInput === null ? "-" : fmt(e.baselineInput)} tokens/request before any fold`,
		);
		lines.push(
			`  excess input      ${fmt(e.excessInput)} tokens above baseline at fold starts  (${fmtDollars(e.excessCost)})`,
		);
		lines.push(
			`  mean saving       ${e.meanSaved === null ? "-" : fmt(e.meanSaved)} tokens/request while folds are active`,
		);
		const breakEven =
			e.breakEvenRequests === null
				? "n/a (no positive per-request saving)"
				: e.breakEvenRequests === 0
					? "0 (fold re-prefills cost nothing above baseline)"
					: `${e.breakEvenRequests.toFixed(1)} requests of saving repay the re-prefill`;
		lines.push(`  break-even        ${breakEven}`);
	}
	lines.push("");
	lines.push("Cost");
	if (profile.cost) {
		const c = profile.cost;
		lines.push(
			`  provider cost     ${fmtDollars(c.total)}  (input ${fmtDollars(c.input)}, cacheRead ${fmtDollars(c.cacheRead)}, cacheWrite ${fmtDollars(c.cacheWrite)}, output ${fmtDollars(c.output)}; ${c.reported}/${t.requests} requests reported)`,
		);
		lines.push(
			`  implied rates     ${fmtRate(c.rates.input)} input, ${fmtRate(c.rates.cacheRead)} cacheRead, ${fmtRate(c.rates.output)} output  ($/M tokens)`,
		);
		lines.push(
			`  estimated saving  ${fmtDollars(c.savedLow)}-${fmtDollars(c.savedHigh)}  (${fmtPct(pct(c.savedLow, c.total))}-${fmtPct(pct(c.savedHigh, c.total))} of provider cost)`,
		);
		lines.push(`  prompt-side cap   ${fmtDollars(c.promptSide)}  (output spend is unaffected by folding)`);
		lines.push("  low values saved tokens at the cached-prefix rate, high at the blended prompt rate;");
		lines.push("  both are estimates: saved is chars/4 and the raw cache path is unknowable.");
	} else {
		lines.push("  no usage.cost reported in this session, so $saved is unavailable.");
	}
	if (profile.folds.length > 0) {
		lines.push("");
		lines.push("Folds");
		for (const fold of profile.folds) {
			const when =
				fold.effectiveAtRequest === null ? "never applied" : `first in effect at request ${fold.effectiveAtRequest + 1}`;
			lines.push(
				`  step ${fold.fromStep ?? "?"}  ${fold.fromEntryId} -> ${fold.toEntryId}  ${fold.summaryChars} summary chars  (${when})`,
			);
		}
	}
	// Ticket 06: per-fold predicted-vs-measured. Report-only — the session file
	// is append-only and never learns these numbers.
	const predictedFolds = profile.folds.filter(
		(fold): fold is FoldProfile & { predicted: PredictedEconomics } => fold.predicted !== null,
	);
	if (predictedFolds.length > 0) {
		lines.push("");
		lines.push("Fold scoring");
		for (const fold of predictedFolds) {
			const predicted = fold.predicted;
			const label = `  step ${fold.fromStep ?? "?"}  predicted ${fmt(predicted.removedTokens)} removed · ${fmt(predicted.savingsPerRequestTokens)}/req`;
			const measured = fold.actual;
			if (!measured) {
				lines.push(`${label}  measured: not measured (summary never rendered)`);
				continue;
			}
			const removed = measured.removedTokens === null ? "-" : fmt(measured.removedTokens);
			// Pricing comes from the prediction's own cache ratio, so this branch
			// only guards the nullable ticket-04 type — measured savings are
			// always derived when a measurement exists.
			if (measured.savingsPerRequestTokens === null) {
				lines.push(`${label}  measured: ${removed} removed · not priced`);
				continue;
			}
			const accuracy = foldAccuracy(fold);
			lines.push(
				`${label}  measured ${removed} removed · ${fmt(measured.savingsPerRequestTokens)}/req over ${fold.measuredRequests} request${fold.measuredRequests === 1 ? "" : "s"}${accuracy === null ? "" : ` (${fmtPct(accuracy * 100)} of predicted)`}`,
			);
		}
	}
	if (!profile.piHelpers) {
		lines.push("");
		lines.push(
			"note: Pi helpers were not resolvable, so token counts use the built-in port. Set PI_CODING_AGENT_PACKAGE to the Pi package path for exact parity.",
		);
	}
	return lines.join("\n");
}

// ============================================================================
// Fold scoring report (ticket 06)
//
// Compare every fold's ticket-04 predictions with what the recorded requests
// actually measured, then aggregate across sessions into one decision: retire
// the Online Context Compact gate or keep it. Strictly offline and read-only:
// sessions are append-only, so measured economics live in this report only.
// ============================================================================

/** Measured savings must reach this share of predicted savings to retire the gate. */
export const RETIRE_BAR = 0.9;

/**
 * Per-request savings ratio for one fold (measured ÷ predicted), or null when
 * either side can't say: nothing measured, or a prediction of no savings to
 * measure against. Shared by the single-session summary and the aggregate so
 * the two views cannot drift apart.
 */
function foldAccuracy(fold: FoldProfile): number | null {
	const predicted = fold.predicted?.savingsPerRequestTokens ?? 0;
	const measured = fold.actual?.savingsPerRequestTokens ?? null;
	if (measured === null || predicted <= 0) return null;
	return measured / predicted;
}

/** One predicted fold's predicted-vs-measured row. */
export interface FoldScore {
	/** Session file basename, or "-" when analyzed without a file path. */
	session: string;
	recordId: string;
	fromStep: number | null;
	/** Requests over which the fold's summary rendered (the measurement window). */
	requests: number;
	/** predicted.savingsPerRequestTokens × requests; null when nothing was observed. */
	predictedSavings: number | null;
	/** measured savings per request × requests; null when never measured or unpriced. */
	measuredSavings: number | null;
	/** measured/predicted for this fold, null when either side is missing or predicted ≤ 0. */
	accuracy: number | null;
}

/** The aggregate decision across recorded sessions. */
export interface ScoreReport {
	sessions: number;
	/** Fold records carrying ticket-04 predictions. */
	predictedFolds: number;
	/** Predicted folds with a measurement attached. */
	scoredFolds: number;
	/** Predicted folds without a measurement (summary never rendered). */
	unscoredFolds: number;
	/** Scored folds whose predictions are positive — the basis of the ratio. */
	comparedFolds: number;
	/** Σ predicted savings × measured requests, over scored folds with positive predictions. */
	predictedSavings: number;
	/** Σ measured savings × measured requests, over the same folds. */
	measuredSavings: number;
	/** measuredSavings / predictedSavings, or null when nothing comparable exists. */
	accuracy: number | null;
	verdict: "retire" | "keep";
	/** The evidence behind the verdict, ready to print after it. */
	verdictReason: string;
	folds: FoldScore[];
}

/**
 * Aggregate per-fold predictions against measured savings.
 *
 * Each fold is weighted by the requests it was measured over, so the totals
 * read as "what the advisory promised across these sessions vs what the
 * sessions actually delivered". Folds that never rendered or predicted no
 * savings stay out of the ratio; unscored and un-compared folds are counted
 * separately so the totals line can say what it was computed over.
 */
/**
 * The slice of a profile scoring reads: which session it was, and the folds it
 * produced. `scoreSessions` is aggregation-only — it never touches `requests`,
 * `totals`, `cost` or `economics` — so narrowing the parameter documents that
 * and lets a minimal fixture stand in for a full `Profile` (`Profile` satisfies
 * this; only the accepted input narrowed, so every existing caller still typechecks).
 */
export type ScoreInput = Pick<Profile, "sessionFile" | "folds">;

export function scoreSessions(profiles: readonly ScoreInput[]): ScoreReport {
	const folds: FoldScore[] = [];
	let predictedSavings = 0;
	let measuredSavings = 0;
	let scoredFolds = 0;
	let comparedFolds = 0;

	for (const profile of profiles) {
		const session = profile.sessionFile ? basename(profile.sessionFile) : "-";
		for (const fold of profile.folds) {
			if (!fold.predicted) continue;
			const requests = fold.measuredRequests;
			const predictedTotal = fold.predicted.savingsPerRequestTokens * requests;
			const measured = requests > 0 ? (fold.actual?.savingsPerRequestTokens ?? null) : null;
			folds.push({
				session,
				recordId: fold.recordId,
				fromStep: fold.fromStep ?? null,
				requests,
				predictedSavings: requests > 0 ? predictedTotal : null,
				measuredSavings: measured === null ? null : measured * requests,
				accuracy: foldAccuracy(fold),
			});
			if (measured === null) continue;
			scoredFolds++;
			// Predicted ≤ 0 (the advisory expected a cost fold) was measured, but
			// it has no positive promise to hold against, so it never enters the
			// ratio — counted in comparedFolds' denominator for honesty.
			if (fold.predicted.savingsPerRequestTokens <= 0) continue;
			comparedFolds++;
			predictedSavings += predictedTotal;
			measuredSavings += measured * requests;
		}
	}

	const predictedFolds = folds.length;
	const unscoredFolds = predictedFolds - scoredFolds;
	const accuracy = predictedSavings > 0 ? measuredSavings / predictedSavings : null;
	const bar = `${Math.round(RETIRE_BAR * 100)}%`;
	let verdict: "retire" | "keep" = "keep";
	let verdictReason: string;
	if (predictedFolds === 0) {
		verdictReason = "insufficient evidence: no recorded predictions";
	} else if (scoredFolds === 0) {
		verdictReason = "insufficient evidence: no predicted fold was measured";
	} else if (accuracy === null) {
		verdictReason = "insufficient evidence: no positive predicted savings to compare";
	} else {
		verdict = accuracy >= RETIRE_BAR ? "retire" : "keep";
		verdictReason = `measured savings reached ${fmtPct(accuracy * 100)} of predicted (bar ${bar})`;
	}

	return {
		sessions: profiles.length,
		predictedFolds,
		scoredFolds,
		unscoredFolds,
		comparedFolds,
		predictedSavings,
		measuredSavings,
		accuracy,
		verdict,
		verdictReason,
		folds,
	};
}

/** Render the scoring report: per-fold rows, totals, and the gate verdict. */
export function renderScore(report: ScoreReport): string {
	const lines: string[] = [];
	lines.push("");
	lines.push(
		`Fold scoring — ${report.sessions} session${report.sessions === 1 ? "" : "s"}, ${report.predictedFolds} predicted fold${report.predictedFolds === 1 ? "" : "s"}`,
	);
	lines.push("");
	if (report.folds.length > 0) {
		const headers = ["session", "fold", "step", "reqs", "predicted", "measured", "accuracy"];
		const rows = report.folds.map((fold) => [
			fold.session,
			fold.recordId.length > 12 ? `${fold.recordId.slice(0, 11)}…` : fold.recordId,
			fold.fromStep === null ? "-" : String(fold.fromStep),
			String(fold.requests),
			fold.predictedSavings === null ? "-" : fmt(fold.predictedSavings),
			fold.measuredSavings === null ? "-" : fmt(fold.measuredSavings),
			fold.accuracy === null ? "-" : fmtPct(fold.accuracy * 100),
		]);
		const widths = headers.map((header, column) =>
			Math.max(header.length, ...rows.map((row) => row[column].length), 0),
		);
		const line = (cells: string[]): string =>
			cells.map((cell, column) => (column < 3 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join("  ");
		lines.push(line(headers));
		lines.push(widths.map((width) => "-".repeat(width)).join("  "));
		for (const row of rows) lines.push(line(row));
		lines.push("");
	}
	lines.push(
		`  totals (${report.comparedFolds} compared): predicted ${fmt(report.predictedSavings)} · measured ${fmt(report.measuredSavings)} · accuracy ${report.accuracy === null ? "-" : fmtPct(report.accuracy * 100)}`,
	);
	lines.push(
		`  scored ${report.scoredFolds} of ${report.predictedFolds} predicted folds (${report.unscoredFolds} unscored)`,
	);
	lines.push(`  bar: measured ≥ ${Math.round(RETIRE_BAR * 100)}% of predicted`);
	lines.push(`  verdict: ${report.verdict === "retire" ? "RETIRE" : "KEEP"} the OCC gate — ${report.verdictReason}`);
	return lines.join("\n");
}

function renderCsv(profile: Profile): string {
	const headers = [
		"index",
		"entryId",
		"timestamp",
		"model",
		"actualPrompt",
		"input",
		"cacheRead",
		"cacheWrite",
		"output",
		"cacheHitPct",
		"estFolded",
		"estRaw",
		"saved",
		"savedPct",
		"overhead",
		"foldsActive",
		"foldStarted",
		"skippedFolds",
		"cost",
		"savedCostLow",
		"savedCostHigh",
	];
	const escape = (value: unknown): string => {
		const text = value === null || value === undefined ? "" : String(value);
		return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
	};
	const rows = profile.requests.map((request) =>
		[
			request.index + 1,
			request.entryId,
			request.timestamp,
			request.model,
			request.actualPrompt,
			request.input,
			request.cacheRead,
			request.cacheWrite,
			request.output,
			request.cacheHitPct,
			request.estFolded,
			request.estRaw,
			request.saved,
			request.savedPct,
			request.overhead,
			request.foldsActive,
			request.foldStarted,
			request.skippedFolds,
			request.cost,
			request.savedCostLow,
			request.savedCostHigh,
		]
			.map(escape)
			.join(","),
	);
	return [headers.join(","), ...rows].join("\n");
}

// ============================================================================
// CLI
// ============================================================================

function fmtBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

function fmtAge(iso: string, now = Date.now()): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return "?";
	const seconds = Math.max(0, Math.round((now - then) / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
	return `${Math.floor(seconds / 86400)}d`;
}

/** Replaces the home prefix with `~` so long paths stay readable. */
function shortPath(cwd: string | null): string {
	if (!cwd) return "?";
	const home = homedir();
	return cwd === home ? "~" : cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}

function renderSessionList(rows: readonly SessionSummary[], deep: boolean): string {
	if (rows.length === 0) return "No sessions found.";
	const now = Date.now();
	const cells = rows.map((row) => ({
		age: fmtAge(row.modified, now),
		size: fmtBytes(row.sizeBytes),
		req: row.requests === null ? "-" : String(row.requests),
		folds: row.folds === null ? "-" : String(row.folds),
		prompt: row.actualPrompt === null ? "-" : fmt(row.actualPrompt),
		hit: fmtPct(row.cacheHitPct),
		session: `${shortPath(row.cwd)}  ${row.sessionId ?? ""}`,
	}));

	const headers = deep
		? ["AGE", "SIZE", "REQ", "FOLDS", "PROMPT", "HIT", "CWD / SESSION"]
		: ["AGE", "SIZE", "CWD / SESSION"];
	const keys = deep ? (["age", "size", "req", "folds", "prompt", "hit", "session"] as const) : (["age", "size", "session"] as const);

	const widths = keys.map((key, i) => Math.max(headers[i].length, ...cells.map((cell) => cell[key].length)));
	const line = (values: string[]) => values.map((value, i) => value.padEnd(widths[i])).join("  ").trimEnd();
	const out = [line(headers)];
	for (const cell of cells) out.push(line(keys.map((key) => cell[key])));
	return out.join("\n");
}

function renderSessionListJson(rows: readonly SessionSummary[]): string {
	return JSON.stringify({ sessions: rows }, null, 2);
}

function usage(): string {
	return [
		"Usage: node profile.ts <session> [--last N] [--json] [--csv]",
		"       node profile.ts --list [query] [--all] [--deep] [--json]",
		"       node profile.ts --score [session...] [--all] [--json]",
		"",
		"Profiles one Pi session: provider-reported prompt size and cache split",
		"next to the reconstructed D-Mailed and raw context sizes.",
		"Provider cost and the estimated folding saving ($saved) are included",
		"whenever the session records usage.cost.",
		"",
		"  <session>   any of: a path to a .jsonl file, a path relative to the",
		"              sessions root, or an unambiguous session id prefix",
		"              (e.g. 01a0a7b8)",
		"",
		"Note: with `npm run`, put `--` before the arguments, or npm eats them:",
		"  npm run profile -- 01a0a7b8 --csv",
		"",
		"  --last N   only the most recent N requests",
		"  --json     emit the full report as JSON",
		"  --csv      emit per-request rows as CSV",
		"",
		"Listing sessions:",
		"  --list     list sessions for the current working directory",
		"  --all      with --list/--score: every project under the sessions root",
		"  --deep     with --list: also count requests, folds and prompt tokens",
		"  query      with --list: substring filter on cwd, session id or file name",
		"",
		"Scoring folds (offline, read-only; never writes to session files):",
		"  --score    compare every recorded fold's predicted savings (ticket 04)",
		"             against what the sessions actually measured and print one",
		"             retire/keep verdict for the OCC gate. Scores the recorded",
		"             sessions of the current directory; pass session ids/paths",
		"             (or a directory) to choose explicitly.",
	].join("\n");
}

function invokedDirectly(): boolean {
	const arg = process.argv[1];
	if (!arg) return false;
	try {
		return import.meta.url === pathToFileURL(realpathSync(arg)).href;
	} catch {
		return false;
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
		console.log(usage());
		return;
	}

	let file: string | undefined;
	let last = 0;
	let mode: "table" | "json" | "csv" = "table";
	let list = false;
	let score = false;
	let all = false;
	let deep = false;
	const positional: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json") mode = "json";
		else if (arg === "--csv") mode = "csv";
		else if (arg === "--last") last = Number.parseInt(args[++i] ?? "", 10) || 0;
		else if (arg === "--list") list = true;
		else if (arg === "--score") score = true;
		else if (arg === "--all") all = true;
		else if (arg === "--deep") deep = true;
		// A token with a slash or a .jsonl suffix is a path, even if it starts
		// with `--`: project folders are literally named `--home-...--`, so the
		// pasted path can look like a flag. Only true flags are rejected.
		else if (!arg.startsWith("--") || arg.includes("/") || arg.endsWith(".jsonl")) positional.push(arg);
		else {
			console.error(`Unknown option: ${arg}\n\n${usage()}`);
			process.exitCode = 2;
			return;
		}
	}

	if (list || score) {
		if (list && score) {
			console.error("--list and --score cannot be combined.\n\n" + usage());
			process.exitCode = 2;
			return;
		}
		if (score) await printScoreReport(positional, { all, mode });
		else await printSessionList(positional, { all, deep, mode });
		return;
	}

	file = positional[0];

	if (!file) {
		console.error(usage());
		process.exitCode = 2;
		return;
	}

	let content: string;
	const resolution = await resolveSessionPath(file);
	if (!resolution.ok) {
		console.error(resolution.message);
		if (resolution.candidates.length > 0) {
			console.error("");
			console.error(renderSessionList(resolution.candidates, false));
		} else {
			console.error('Run "node profile.ts --list --deep" (add a query to search every project) to find a session.');
		}
		process.exitCode = 2;
		return;
	}
	if (resolution.note) console.error(resolution.note);
	file = resolution.file;

	try {
		content = readFileSync(file, "utf8");
	} catch (error) {
		console.error(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
		return;
	}
	const profile = await analyzeSession(content, file);

	if (mode === "json") {
		console.log(JSON.stringify(profile, null, 2));
		return;
	}
	if (mode === "csv") {
		console.log(renderCsv(profile));
		return;
	}

	if (profile.requests.length === 0) {
		console.log(`${file}: no assistant messages on the active branch, nothing to profile.`);
		return;
	}

	console.log(`Session: ${file}`);
	console.log(`Pi helpers: ${profile.piHelpers ? "loaded" : "local fallback"}`);
	console.log("");

	if (last > 0 && last < profile.requests.length) {
		const start = profile.requests.length - last;
		const sliced: Profile = { ...profile, requests: profile.requests.slice(start) };
		console.log(renderTable(sliced));
	} else {
		console.log(renderTable(profile));
	}
	console.log(renderSummary(profile));
}

async function printScoreReport(
	positional: readonly string[],
	options: { all: boolean; mode: "table" | "json" | "csv" },
): Promise<void> {
	if (options.mode === "csv") {
		console.error("--csv is not supported with --score; use --json or the report.");
		process.exitCode = 2;
		return;
	}

	// A positional that names a directory is a project filter, not a session selector.
	let cwd = process.cwd();
	const selectors: string[] = [];
	for (const value of positional) {
		try {
			if (statSync(value).isDirectory()) {
				cwd = resolve(value);
				continue;
			}
		} catch {
			/* not a path: treat it as a session selector */
		}
		selectors.push(value);
	}

	let files: string[];
	if (selectors.length > 0) {
		// Explicit session selectors: resolve each one the friendly way.
		files = [];
		for (const selector of selectors) {
			const resolution = await resolveSessionPath(selector);
			if (!resolution.ok) {
				console.error(resolution.message);
				if (resolution.candidates.length > 0) {
					console.error("");
					console.error(renderSessionList(resolution.candidates, false));
				} else {
					console.error('Run "node profile.ts --list --deep" (add a query to search every project) to find a session.');
				}
				process.exitCode = 2;
				return;
			}
			if (resolution.note) console.error(resolution.note);
			files.push(resolution.file);
		}
	} else {
		// Every recorded session for this project (or all projects with --all).
		const rows = await listSessions({ cwd, all: options.all, deep: false });
		rows.sort((a, b) => b.modified.localeCompare(a.modified));
		files = rows.map((row) => row.file);
	}

	if (files.length === 0) {
		console.log(`No sessions under ${sessionDirForCwd(cwd)}. Try --all to search every project.`);
		return;
	}

	// Read-only by construction: sessions are append-only, and the measured
	// economics live in this report, never in the files we read.
	const profiles: Profile[] = [];
	for (const file of files) {
		let content: string;
		try {
			content = readFileSync(file, "utf8");
		} catch (error) {
			console.error(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
			process.exitCode = 1;
			return;
		}
		profiles.push(await analyzeSession(content, file));
	}

	const report = scoreSessions(profiles);
	if (options.mode === "json") {
		console.log(JSON.stringify(report, null, 2));
		return;
	}
	console.log(renderScore(report));
}

async function printSessionList(
	positional: readonly string[],
	options: { all: boolean; deep: boolean; mode: "table" | "json" | "csv" },
): Promise<void> {
	// A positional that names a directory is a project filter, not a text query.
	let cwd = process.cwd();
	const queries: string[] = [];
	for (const value of positional) {
		try {
			if (statSync(value).isDirectory()) {
				cwd = resolve(value);
				continue;
			}
		} catch {
			/* not a path: treat it as a query */
		}
		queries.push(value);
	}

	const query = queries.join(" ") || undefined;
	if (options.mode === "csv") {
		console.error("--csv is not supported with --list; use --json or the table.");
		process.exitCode = 2;
		return;
	}

	const rows = await listSessions({ cwd, all: options.all || Boolean(query), deep: options.deep, query });
	rows.sort((a, b) => b.modified.localeCompare(a.modified));

	if (options.mode === "json") {
		console.log(renderSessionListJson(rows));
		return;
	}

	console.log(renderSessionList(rows, options.deep));
	console.log("");
	if (rows.length === 0) {
		console.log(
			query
				? `No sessions matched ${JSON.stringify(query)}.`
				: `No sessions under ${sessionDirForCwd(cwd)}. Try --all to search every project.`,
		);
		return;
	}
	console.log(`${rows.length} session${rows.length === 1 ? "" : "s"}${options.all || query ? " (all projects)" : ` in ${cwd}`}`);
	if (!options.deep) console.log("Add --deep for request, fold and prompt-token counts.");
	console.log(`Profile one with: node profile.ts ${JSON.stringify(rows[0].file)}`);
	const shortId = (rows[0].sessionId ?? "").slice(0, 8);
	if (shortId.length >= 3) console.log(`Short form:       node profile.ts ${shortId}`);
}

if (invokedDirectly()) {
	await main();
}

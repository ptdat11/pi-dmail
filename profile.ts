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
 * Usage:
 *   node profile.ts <session.jsonl|session-id-prefix> [--last N] [--json] [--csv]
 *   node profile.ts --list [query] [--all] [--deep] [--json]
 *
 * A session argument that is not a readable file is resolved the friendly way:
 * a full path, a path relative to the sessions root
 * (`--proj--/<file>.jsonl`), or any unambiguous fragment of the session id.
 */
import { execSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

type AnyEntry = Record<string, any>;
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

/** Read `dmail.fold` entries, mirroring index.ts `readFolds` but keeping the id. */
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

	const folded = foldContext<AnyEntry, AnyMessage>(requestEntries, folds, {
		convert: toMessages,
		summaryMessage: (text) => userMessage(text, Date.now()),
		beforeEntry: marker,
		isStepStart: isAssistantEntry,
	});
	const raw = foldContext<AnyEntry, AnyMessage>(requestEntries, [], {
		convert: toMessages,
	});

	return {
		folded: folded.messages,
		raw: raw.messages,
		activeFoldIds: folded.applied.map((record) => (record as FoldRecordWithId).recordId),
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
		let entries: ReturnType<typeof readdirSync>;
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

export interface Profile {
	sessionFile?: string;
	piHelpers: boolean;
	requests: RequestProfile[];
	folds: FoldProfile[];
	totals: ProfileTotals;
}

function mean(values: number[]): number | null {
	if (values.length === 0) return null;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pct(numerator: number, denominator: number): number | null {
	if (denominator <= 0) return null;
	return (numerator / denominator) * 100;
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

	const requests: RequestProfile[] = [];
	let previousFoldsActive = 0;

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

		const usage = message.usage;
		const hasUsage = usage && typeof usage.input === "number";
		const input = hasUsage ? usage.input : 0;
		const cacheRead = hasUsage ? usage.cacheRead ?? 0 : 0;
		const cacheWrite = hasUsage ? usage.cacheWrite ?? 0 : 0;
		const output = hasUsage ? usage.output ?? 0 : 0;
		// totalTokens includes output; the prompt is everything but the reply.
		const actualPrompt = hasUsage
			? calculateContextTokens(usage) - output
			: 0;
		const foldsActive = lists.activeFoldIds.length;

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
			overhead: hasUsage ? actualPrompt - estFolded : null,
			foldsActive,
			foldStarted: foldsActive > previousFoldsActive,
			skippedFolds: lists.skippedFolds,
		});

		previousFoldsActive = foldsActive;
	}

	const folds: FoldProfile[] = declaredFolds.map((record) => ({
		recordId: record.recordId,
		fromStep: record.fromStep,
		fromEntryId: record.fromEntryId,
		toEntryId: record.toEntryId,
		summaryChars: record.summary.trim().length,
		effectiveAtRequest: effectiveAtRequest.get(record.recordId) ?? null,
	}));

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
		folds: folds.length,
		foldsApplied: folds.filter((fold) => fold.effectiveAtRequest !== null).length,
		skippedFolds: totalSkipped,
		meanOverhead: mean(overheads),
	};

	return { sessionFile, piHelpers: pi !== undefined, requests, folds, totals };
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

function renderSummary(profile: Profile): string {
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
	if (!profile.piHelpers) {
		lines.push("");
		lines.push(
			"note: Pi helpers were not resolvable, so token counts use the built-in port. Set PI_CODING_AGENT_PACKAGE to the Pi package path for exact parity.",
		);
	}
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
		"",
		"Profiles one Pi session: provider-reported prompt size and cache split",
		"next to the reconstructed D-Mailed and raw context sizes.",
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
		"  --all      with --list: every project under the sessions root",
		"  --deep     with --list: also count requests, folds and prompt tokens",
		"  query      with --list: substring filter on cwd, session id or file name",
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
	let all = false;
	let deep = false;
	const positional: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json") mode = "json";
		else if (arg === "--csv") mode = "csv";
		else if (arg === "--last") last = Number.parseInt(args[++i] ?? "", 10) || 0;
		else if (arg === "--list") list = true;
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

	if (list) {
		await printSessionList(positional, { all, deep, mode });
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

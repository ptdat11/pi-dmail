// Advisory economics (ticket 04). Pure: inputs in, verdict + estimated
// savings out. No pi imports, no I/O, no throwing — a fold is never refused,
// delayed, or altered on economic grounds.
//
// Model (hand-checkable, all in "fresh-token equivalents"):
//   removed   = archiveTokens − memoTokens        (signed; negative = fold adds)
//   savings   = removed × cacheRatio              (per request, cache-read price)
//   rebuild   = memoTokens + keptAfterTokens      (one-time fresh rewrite past
//               the fold point: the memo plus the kept suffix it displaces)
//   breakEven = ceil(rebuild / savings)           (requests until the rebuild pays back)
//
// contextTokens/contextWindow feed window headroom only. The prefix cache keeps
// the surviving prefix resident across the fold, so window usage never enters
// the rebuild — only the kept suffix can, and only its absence makes the
// rebuild unknowable.
//
// cacheRatio is the cache write/read price ratio inverted: the price of one
// cache-read token as a fraction of one fresh (cache-write) token.

/** Cache-read price ÷ fresh-token price. */
export const DEFAULT_CACHE_RATIO = 0.1;
/**
 * Pi's backstop reserve: compaction fires above contextWindow − reserveTokens.
 * Mirrors pi's DEFAULT_COMPACTION_SETTINGS.reserveTokens — hardcoded so this
 * module stays dependency-free; test/advisory.test.ts cross-checks against pi.
 */
export const DEFAULT_RESERVE_TOKENS = 16_384;
/** Payback within this many requests counts as "pays-back", not "slow". */
export const FAST_PAYBACK_REQUESTS = 10;

/** Verdict over archive-vs-memo token delta. */
export type FoldVerdict = "savings" | "break-even" | "cost";
/**
 * Verdict over whether the one-time cache rebuild pays for itself. `unknown`
 * means the rebuild cost is unknowable (the kept suffix could not be measured),
 * not that usage was unavailable.
 */
export type CacheVerdict = "pays-back" | "slow-pays-back" | "never-pays" | "unknown";

export interface EconomicsInput {
	/** Tokens in the archive — the entries [fromEntryId, toEntryId) the fold drops. */
	archiveTokens: number;
	/** Tokens in the memo that replaces them (as replay sends it, wrapper included). */
	memoTokens: number;
	/**
	 * Tokens in the entries kept after the fold point (from `toEntryId` onward).
	 * Together with the memo these are what rewrites fresh once. Null/absent =
	 * unknowable → the cache verdict degrades to `unknown`.
	 */
	keptAfterTokens?: number | null;
	/** Cache-read price ÷ fresh price. Default DEFAULT_CACHE_RATIO. */
	cacheRatio?: number;
	/** Current context tokens (window headroom only). Null = unavailable. */
	contextTokens?: number | null;
	/** Context window size. Null = unavailable. */
	contextWindow?: number | null;
	/** Reserve before backstop compaction. Default Pi's reserve. */
	reserveTokens?: number;
}

export interface Headroom {
	contextTokens: number | null;
	contextWindow: number | null;
	reserveTokens: number;
	/** contextWindow − contextTokens; null when either side is unknown. */
	headroomTokens: number | null;
	/** Within one reserve of the compaction line. */
	nearReserve: boolean;
	/** At/beyond the compaction line (headroom below the reserve). */
	insideReserve: boolean;
}

/** Predicted economics, recorded at fold time for later scoring (ticket 06). */
export interface PredictedEconomics {
	removedTokens: number;
	savingsPerRequestTokens: number;
	rebuildTokens: number | null;
	breakEvenRequests: number | null;
}

/** Actual economics, filled by scoring once measurements exist (ticket 06). */
export interface ActualEconomics {
	measuredAt: string | null;
	removedTokens: number | null;
	savingsPerRequestTokens: number | null;
}

/**
 * The cache ratio a recorded prediction was priced with — the inverse of the
 * model's `savings = removed × cacheRatio`. Scoring prices the measured side
 * with exactly this ratio (falling back to DEFAULT_CACHE_RATIO when the
 * prediction cannot yield one), so predicted and actual are compared
 * like-for-like: a session's real cache prices can never flip a verdict,
 * only prediction quality can (ticket 06).
 */
export function cacheRatioOf(
	predicted: Pick<PredictedEconomics, "removedTokens" | "savingsPerRequestTokens">,
): number {
	const { removedTokens, savingsPerRequestTokens } = predicted;
	if (
		typeof removedTokens === "number" &&
		Number.isFinite(removedTokens) &&
		removedTokens !== 0 &&
		typeof savingsPerRequestTokens === "number" &&
		Number.isFinite(savingsPerRequestTokens)
	) {
		const ratio = savingsPerRequestTokens / removedTokens;
		if (Number.isFinite(ratio) && ratio > 0) return ratio;
	}
	return DEFAULT_CACHE_RATIO;
}

export interface Economics {
	verdict: FoldVerdict;
	/** Signed: positive = tokens removed from the steady-state context. */
	removedTokens: number;
	/** Per-request savings in fresh-token equivalents; negative = added cost. */
	estimatedSavingsTokens: number;
	cacheVerdict: CacheVerdict;
	breakEvenRequests: number | null;
	rebuildTokens: number | null;
	headroom: Headroom;
	predicted: PredictedEconomics;
	actual: ActualEconomics | null;
}

function round(n: number): number {
	return Number.isFinite(n) ? Math.round(n) : n;
}

/**
 * Evaluate fold economics. Total by construction: every input is clamped
 * before it is used, so no combination — NaN, Infinity, negatives, missing
 * usage — can throw or omit a verdict. The fold tool treats that as a
 * contract: economics can only ever add words to a result, never refuse,
 * delay, or alter the fold.
 */
export function evaluateEconomics(input: EconomicsInput): Economics {
	return compute(input);
}

/** A token count that is always usable: non-finite or negative reads as 0. */
function tokenCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function compute(raw: Partial<EconomicsInput> | undefined): Economics {
	const input = raw ?? {};
	const archiveTokens = tokenCount(input.archiveTokens);
	const memoTokens = tokenCount(input.memoTokens);
	const keptAfterTokens =
		typeof input.keptAfterTokens === "number" && Number.isFinite(input.keptAfterTokens)
			? Math.max(0, input.keptAfterTokens)
			: null;
	const cacheRatio =
		typeof input.cacheRatio === "number" && Number.isFinite(input.cacheRatio)
			? input.cacheRatio
			: DEFAULT_CACHE_RATIO;
	const reserveTokens =
		typeof input.reserveTokens === "number" && Number.isFinite(input.reserveTokens)
			? input.reserveTokens
			: DEFAULT_RESERVE_TOKENS;
	const contextTokens =
		typeof input.contextTokens === "number" && Number.isFinite(input.contextTokens)
			? input.contextTokens
			: null;
	const contextWindow =
		typeof input.contextWindow === "number" && Number.isFinite(input.contextWindow)
			? input.contextWindow
			: null;

	// Verdict over the token delta.
	const removedTokens = archiveTokens - memoTokens;
	const verdict: FoldVerdict =
		removedTokens > 0 ? "savings" : removedTokens === 0 ? "break-even" : "cost";

	// Per-request savings in fresh-token equivalents.
	const estimatedSavingsTokens = round(removedTokens * cacheRatio);

	// One-time fresh rewrite past the fold point: the memo plus the kept suffix
	// it displaces. The surviving prefix stays prefix-cache resident, so window
	// usage never enters this number — only a missing kept-suffix measurement
	// can make it unknowable.
	const rebuildTokens = keptAfterTokens === null ? null : memoTokens + keptAfterTokens;

	// Break-even: requests of savings needed to repay the rebuild.
	const breakEvenRequests =
		rebuildTokens === null || !Number.isFinite(estimatedSavingsTokens) || estimatedSavingsTokens <= 0
			? null
			: Math.max(0, Math.ceil(rebuildTokens / estimatedSavingsTokens));

	// Cache verdict precedence: nothing removed → never; rebuild unknowable →
	// unknown; fast amortisation → pays-back; otherwise slow.
	let cacheVerdict: CacheVerdict;
	if (removedTokens <= 0 || estimatedSavingsTokens <= 0) {
		cacheVerdict = "never-pays";
	} else if (rebuildTokens === null) {
		cacheVerdict = "unknown";
	} else {
		cacheVerdict =
			breakEvenRequests !== null && breakEvenRequests <= FAST_PAYBACK_REQUESTS
				? "pays-back"
				: "slow-pays-back";
	}

	// Window headroom against Pi's backstop reserve.
	const headroomTokens =
		contextWindow === null || contextTokens === null ? null : contextWindow - contextTokens;
	const headroom: Headroom = {
		contextTokens,
		contextWindow,
		reserveTokens,
		headroomTokens,
		nearReserve: headroomTokens !== null && headroomTokens <= 2 * reserveTokens,
		insideReserve: headroomTokens !== null && headroomTokens < reserveTokens,
	};

	return {
		verdict,
		removedTokens,
		estimatedSavingsTokens,
		cacheVerdict,
		breakEvenRequests,
		rebuildTokens,
		headroom,
		predicted: {
			removedTokens,
			savingsPerRequestTokens: estimatedSavingsTokens,
			rebuildTokens,
			breakEvenRequests,
		},
		actual: null,
	};
}

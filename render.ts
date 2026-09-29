/**
 * Renderer text for the `send_dmail` tool result.
 *
 * Pi draws a tool result through the extension's `renderResult` when one is
 * defined, and falls back to the raw `content` text otherwise. The fallback is
 * what made a fold look like a dead end: it named the folded range but never
 * showed the summary, so the one artifact worth re-reading was invisible.
 *
 * This module builds that text as plain strings, free of any Pi import, so the
 * exact wording is testable under bare `node --test`. index.ts adds the color
 * and the terminal component on top.
 *
 * The advisory economics lines (ticket 04) render here the same way: pure
 * strings, strictly advisory — they can only add words to a result, never
 * refuse or alter a fold.
 */
import type { ActualEconomics, Economics, PredictedEconomics } from "./economics.ts";

/** The `details` a `send_dmail` result carries. */
export type FoldRenderDetails = {
	fromStep?: number;
	throughStep?: number;
	/** How many fold records replay skipped, e.g. records from before the
	 * compaction boundary. Counted, never dropped silently. */
	skipped?: number;
	/** The advisory economics verdict for this fold (ticket 04). Absent when
	 * economics could not be computed — the fold stands either way. */
	economics?: Economics | null;
	/** Predicted savings at fold time; the actual value is filled in later by
	 * scoring (ticket 06), so `actual` ships null. */
	predicted?: PredictedEconomics | null;
	actual?: ActualEconomics | null;
	/** True when the result is a preview (ticket 05): estimates only — the
	 * headline reads as a proposal, and nothing was appended. */
	preview?: boolean;
};

/** Preview budget for the collapsed line, before the expand hint. */
const PREVIEW_LIMIT = 60;

/**
 * The one-line description of the fold, e.g. "Folded steps 3–8". Falls back to
 * a bare verb phrase when the result carries no range, which is what a partial
 * or malformed result looks like.
 */
export function foldHeadline(details: FoldRenderDetails): string {
	// A preview has not folded anything: the verb has to say so.
	const verb = details.preview ? "Would fold" : "Folded";
	const { fromStep, throughStep } = details;
	if (typeof fromStep !== "number" || !Number.isFinite(fromStep)) {
		return `${verb} steps`;
	}
	if (typeof throughStep !== "number" || !Number.isFinite(throughStep) || throughStep === fromStep) {
		return `${verb} step ${fromStep}`;
	}
	return `${verb} steps ${fromStep}–${throughStep}`;
}

/**
 * First non-blank line of the summary, trimmed and cut to `limit` characters.
 * Empty when there is nothing worth previewing, which suppresses the expand
 * hint rather than promising content that is not there.
 */
export function foldSummaryPreview(summary: string, limit: number = PREVIEW_LIMIT): string {
	const firstLine = summary.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
	if (firstLine === "") {
		return "";
	}
	if (limit <= 0) {
		return "";
	}
	if (firstLine.length <= limit) {
		return firstLine;
	}
	return `${firstLine.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

/**
 * The count of skipped fold records as its own line, or `""` when there is
 * nothing to report. Skips are ordinary (a compaction boundary orphanates old
 * records) but silent loss is not, so a non-zero count always surfaces.
 */
export function foldSkippedLine(skipped?: number): string {
	if (typeof skipped !== "number" || !Number.isFinite(skipped) || skipped <= 0) {
		return "";
	}
	return `folds skipped: ${skipped}`;
}

/**
 * Compact token count for the advisory lines: `700`, `4.8k`, `48k`.
 * Estimates, so the caller always renders its own `~`.
 */
function fmtTokens(tokens: number): string {
	if (!Number.isFinite(tokens)) {
		return "?";
	}
	const n = Math.round(tokens);
	if (Math.abs(n) < 1_000) {
		return `${n}`;
	}
	const k = n / 1_000;
	return `${Number.isInteger(k) ? String(k) : k.toFixed(1)}k`;
}

/**
 * The economics line: estimated tokens removed, what that saves per request,
 * and the cache verdict (with its break-even when the rebuild cost is known).
 * `""` when the result carries no economics — advisory never blocks the text.
 */
export function foldEconomicsLine(details: FoldRenderDetails): string {
	const e = details.economics;
	if (!e) {
		return "";
	}
	const cache = e.cacheVerdict === "unknown" ? "cache: unknown (rebuild unknowable)" : `cache: ${e.cacheVerdict}`;
	if (e.removedTokens < 0) {
		return `~${fmtTokens(-e.removedTokens)} tokens added · costs ~${fmtTokens(-e.estimatedSavingsTokens)}/req · ${cache}`;
	}
	const breakEven =
		e.breakEvenRequests === null
			? ""
			: ` (breaks even in ${e.breakEvenRequests} request${e.breakEvenRequests === 1 ? "" : "s"})`;
	return `~${fmtTokens(e.removedTokens)} tokens removed · saves ~${fmtTokens(e.estimatedSavingsTokens)}/req · ${cache}${breakEven}`;
}

/**
 * The window-headroom warning (story 16): silent when usage is unknown or the
 * window is calm, a warning when context is within one reserve of Pi's
 * backstop compaction, a louder one once it is past the line.
 */
export function foldHeadroomLine(details: FoldRenderDetails): string {
	const headroom = details.economics?.headroom;
	if (!headroom || !headroom.nearReserve || headroom.headroomTokens === null) {
		return "";
	}
	const used = `~${fmtTokens(headroom.headroomTokens)}`;
	const reserve = fmtTokens(headroom.reserveTokens);
	return headroom.insideReserve
		? `window headroom ${used} — inside the ${reserve} reserve; backstop compaction fires now`
		: `window headroom ${used} — within one ${reserve} reserve of backstop compaction`;
}

/**
 * The predicted-vs-actual line (story 17): what this fold predicts now, and
 * the honest placeholder for the actual — scoring fills it in later (06).
 * Visible in the expanded view so the collapsed line stays short.
 */
export function foldPredictedActualLine(details: FoldRenderDetails): string {
	const predicted = details.predicted ?? details.economics?.predicted;
	if (!predicted) {
		return "";
	}
	const perRequest =
		predicted.savingsPerRequestTokens >= 0
			? `saves ~${fmtTokens(predicted.savingsPerRequestTokens)}/req`
			: `costs ~${fmtTokens(-predicted.savingsPerRequestTokens)}/req`;
	const breakEven =
		predicted.breakEvenRequests === null
			? ""
			: `, breaks even in ${predicted.breakEvenRequests} request${predicted.breakEvenRequests === 1 ? "" : "s"}`;
	return `predicted: ${perRequest}${breakEven} · actual: not yet measured`;
}

/**
 * All advisory lines for the current view, `\n`-joined, `""` when there is
 * nothing to advise. Used by both views above and by index.ts's raw fallback.
 */
export function foldAdvisoryText(details: FoldRenderDetails, expanded = false): string {
	const lines = [foldEconomicsLine(details), foldHeadroomLine(details)];
	if (expanded) {
		lines.push(foldPredictedActualLine(details));
	}
	return lines.filter((line) => line !== "").join("\n");
}

/**
 * Collapsed line: the range, a preview of the summary, and the key that reveals
 * the rest. The hint is supplied by the caller so this module stays unaware of
 * keybindings.
 */
export function foldCollapsedText(details: FoldRenderDetails, summary: string, expandHint: string): string {
	const headline = foldHeadline(details);
	const preview = foldSummaryPreview(summary);
	const skipped = foldSkippedLine(details.skipped);
	const head = preview === "" ? headline : withHint(`${headline} — ${preview}`, expandHint);
	return withSkipped(withAdvisory(head, details, false), skipped);
}

/** Append the expand hint to `line` when there is one. */
function withHint(line: string, expandHint: string): string {
	const hint = expandHint.trim();
	return hint === "" ? line : `${line} (${hint})`;
}

/** Expanded view: the range, then the whole summary indented under it. */
export function foldExpandedText(details: FoldRenderDetails, summary: string): string {
	const headline = foldHeadline(details);
	const body = summary.trim();
	const skipped = foldSkippedLine(details.skipped);
	const head = body === ""
		? headline
		: `${headline}\n${body
				.split("\n")
				.map((line) => (line === "" ? line : `  ${line}`))
				.join("\n")}`;
	return withSkipped(withAdvisory(head, details, true), skipped);
}

/** Append the advisory lines under `head` when there are any. */
function withAdvisory(head: string, details: FoldRenderDetails, expanded: boolean): string {
	const advisory = foldAdvisoryText(details, expanded);
	return advisory === "" ? head : `${head}\n${advisory}`;
}

/** Append the skip-count line under `head` when there is one. */
function withSkipped(head: string, skipped: string): string {
	return skipped === "" ? head : `${head}\n${skipped}`;
}

/** Pick the view for the current expand state. */
export function foldResultText(
	details: FoldRenderDetails,
	summary: string,
	expandHint: string,
	expanded: boolean,
): string {
	return expanded ? foldExpandedText(details, summary) : foldCollapsedText(details, summary, expandHint);
}

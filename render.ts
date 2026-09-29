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
 */

/** The `details` a `send_dmail` result carries. */
export type FoldRenderDetails = {
	fromStep?: number;
	throughStep?: number;
	/** How many fold records replay skipped, e.g. records from before the
	 * compaction boundary. Counted, never dropped silently. */
	skipped?: number;
};

/** Preview budget for the collapsed line, before the expand hint. */
const PREVIEW_LIMIT = 60;

/**
 * The one-line description of the fold, e.g. "Folded steps 3–8". Falls back to
 * a bare verb phrase when the result carries no range, which is what a partial
 * or malformed result looks like.
 */
export function foldHeadline(details: FoldRenderDetails): string {
	const { fromStep, throughStep } = details;
	if (typeof fromStep !== "number" || !Number.isFinite(fromStep)) {
		return "Folded steps";
	}
	if (typeof throughStep !== "number" || !Number.isFinite(throughStep) || throughStep === fromStep) {
		return `Folded step ${fromStep}`;
	}
	return `Folded steps ${fromStep}–${throughStep}`;
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
 * Collapsed line: the range, a preview of the summary, and the key that reveals
 * the rest. The hint is supplied by the caller so this module stays unaware of
 * keybindings.
 */
export function foldCollapsedText(details: FoldRenderDetails, summary: string, expandHint: string): string {
	const headline = foldHeadline(details);
	const preview = foldSummaryPreview(summary);
	const skipped = foldSkippedLine(details.skipped);
	const head = preview === "" ? headline : withHint(`${headline} — ${preview}`, expandHint);
	return withSkipped(head, skipped);
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
	return withSkipped(head, skipped);
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

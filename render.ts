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
 * Collapsed line: the range, a preview of the summary, and the key that reveals
 * the rest. The hint is supplied by the caller so this module stays unaware of
 * keybindings.
 */
export function foldCollapsedText(details: FoldRenderDetails, summary: string, expandHint: string): string {
	const headline = foldHeadline(details);
	const preview = foldSummaryPreview(summary);
	if (preview === "") {
		return headline;
	}
	const line = `${headline} — ${preview}`;
	const hint = expandHint.trim();
	return hint === "" ? line : `${line} (${hint})`;
}

/** Expanded view: the range, then the whole summary indented under it. */
export function foldExpandedText(details: FoldRenderDetails, summary: string): string {
	const headline = foldHeadline(details);
	const body = summary.trim();
	if (body === "") {
		return headline;
	}
	const indented = body
		.split("\n")
		.map((line) => (line === "" ? line : `  ${line}`))
		.join("\n");
	return `${headline}\n${indented}`;
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

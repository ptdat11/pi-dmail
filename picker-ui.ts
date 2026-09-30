/**
 * The scrollable /tree-style picker component behind `/dmail fold` (tickets 07
 * and 12): row styling (cursor, role/range colours, dim estimate), the centred
 * scroll window, and the two-phase state machine that asks the same stable list
 * for a start and then for an end — built as a plain pi-tui Component (no
 * Container), driven through render()/handleInput().
 *
 * The component owns the phase rules; the host owns what a pinned range means.
 * It never closes itself between phases, so the list, the scroll window and the
 * row set stay identical while the question changes.
 */
import { keyHint, rawKeyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, truncateToWidth, type Component, type KeybindingsManager } from "@earendil-works/pi-tui";
import {
	endStepOf,
	ESTIMATE_LEGEND,
	foldBracket,
	PICKER_END_TITLE,
	PICKER_TITLE,
	type FoldPin,
	type FoldPickerRow,
} from "./picker.ts";

// The pinned range is domain data, not UI state, so it lives in the pure module;
// the re-export keeps existing importers of this module working.
export type { FoldPin } from "./picker.ts";

export interface FoldPickerOptions {
	rows: FoldPickerRow[];
	theme: Theme;
	/** Terminal height in rows — drives the size of the scroll window. */
	terminalRows: number;
	/** Hand the pinned range back once both ends are chosen. */
	/** Both ends of the cut, as the two picker phases answer them. */
	onSelect: (pin: FoldPin) => void;
	onCancel: () => void;
	/** Defaults to pi's global keybindings when omitted. */
	keybindings?: Pick<KeybindingsManager, "matches">;
	/**
	 * Figure for one candidate `(start, end)` pair, e.g. `~12k`. The header asks
	 * for it on every redraw, so the component memoises per pair: the host's
	 * answer is a range walk, and one keypress must not repeat a walk it has done.
	 */
	rangeEstimate?: (fromStep: number, throughStep: number) => string | undefined;
}

type Action = "up" | "down" | "pageUp" | "pageDown" | "confirm" | "cancel";

/** Keys the picker understands even when a host's key map doesn't (vim keys, raw escapes). */
const RAW_ACTIONS: Record<string, Action> = {
	k: "up",
	j: "down",
	"\n": "confirm",
	"\r": "confirm",
	"\x1b": "cancel",
	"\x1b[A": "up",
	"\x1b[B": "down",
	"\x1b[5~": "pageUp",
	"\x1b[6~": "pageDown",
};

/** The host's key map, consulted before the raw keys above. */
const BINDINGS = [
	["tui.select.up", "up"],
	["tui.select.down", "down"],
	["tui.select.pageUp", "pageUp"],
	["tui.select.pageDown", "pageDown"],
	["tui.select.confirm", "confirm"],
	["tui.select.cancel", "cancel"],
] as const;

/** render() surrounds the rows with: title, legend, two blanks, footer. */
const CHROME_LINES = 5;

/**
 * pi's key hints read pi's global theme, which only a live TUI initializes;
 * outside one (headless renders) any error falls back to the hint unstyled.
 */
function hintOrFallback(render: () => string, fallback: string): string {
	try {
		return render();
	} catch {
		return fallback;
	}
}

export class FoldPickerComponent implements Component {
	readonly rows: FoldPickerRow[];
	private readonly theme: Theme;
	private readonly terminalRows: number;
	private readonly onSelect: (pin: FoldPin) => void;
	private readonly onCancel: () => void;
	private readonly keybindings: Pick<KeybindingsManager, "matches">;
	private readonly rangeEstimate?: (fromStep: number, throughStep: number) => string | undefined;
	/** Figures already computed, keyed by `(start, end)` pair. A missing key is not "no figure". */
	private readonly memo = new Map<string, string | undefined>();
	private phase: "start" | "end" = "start";
	/** The row pinned as the start; kept so Esc from phase 2 restores it intact. */
	private start: FoldPickerRow | undefined;
	private startIndex = 0;
	private selectedIndex = 0;

	constructor(options: FoldPickerOptions) {
		this.rows = options.rows;
		this.theme = options.theme;
		this.terminalRows = options.terminalRows;
		this.onSelect = options.onSelect;
		this.onCancel = options.onCancel;
		this.keybindings = options.keybindings || getKeybindings();
		this.rangeEstimate = options.rangeEstimate;
	}

	invalidate(): void {}

	/** Read-only view of the machine, for hosts that host it and for tests. */
	get state(): { phase: "start" | "end"; cursor: number; pending: FoldPin | undefined } {
		return { phase: this.phase, cursor: this.selectedIndex, pending: this.pending };
	}

	/** The range the cursor would pin right now: start, plus the end under the cursor. */
	get pending(): FoldPin | undefined {
		if (this.phase !== "end" || !this.start) return undefined;
		const row = this.rows[this.selectedIndex];
		return row ? { fromStep: this.start.fromStep, throughStep: endStepOf(row) } : undefined;
	}

	render(width: number): string[] {
		const pageSize = this.pageSize();
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(pageSize / 2), this.rows.length - pageSize));
		const lines = [this.theme.bold(this.phase === "start" ? PICKER_TITLE : PICKER_END_TITLE), this.header(), ""];
		for (let index = start; index < Math.min(start + pageSize, this.rows.length); index++) {
			lines.push(this.rowLine(this.rows[index], index));
		}
		lines.push("", this.footer());
		return lines.map((line) => truncateToWidth(line, width));
	}

	/**
	 * Phase 1 says what the per-row estimates mean (end = latest). Phase 2 swaps
	 * that for the pending range and one live figure for it — the row estimates
	 * alone cannot answer "what would this whole cut cost", and computing every
	 * pair up front would be an O(n²) walk.
	 */
	private header(): string {
		const theme = this.theme;
		if (this.phase === "start") {
			return theme.fg("dim", `Pick a start; the end is the latest finished step. ${ESTIMATE_LEGEND}.`);
		}
		const pending = this.pending;
		// Phase "end" always has a start and a cursor row, so a missing pending here is a
		// view with no rows at all — printed without a bracket rather than with a fake one.
		const bracket = pending ? foldBracket(pending.fromStep, pending.throughStep) : "";
		const figure = pending ? this.figureFor(pending.fromStep, pending.throughStep) : undefined;
		return theme.fg("dim", ["Pending", bracket, figure, `(${ESTIMATE_LEGEND})`].filter((part) => !!part).join("  "));
	}

	/** The memoised figure for one `(start, end)` pair; `undefined` means no figure. */
	private figureFor(fromStep: number, throughStep: number): string | undefined {
		const key = `${fromStep}\u2192${throughStep}`;
		if (!this.memo.has(key)) this.memo.set(key, this.rangeEstimate?.(fromStep, throughStep));
		return this.memo.get(key);
	}

	handleInput(data: string): void {
		const action = this.actionFor(data);
		const last = this.rows.length - 1;

		if (action === "confirm") {
			const row = this.rows[this.selectedIndex];
			if (!row) return;
			if (this.phase === "start") {
				this.start = row;
				this.startIndex = this.selectedIndex;
				this.phase = "end";
				// Pre-position the default end: rows are latest first, so index 0 IS
				// the latest finished step — Enter here gives today's cut.
				this.selectedIndex = 0;
				return;
			}
			if (this.start) this.onSelect({ fromStep: this.start.fromStep, throughStep: endStepOf(row) });
			return;
		}

		if (action === "cancel") {
			// One phase back; only the first phase can cancel the whole command.
			if (this.phase === "end") {
				this.phase = "start";
				this.selectedIndex = this.startIndex;
				return;
			}
			this.onCancel();
			return;
		}

		let delta: number;
		switch (action) {
			case "up":
				delta = -1;
				break;
			case "down":
				delta = 1;
				break;
			case "pageUp":
				delta = -this.pageSize();
				break;
			case "pageDown":
				delta = this.pageSize();
				break;
			default:
				return;
		}
		let target = Math.max(0, Math.min(last, this.selectedIndex + delta));
		// Rows older than the start are not ends: the cursor stops before them
		// instead of visiting dimmed rows. (Above the start every row is a valid
		// end, so the up direction needs no clamp.)
		if (this.phase === "end") target = Math.min(target, this.startIndex);
		this.selectedIndex = target;
	}

	/** Could this row be pinned as the end of the range already started? */
	private isEndRow(index: number): boolean {
		if (this.phase !== "end" || !this.start) return true;
		return endStepOf(this.rows[index]) >= this.start.fromStep;
	}

	/** Which action this key press means: the host's key map, then the raw keys. */
	private actionFor(data: string): Action | undefined {
		for (const [id, action] of BINDINGS) {
			if (this.keybindings.matches(data, id)) return action;
		}
		return RAW_ACTIONS[data];
	}

	/**
	 * A /tree-style window: at least five rows while the terminal has room,
	 * shrinking on short terminals so the chrome always fits on screen.
	 */
	private pageSize(): number {
		return Math.min(
			this.rows.length,
			Math.max(5, Math.floor(this.terminalRows / 2)),
			Math.max(1, this.terminalRows - CHROME_LINES),
		);
	}

	/** Mirrors FoldPickerRow.label — same parts, same two-space joins, colourised. */
	private rowLine(row: FoldPickerRow, index: number): string {
		const theme = this.theme;
		const enabled = this.isEndRow(index);
		const selected = index === this.selectedIndex;
		// Phase 2 marks the rows that can still be an end with a gutter. The gutter
		// and not a background, because `selectedBg` is the cursor's signal alone.
		const gutter = this.phase === "end" && enabled ? theme.fg("muted", "│ ") : "  ";
		const cursor = selected ? theme.fg("accent", "› ") : "  ";
		if (!enabled) return gutter + cursor + theme.fg("dim", row.label);
		const folded = row.kind === "folded";
		const head = folded
			? theme.fg("warning", foldBracket(row.range?.[0] ?? row.fromStep, row.range?.[1] ?? row.fromStep))
			: theme.fg("accent", String(row.fromStep));
		const role = folded ? "fold" : row.role;
		const peek =
			(role ? theme.fg(folded ? "muted" : "success", `${role}: `) : "") +
			(row.preview ? theme.fg("text", row.preview) : "");
		const tail = row.estimate ? theme.fg("dim", row.estimate) : undefined;
		const body = [head, peek, tail].filter((part) => !!part).join("  ");
		return gutter + cursor + (selected ? theme.bg("selectedBg", body) : body);
	}

	private footer(): string {
		const counter = this.theme.fg("muted", `(${this.selectedIndex + 1}/${this.rows.length})`);
		const escape = this.phase === "end" ? "back" : "cancel";
		return [
			hintOrFallback(() => rawKeyHint("↑↓", "navigate"), "↑↓ navigate"),
			hintOrFallback(() => keyHint("tui.select.confirm", "select"), "enter select"),
			hintOrFallback(() => keyHint("tui.select.cancel", escape), `esc ${escape}`),
			counter,
		].join("  ");
	}
}

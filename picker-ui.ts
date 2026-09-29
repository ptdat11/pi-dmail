/**
 * The scrollable /tree-style picker component behind `/dmail fold` (ticket 07):
 * row styling (cursor, role/range colours, dim estimate) and the centred scroll
 * window — built as a plain pi-tui Component (no Container), driven through
 * render()/handleInput().
 */
import { keyHint, rawKeyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, truncateToWidth, type Component, type KeybindingsManager } from "@earendil-works/pi-tui";
import { ESTIMATE_LEGEND, foldBracket, PICKER_TITLE, type FoldPickerRow } from "./picker.ts";

export interface FoldPickerOptions {
	rows: FoldPickerRow[];
	theme: Theme;
	/** Terminal height in rows — drives the size of the scroll window. */
	terminalRows: number;
	/** Hand the chosen row's pinned start back to the caller. */
	onSelect: (fromStep: number) => void;
	onCancel: () => void;
	/** Defaults to pi's global keybindings when omitted. */
	keybindings?: Pick<KeybindingsManager, "matches">;
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
	private readonly onSelect: (fromStep: number) => void;
	private readonly onCancel: () => void;
	private readonly keybindings: Pick<KeybindingsManager, "matches">;
	private selectedIndex = 0;

	constructor(options: FoldPickerOptions) {
		this.rows = options.rows;
		this.theme = options.theme;
		this.terminalRows = options.terminalRows;
		this.onSelect = options.onSelect;
		this.onCancel = options.onCancel;
		this.keybindings = options.keybindings || getKeybindings();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const pageSize = this.pageSize();
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(pageSize / 2), this.rows.length - pageSize));
		const lines = [
			this.theme.bold(PICKER_TITLE),
			this.theme.fg("dim", `Pick a start; the end is the latest finished step. ${ESTIMATE_LEGEND}.`),
			"",
		];
		for (let index = start; index < Math.min(start + pageSize, this.rows.length); index++) {
			lines.push(this.rowLine(this.rows[index], index));
		}
		lines.push("", this.footer());
		return lines.map((line) => truncateToWidth(line, width));
	}

	handleInput(data: string): void {
		const action = this.actionFor(data);
		const last = this.rows.length - 1;
		switch (action) {
			case "up":
				this.selectedIndex = Math.max(0, this.selectedIndex - 1);
				break;
			case "down":
				this.selectedIndex = Math.min(last, this.selectedIndex + 1);
				break;
			case "pageUp":
				this.selectedIndex = Math.max(0, this.selectedIndex - this.pageSize());
				break;
			case "pageDown":
				this.selectedIndex = Math.min(last, this.selectedIndex + this.pageSize());
				break;
			case "confirm": {
				const row = this.rows[this.selectedIndex];
				if (row) this.onSelect(row.fromStep);
				break;
			}
			case "cancel":
				this.onCancel();
				break;
		}
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
		const selected = index === this.selectedIndex;
		const cursor = selected ? theme.fg("accent", "› ") : "  ";
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
		return cursor + (selected ? theme.bg("selectedBg", body) : body);
	}

	private footer(): string {
		const counter = this.theme.fg("muted", `(${this.selectedIndex + 1}/${this.rows.length})`);
		return [
			hintOrFallback(() => rawKeyHint("↑↓", "navigate"), "↑↓ navigate"),
			hintOrFallback(() => keyHint("tui.select.confirm", "select"), "enter select"),
			hintOrFallback(() => keyHint("tui.select.cancel", "cancel"), "esc cancel"),
			counter,
		].join("  ");
	}
}

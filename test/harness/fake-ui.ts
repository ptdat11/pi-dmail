// Fake extension UI: records every interactive call and answers scripted ones.
// notify/setStatus always record; select/input/confirm require a scripted answer,
// so a test that drives real interaction fails loudly instead of silently cancelling.

import { endStepOf } from "../../picker.ts";

/** Sentinel returned by a script to make select/input cancel (resolve undefined). */
export const CANCEL = Symbol("fake-ui.cancel");

type SelectScript = string | typeof CANCEL;
type InputScript = string | typeof CANCEL;

export interface Notification {
	message: string;
	type?: "info" | "warning" | "error";
}

export interface FakeUi {
	readonly notifications: Notification[];
	readonly statuses: { key: string; text: string | undefined }[];
	readonly selects: { title: string; options: readonly string[] }[];
	readonly inputs: { title: string; placeholder?: string }[];
	readonly confirms: { title: string; message: string }[];
	/** Components handed to custom() — the TUI picker tests read their state. */
	readonly customs: { component: any }[];
	/** Theme handed to badges/renderResult: identity styling, no ANSI. */
	readonly theme: Record<string, (...args: any[]) => string>;
	scriptSelect(...values: SelectScript[]): void;
	scriptInput(...values: InputScript[]): void;
	scriptConfirm(...values: boolean[]): void;
	scriptCustom(...values: any[]): void;
	/** The ExtensionUIContext-shaped object handed to the extension. */
	readonly ui: FakeUiContext;
}

/** Structural stand-in for pi's ExtensionUIContext (the ctx seam). */
export interface FakeUiContext {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus(key: string, text?: string): void;
	select(title: string, options: readonly string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	/** Show a custom component with keyboard focus (TUI mode). */
	custom<T>(factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => any): Promise<T | undefined>;
	theme: Record<string, (...args: any[]) => string>;
}

export function createFakeUi(): FakeUi {
	const notifications: Notification[] = [];
	const statuses: { key: string; text: string | undefined }[] = [];
	const selects: { title: string; options: readonly string[] }[] = [];
	const inputs: { title: string; placeholder?: string }[] = [];
	const confirms: { title: string; message: string }[] = [];
	const customs: { component: any }[] = [];
	const selectScript: SelectScript[] = [];
	const inputScript: InputScript[] = [];
	const confirmScript: boolean[] = [];
	const customScript: any[] = [];

	// Identity theme: colors collapse to their text so assertions read plain strings.
	const theme: Record<string, (...args: any[]) => string> = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		getFgAnsi: () => "",
	};

	function take<T>(script: T[], label: string): T {
		if (script.length === 0) {
			const helper = `script${label.charAt(0).toUpperCase()}${label.slice(1)}`;
			throw new Error(`fake-ui: ${label}() called with no scripted response — use ${helper}() first.`);
		}
		return script.shift()!;
	}

	const ui = {
		notify(message: string, type?: "info" | "warning" | "error") {
			notifications.push({ message, type });
		},
		setStatus(key: string, text: string | undefined) {
			statuses.push({ key, text });
		},
		async select(title: string, options: readonly string[]): Promise<string | undefined> {
			selects.push({ title, options });
			const answer = take(selectScript, "select");
			return answer === CANCEL ? undefined : answer;
		},
		async input(title: string, placeholder?: string): Promise<string | undefined> {
			inputs.push({ title, placeholder });
			const answer = take(inputScript, "input");
			return answer === CANCEL ? undefined : answer;
		},
		async confirm(title: string, message: string): Promise<boolean> {
			confirms.push({ title, message });
			return take(confirmScript, "confirm");
		},
		async custom<T>(factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => any): Promise<T | undefined> {
			// Stand-in TUI and keybindings: enough for the component to record and to
			// handle raw keys. The scripted answer is delivered the way the real
			// custom() resolves — through `done`, driven by the component itself.
			const fakeTui = { terminal: { rows: 40 } };
			let settle: (value: T | undefined) => void = () => {};
			const resolved = new Promise<T | undefined>((resolve) => {
				settle = resolve;
			});
			const done = (result: T) => settle(result);
			const component = await factory(fakeTui, theme, { matches: () => false }, done);
			customs.push({ component });
			const answer = take(customScript, "custom");
			if (answer === CANCEL) {
				component.handleInput?.("\x1b"); // esc in phase 1 → onCancel → done(undefined)
				return resolved;
			}
			// Drive the two-phase picker through its real key handler: walk to the start row
			// and press enter, then walk to the end row and press enter → onSelect → done.
			// A number answers the start only (the end stays at its default); an object answers
			// both ends and may ask for an esc back to phase 1 in between.
			const rows: any[] = component.rows ?? [];
			const press = (key: string) => component.handleInput?.(key);
			const goto = (index: number) => {
				const here: number = component.state?.cursor ?? 0;
				for (let i = here; i < index; i++) press("j"); // down
				for (let i = index; i < here; i++) press("k"); // up
			};
			const request = typeof answer === "number" ? { fromStep: answer } : answer;
			const startAt = rows.findIndex((row) => row.fromStep === request.fromStep);
			if (startAt < 0) {
				done(answer as T); // an unknown start: the caller's lookup resolves it
				return resolved;
			}
			goto(startAt);
			press("\n");
			if (request.back === true) {
				press("\x1b"); // esc in phase 2 → back to phase 1, free to pick another start
				const nextAt = rows.findIndex((row) => row.fromStep === request.thenFromStep);
				if (nextAt < 0) throw new Error(`fake-ui: no start row for ${request.thenFromStep}`);
				goto(nextAt);
				press("\n");
			}
			// The default end is what the component itself pre-positioned; a scripted one is walked to.
			const endStep = request.throughStep ?? component.state?.pending?.throughStep;
			const endAt = rows.findIndex((row) => endStepOf(row) === endStep);
			if (endAt >= 0) {
				goto(endAt);
				if (component.state?.pending?.throughStep !== endStep) {
					throw new Error(`fake-ui: the end cursor did not land on step ${endStep}`);
				}
			}
			press("\n");
			return resolved;
		},
		theme,
	};

	return {
		notifications,
		statuses,
		selects,
		inputs,
		confirms,
		customs,
		theme,
		scriptSelect: (...values) => selectScript.push(...values),
		scriptInput: (...values) => inputScript.push(...values),
		scriptConfirm: (...values) => confirmScript.push(...values),
		scriptCustom: (...values) => customScript.push(...values),
		ui: ui as FakeUiContext,
	};
}

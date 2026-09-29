// Fake pi ExtensionAPI: captures everything the extension registers (tools,
// commands, flags, hooks) and records runtime calls (appendEntry, sendUserMessage,
// active-tools mutations). Unimplemented members throw a named error instead of
// failing as undefined-is-not-a-function.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SessionFixture } from "./fixtures.ts";

export interface RegisteredTool {
	name: string;
	description: string;
	label?: string;
	promptSnippet?: string;
	parameters: unknown;
	execute: (...args: any[]) => Promise<any>;
	/**
	 * Rendering contract only: pi-tui's `Component` is not re-exported by the
	 * package root, so this names just the method the harness calls —
	 * `render(width) -> lines` (pi-tui `Component.render`).
	 */
	renderResult?: (...args: any[]) => RenderedComponent;
}

export interface RegisteredCommand {
	name: string;
	options: { description?: string; handler: (args: string, ctx: unknown) => unknown | Promise<unknown> };
}

export interface RegisteredFlag {
	name: string;
	options: { description?: string; type: "boolean" | "string"; default?: boolean | string };
}

/** What harness rendering calls on a tool result; see `RegisteredTool.renderResult`. */
export interface RenderedComponent {
	render(width: number): string[];
}

/**
 * A hook handler as the dispatcher sees it. Pi calls hooks as `(event, ctx)`,
 * but `dispatchHook` forwards whatever array the caller passed, so the handler
 * must take rest args — a fixed-arity signature cannot be spread from an
 * `unknown[]` (TS2556). Rest args still accept the same `(event, ctx)` handlers;
 * `unknown[]` (not `any[]`) keeps the forwarded values untyped-but-checked.
 */
export type HookHandler = (...args: unknown[]) => unknown | Promise<unknown>;

export interface FakePi {
	/** The object handed to the extension's default export. */
	readonly api: ExtensionAPI;
	readonly tools: Map<string, RegisteredTool>;
	readonly commands: Map<string, RegisteredCommand>;
	readonly flags: Map<string, RegisteredFlag>;
	readonly hooks: Map<string, HookHandler[]>;
	/** Everything appendEntry was called with, in order. */
	readonly appended: { customType: string; data: unknown }[];
	/** Everything sendUserMessage was called with, in order. */
	readonly sentMessages: { content: unknown; options?: Record<string, unknown> }[];
	/** Flag overrides set by a test (beyond registerFlag defaults). */
	readonly flagValues: Map<string, boolean | string | undefined>;
	/** setActiveTools override; undefined until first set (default: all registered tools). */
	activeToolsOverride: string[] | undefined;
	setFlag(name: string, value: boolean | string | undefined): void;
}

/**
 * @param fixture — when present, appendEntry also persists a CustomEntry onto the
 * fixture (id/parentId/timestamp chained), mirroring pi's session append.
 */
export function createFakePi(fixture?: SessionFixture): FakePi {
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, RegisteredCommand>();
	const flags = new Map<string, RegisteredFlag>();
	const hooks = new Map<string, HookHandler[]>();
	const appended: { customType: string; data: unknown }[] = [];
	const sentMessages: { content: unknown; options?: Record<string, unknown> }[] = [];
	const flagValues = new Map<string, boolean | string | undefined>();
	let activeTools: string[] | undefined;

	const impl = {
		on(event: string, handler: HookHandler) {
			const list = hooks.get(event) ?? [];
			list.push(handler);
			hooks.set(event, list);
		},
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, options: RegisteredCommand["options"]) {
			commands.set(name, { name, options });
		},
		registerFlag(name: string, options: RegisteredFlag["options"]) {
			flags.set(name, { name, options });
		},
		getFlag(name: string) {
			if (flagValues.has(name)) return flagValues.get(name);
			return flags.get(name)?.options.default;
		},
		getActiveTools(): string[] {
			return activeTools ?? [...tools.keys()];
		},
		setActiveTools(names: string[]) {
			activeTools = [...names];
		},
		appendEntry(customType: string, data?: unknown) {
			appended.push({ customType, data });
			fixture?.append({ type: "custom", customType, data });
		},
		sendUserMessage(content: unknown, options?: Record<string, unknown>) {
			sentMessages.push({ content, options });
			return Promise.resolve(undefined);
		},
	};

	const api = new Proxy(impl as Record<string, unknown>, {
		get(target, prop, receiver) {
			if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);
			if (prop in target) return Reflect.get(target, prop, receiver);
			throw new Error(`fake-pi: ExtensionAPI.${prop} is not implemented in the harness.`);
		},
	}) as unknown as ExtensionAPI;

	return {
		api,
		tools,
		commands,
		flags,
		hooks,
		appended,
		sentMessages,
		flagValues,
		get activeToolsOverride() {
			return activeTools;
		},
		set activeToolsOverride(value: string[] | undefined) {
			activeTools = value === undefined ? undefined : [...value];
		},
		setFlag(name, value) {
			flagValues.set(name, value);
		},
	};
}

/** Dispatch one registered hook event; returns handler results in order. */
export async function dispatchHook(pi: FakePi, event: string, ...args: unknown[]): Promise<unknown[]> {
	const results: unknown[] = [];
	for (const handler of pi.hooks.get(event) ?? []) {
		results.push(await handler(...args));
	}
	return results;
}

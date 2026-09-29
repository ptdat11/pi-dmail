// Harness orchestrator: registers the extension against a fake pi, hands it a
// fake context (fake UI + fixture-backed session), and exposes small helpers to
// drive events, execute the fold tool, and render its result — the seam every
// dmail test drives the extension through.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FakePi, RegisteredTool } from "./fake-pi.ts";
import type { FakeUi } from "./fake-ui.ts";
import { createFakePi, dispatchHook } from "./fake-pi.ts";
import { createFakeUi } from "./fake-ui.ts";
import { SessionFixture, threeStepSession } from "./fixtures.ts";
import { installResolveHooks } from "./resolve.ts";

export { CANCEL, createFakeUi } from "./fake-ui.ts";
export { createFakePi, dispatchHook } from "./fake-pi.ts";
export { SessionFixture, threeStepSession } from "./fixtures.ts";
export { installResolveHooks, piPackageRoot } from "./resolve.ts";
export type { FakePi, RegisteredTool } from "./fake-pi.ts";
export type { FakeUi, FakeUiContext } from "./fake-ui.ts";

export interface HarnessOptions {
	/** Session the extension sees. Defaults to a three-step session. */
	fixture?: SessionFixture;
	/** Project dir reported as ctx.cwd (project settings live under `<cwd>/.pi`). */
	cwd?: string;
	/** Sandbox for pi's global settings (`<agentDir>/settings.json`). Defaults to a fresh temp dir. */
	agentDir?: string;
	/** ctx.isProjectTrusted(); default true (lets the extension read project settings). */
	trusted?: boolean;
	/** ctx.isIdle(); default true. */
	idle?: boolean;
}

export interface Harness {
	readonly fixture: SessionFixture;
	readonly pi: FakePi;
	readonly ui: FakeUi;
	readonly ctx: ExtensionContext;
	readonly cwd: string;
	readonly agentDir: string;
	/** Dispatch a hook event to the extension; results in handler order. */
	dispatch(event: string, ...args: unknown[]): Promise<unknown[]>;
	/** Fire `session_start` with the given reason (default "startup"). */
	start(reason?: "startup" | "reload" | "new" | "resume" | "fork"): Promise<unknown[]>;
	/** Registered tool (default "send_dmail"). */
	tool(name?: string): RegisteredTool;
	/** Run a registered command's handler against the harness ctx. */
	runCommand(name: string, args?: string): Promise<unknown>;
	/** Execute the fold tool like pi would. */
	execute(params: Record<string, unknown>, toolCallId?: string): Promise<any>;
	/** Render a tool result; `text` is the component's plain output at 120 cols. */
	render(
		result: any,
		opts?: { args?: Record<string, unknown>; expanded?: boolean; toolCallId?: string },
	): { component: any; text: () => string };
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	installResolveHooks();

	// Sandbox pi's global config reads before anything resolves settings.
	const agentDir = options.agentDir ?? mkdtempSync(join(tmpdir(), "dmail-harness-agent-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const fixture = options.fixture ?? threeStepSession();
	const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), "dmail-harness-cwd-"));
	const ui = createFakeUi();
	const pi = createFakePi(fixture);

	const piApi = await import("@earendil-works/pi-coding-agent");
	// keyHint()/Text read pi's global theme; renderResult needs it initialized.
	if (!themeInitialized) {
		piApi.initTheme(undefined, false);
		themeInitialized = true;
	}
	const { default: dmail } = await import("../../index.ts");

	const ctx = {
		cwd,
		ui: ui.ui,
		isIdle: () => options.idle ?? true,
		isProjectTrusted: () => options.trusted ?? true,
		sessionManager: {
			getBranch: () => fixture.entries.slice(),
			buildContextEntries: () => piApi.buildContextEntries(fixture.entries),
			getEntries: () => fixture.entries.slice(),
			getLeafId: () => fixture.entries.at(-1)?.id ?? null,
			getEntry: (id: string) => fixture.entries.find((e) => e.id === id),
			getCwd: () => cwd,
		},
	} as unknown as ExtensionContext;

	// Register exactly as pi would: the default export wires its own hooks.
	dmail(pi.api);

	const harness: Harness = {
		fixture,
		pi,
		ui,
		ctx,
		cwd,
		agentDir,
		dispatch: (event, ...args) => dispatchHook(pi, event, ...args),
		async start(reason = "startup") {
			// Re-assert this harness's sandbox: env is process-global, later harnesses win otherwise.
			process.env.PI_CODING_AGENT_DIR = agentDir;
			return dispatchHook(pi, "session_start", { type: "session_start", reason }, ctx);
		},
		tool(name = "send_dmail") {
			const tool = pi.tools.get(name);
			if (!tool) throw new Error(`harness: no tool registered under "${name}".`);
			return tool;
		},
		async runCommand(name, args = "") {
			const command = pi.commands.get(name);
			if (!command) throw new Error(`harness: no command registered under "${name}".`);
			return command.options.handler(args, ctx);
		},
		async execute(params, toolCallId = "call-1") {
			return harness.tool().execute(toolCallId, params, undefined, () => {}, ctx);
		},
		render(result, { args = {}, expanded = false, toolCallId = "call-1" } = {}) {
			const tool = harness.tool();
			if (!tool.renderResult) throw new Error(`harness: tool "${tool.name}" has no renderResult.`);
			const renderContext = { args, toolCallId, cwd };
			const component = tool.renderResult(result, { expanded, isPartial: false }, ui.theme, renderContext);
			return { component, text: () => String(component.render(120).join("\n")) };
		},
	};

	return harness;
}

let themeInitialized = false;

// Redirects the three bare specifiers index.ts imports to a real pi installation,
// so tests drive the extension with the exact packages pi itself runs with.
// Same override policy as profile.ts's loadPi(): PI_CODING_AGENT_PACKAGE wins,
// otherwise `npm root -g`.
import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let cachedRoot: string | undefined;
let hooksInstalled = false;

const FALLBACK_PACKAGE = "@earendil-works/pi-coding-agent";

/** Normalize PI_CODING_AGENT_PACKAGE: file URL, package root, dist dir, or dist/index.js. */
function normalizeRoot(raw: string): string {
	let path = raw.startsWith("file:") ? fileURLToPath(raw) : raw;
	if (!existsSync(path)) throw new Error(`PI_CODING_AGENT_PACKAGE does not exist: ${raw}`);
	if (!statSync(path).isDirectory()) path = dirname(path); // .../dist/index.js → .../dist
	if (basename(path) === "dist") path = dirname(path); // .../dist → package root
	return path;
}

/** Absolute path of the pi-coding-agent package root tests load. */
export function piPackageRoot(): string {
	if (cachedRoot) return cachedRoot;
	const override = process.env.PI_CODING_AGENT_PACKAGE;
	if (override) {
		cachedRoot = normalizeRoot(override);
	} else {
		const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
		cachedRoot = join(globalRoot, FALLBACK_PACKAGE);
	}
	const entry = join(cachedRoot, "dist", "index.js");
	if (!existsSync(entry)) {
		throw new Error(
			`pi-coding-agent not found at ${cachedRoot} (expected dist/index.js). ` +
				`Set PI_CODING_AGENT_PACKAGE to a pi installation, or install ${FALLBACK_PACKAGE} globally.`,
		);
	}
	return cachedRoot;
}

/** Bare specifier → absolute file path, for the packages index.ts imports by name. */
function targets(): Record<string, string> {
	const root = piPackageRoot();
	return {
		"@earendil-works/pi-coding-agent": join(root, "dist", "index.js"),
		"@earendil-works/pi-tui": join(root, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"),
		typebox: join(root, "node_modules", "typebox", "build", "index.mjs"),
	};
}

/**
 * Install in-process resolve hooks (idempotent). After this, dynamic-importing
 * index.ts works under bare `node --test` with no node_modules in this repo.
 */
export function installResolveHooks(): void {
	if (hooksInstalled) return;
	hooksInstalled = true;
	const map = targets();
	registerHooks({
		resolve(specifier, context, nextResolve) {
			const target = map[specifier];
			if (target !== undefined) {
				if (!existsSync(target)) throw new Error(`Resolved ${specifier} → ${target}, which does not exist.`);
				// registerHooks needs a file:// URL, not a bare path.
				return { url: pathToFileURL(target).href, shortCircuit: true };
			}
			return nextResolve(specifier, context);
		},
	});
}

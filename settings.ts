/**
 * Reading D-Mail's default on/off mode from Pi's settings files.
 *
 * Pi's settings have no extension namespace, and the extension API exposes no
 * SettingsManager, so the one key D-Mail owns is read straight from the same
 * files Pi loads and merges:
 *
 *   ~/.pi/agent/settings.json   global
 *   <cwd>/.pi/settings.json     project, overrides global
 *
 * The key is deliberately nested and narrow:
 *
 *   { "dmail": { "enabled": false } }
 *
 * Absent, non-boolean, or unparseable means "on", which is the behavior every
 * session had before this file existed. Pi preserves keys it does not know when
 * it rewrites settings, so this one survives `/settings` writes untouched.
 *
 * The two interesting functions here are pure and take text, not paths, so they
 * are unit-testable without a filesystem or Pi.
 */
import { readFileSync } from "node:fs";

/** The parsed shape of the one key D-Mail reads. Everything else is ignored. */
interface SettingsFile {
	dmail?: {
		enabled?: unknown;
	};
}

/**
 * The `dmail.enabled` value in one settings file, or undefined when the file
 * does not say. A malformed file is treated as silent rather than fatal: the
 * worst case is a default, and Pi will report its own settings errors.
 */
export function dmailEnabledIn(settingsText: string | undefined): boolean | undefined {
	if (settingsText === undefined) return undefined;
	let parsed: SettingsFile;
	try {
		parsed = JSON.parse(settingsText) as SettingsFile;
	} catch {
		return undefined;
	}
	const value = parsed?.dmail?.enabled;
	return typeof value === "boolean" ? value : undefined;
}

/**
 * Resolve the default mode. Project beats global, and anything unset means on,
 * so a session with no configuration behaves exactly as it did before.
 */
export function resolveDmailEnabled(
	globalText: string | undefined,
	projectText: string | undefined,
): boolean {
	return dmailEnabledIn(projectText) ?? dmailEnabledIn(globalText) ?? true;
}

/** Read a settings file, treating missing/unreadable as "says nothing". */
export function readSettingsFile(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

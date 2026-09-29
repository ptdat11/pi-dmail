// Fixture builders: synthetic sessions made of raw pi SessionEntry records.
// Everything is append-only; ids and parentId chain in insertion order so the
// real buildContextEntries() walks the fixture exactly like a real branch.
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { FOLD_TYPE } from "../../fold.ts";

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

export class SessionFixture {
	readonly entries: SessionEntry[] = [];
	private counter = 0;
	private lastId: string | null = null;
	private clock = Date.parse("2024-01-01T00:00:00.000Z");

	/** Append a raw entry, filling id/parentId/timestamp from the chain. */
	append(raw: Record<string, unknown>): SessionEntry {
		this.counter += 1;
		this.clock += 1000;
		const entry = {
			...raw,
			id: `e${this.counter}`,
			parentId: this.lastId,
			timestamp: new Date(this.clock).toISOString(),
		} as SessionEntry;
		this.entries.push(entry);
		this.lastId = entry.id;
		return entry;
	}

	/** User turn (text). */
	user(text: string): SessionEntry {
		return this.append({
			type: "message",
			message: { role: "user", content: [{ type: "text", text }], timestamp: this.clock + 1 },
		});
	}

	/** Assistant turn (text only). Assistant messages are step boundaries. */
	assistant(text: string): SessionEntry {
		return this.append({
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-test",
				usage: { ...ZERO_USAGE },
				stopReason: "stop",
				timestamp: this.clock + 1,
			},
		});
	}

	/** Assistant turn that calls a tool; pair with toolResult(). */
	toolCall(name: string, args: Record<string, unknown> = {}, text?: string): SessionEntry {
		const toolCallId = `tc${this.counter + 1}`;
		const content: unknown[] = text === undefined ? [] : [{ type: "text", text }];
		content.push({ type: "toolCall", id: toolCallId, name, arguments: args });
		return this.append({
			type: "message",
			message: {
				role: "assistant",
				content,
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-test",
				usage: { ...ZERO_USAGE },
				stopReason: "toolUse",
				timestamp: this.clock + 1,
			},
		});
	}

	/** Result of a tool call (role "toolResult"; not a step boundary). */
	toolResult(toolCallId: string, toolName: string, text: string): SessionEntry {
		return this.append({
			type: "message",
			message: {
				role: "toolResult",
				toolCallId,
				toolName,
				content: [{ type: "text", text }],
				isError: false,
				timestamp: this.clock + 1,
			},
		});
	}

	/** Compaction boundary: everything before firstKeptEntryId leaves the view. */
	compaction(opts: { summary: string; firstKeptEntryId: string; tokensBefore?: number }): SessionEntry {
		return this.append({ type: "compaction", tokensBefore: 1000, ...opts });
	}

	/** A dmail fold record as the extension appends it. */
	foldRecord(data: { fromEntryId: string; toEntryId: string; summary: string; fromStep?: number }): SessionEntry {
		return this.append({ type: "custom", customType: FOLD_TYPE, data });
	}

	/** Any other extension's custom entry. */
	custom(customType: string, data?: unknown): SessionEntry {
		return this.append({ type: "custom", customType, data });
	}
}

/**
 * A short standard session: three exchanges, so three visible steps
 * (user e1 → assistant e2 … user e5 → assistant e6). Steps = assistant messages.
 */
export function threeStepSession(): SessionFixture {
	const fx = new SessionFixture();
	fx.user("first question");
	fx.assistant("first answer");
	fx.user("second question");
	fx.assistant("second answer");
	fx.user("third question");
	fx.assistant("third answer");
	return fx;
}

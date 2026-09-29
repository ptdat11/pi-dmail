// E2E fixture provider: pi talks to a real model-shaped provider with no network.
//
// The verification (test/e2e/verify.ts) runs a real `pi --mode rpc` process. That
// process must answer three different kinds of request, and it must answer each
// one the way a competent model would, so that the assertions mean something:
//
//   1. Ordinary prompts — reply with a marker that later gets folded away
//      (`DROPPED_DETAIL`), so the compaction summarizer is *offered* that
//      detail in the raw conversation.
//   2. A prompt carrying `FOLD_TRIGGER` — call the real `send_dmail` tool, so
//      the fixture session's fold record is written by pi's own tool path
//      rather than hand-authored.
//   3. A summarization request (pi's compaction) — behave like the model pi's
//      update prompt addresses: when a `<previous-summary>` channel is present
//      (the seam's splice), preserve what it carries verbatim; when it is
//      absent, fall back to digesting the raw conversation. That fallback is
//      what makes the assertions discriminating: if the seam never fires, the
//      summary comes from the raw messages and carries `DROPPED_DETAIL`.
//
// Responses come from pi-ai's faux core (the same test double pi's own tests
// use): it streams, accounts usage, and reports auth as resolved without ever
// opening a socket. One context-aware factory is queued for every call, so the
// order of agent turns, tool calls, and the summarization call cannot exhaust
// the script.
import { appendFileSync } from "node:fs";
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** pi provider id the driver selects with `--provider`. */
export const PROVIDER_ID = "e2e-mock";
/** Model id the driver selects with `--model`. */
export const MODEL_ID = "mock-summarizer";
/** The tool the fixture must call to create a genuine fold record. */
export const FOLD_TOOL = "send_dmail";

/** Present only in the assistant reply that the fold will later fold away. */
export const DROPPED_DETAIL = "E2E_DROPPED_DETAIL_4d1f9a";
/** Present only in the fold summary — the narrative the seam must carry. */
export const FOLD_NARRATIVE = "E2E_FOLD_NARRATIVE_8b6c27";
/** The prompt phrase that makes the model call `send_dmail`. */
export const FOLD_TRIGGER = "E2E_FOLD_TRIGGER";
/** The fold summary the model writes; its marker is what must survive compaction. */
export const FOLD_SUMMARY =
	`Folded step 1 away: ${FOLD_NARRATIVE}. ` +
	"The earlier exploration is finished and nothing in it is needed again.";

// ---------------------------------------------------------------------------
// Transcript inspection
// ---------------------------------------------------------------------------

function blockText(block: unknown): string {
	if (typeof block === "string") return block;
	if (!block || typeof block !== "object") return "";
	const b = block as Record<string, unknown>;
	switch (b.type) {
		case "text":
			return typeof b.text === "string" ? b.text : "";
		case "thinking":
			return typeof b.thinking === "string" ? b.thinking : "";
		case "toolCall":
			return `${String(b.name ?? "")} ${JSON.stringify(b.arguments ?? {})}`;
		case "image":
			return `[image:${String(b.mimeType ?? "unknown")}]`;
		default:
			return JSON.stringify(b);
	}
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map(blockText).join("\n");
	return "";
}

type RawMessage = { role?: string; content?: unknown };

function messagesOf(context: TranscriptContext): RawMessage[] {
	return (context as { messages?: RawMessage[] }).messages ?? [];
}

/** Everything the model is being asked, flattened to one searchable string. */
function transcriptText(context: TranscriptContext): string {
	return messagesOf(context)
		.map((m) => `${m.role ?? "?"}:${contentText(m.content)}`)
		.join("\n\n");
}

function isSummarization(text: string): boolean {
	return (
		text.includes("context summarization assistant") ||
		text.includes("conversation to summarize") ||
		text.includes("NEW conversation messages to incorporate")
	);
}

function lastRole(context: TranscriptContext): string {
	const messages = messagesOf(context);
	const last = messages[messages.length - 1];
	return last?.role ?? "";
}

function hasAssistantReply(context: TranscriptContext): boolean {
	return messagesOf(context).some((m) => m.role === "assistant");
}

// ---------------------------------------------------------------------------
// The three answers
// ---------------------------------------------------------------------------

/**
 * Summarization: the update prompt tells the model to preserve everything in
 * `<previous-summary>`, so preserve it. Without a channel there is nothing to
 * preserve and the digest below is built from the raw conversation instead —
 * which is exactly the pre-seam behavior the assertions watch for.
 */
function summarizationReply(context: TranscriptContext): AssistantMessage {
	const text = transcriptText(context);
	const channel = /<previous-summary>\n([\s\S]*?)\n<\/previous-summary>/.exec(text);
	const body = channel ? channel[1] : "";
	if (body.includes(FOLD_NARRATIVE)) {
		return fauxAssistantMessage(
			[
				fauxText(
					[
						"## Goal",
						"E2E fixture session for the fold-ladders compaction seam.",
						"",
						"## Progress",
						"### Done",
						"- [x] earlier steps folded away",
						"",
						"## Key Decisions",
						`- Fold summary: ${FOLD_NARRATIVE}`,
						"",
						"## Critical Context",
						body,
					].join("\n"),
				),
			],
			{ stopReason: "stop" },
		);
	}
	// No seam channel: digest the raw conversation, dropped detail included.
	return fauxAssistantMessage([fauxText(`## Goal\nDigest of raw conversation:\n\n${text.slice(0, 4000)}`)], {
		stopReason: "stop",
	});
}

function reply(context: TranscriptContext): AssistantMessage {
	const text = transcriptText(context);

	if (isSummarization(text)) return summarizationReply(context);
	// After the tool call, acknowledge the record (the trigger phrase is still
	// in the transcript, so this check has to come first).
	if (lastRole(context) === "toolResult") {
		return fauxAssistantMessage([fauxText("Fold record appended. The folded steps stop being sent from the next request.")], {
			stopReason: "stop",
		});
	}
	if (text.includes(FOLD_TRIGGER)) {
		return fauxAssistantMessage(
			[fauxToolCall(FOLD_TOOL, { fromStep: 1, summary: FOLD_SUMMARY })],
			{ stopReason: "toolUse" },
		);
	}
	if (!hasAssistantReply(context)) {
		return fauxAssistantMessage(
			[
				fauxText(
					`Step 1: recorded ${DROPPED_DETAIL} in the transcript so the compaction summarizer has a detail to drop.`,
				),
			],
			{ stopReason: "stop" },
		);
	}
	return fauxAssistantMessage([fauxText("Acknowledged.")], { stopReason: "stop" });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export default function register(pi: ExtensionAPI): void {
	const capture = process.env.DMAIL_E2E_CAPTURE;
	const handle = fauxProvider({
		provider: PROVIDER_ID,
		api: "e2e-mock-api",
		models: [
			{
				id: MODEL_ID,
				name: "E2E Mock Summarizer",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
		],
		// Small chunks keep the stream realistic without slowing the run down.
		tokenSize: { min: 16, max: 64 },
	});

	// Every request is logged before it is answered: the driver asserts on what
	// pi actually put in front of the model, not only on what came back out.
	const factory = (context: TranscriptContext): AssistantMessage => {
		const text = transcriptText(context);
		if (capture) {
			appendFileSync(capture, `${JSON.stringify({ at: new Date().toISOString(), kind: kindOf(text), text })}\n`);
		}
		return reply(context);
	};
	// The faux core shifts one response per request, so queue the same
	// context-aware factory many times: the run's turn count is pi's, not ours.
	handle.setResponses(Array.from({ length: 64 }, () => factory));

	pi.registerProvider(handle.provider);
}

function kindOf(text: string): string {
	if (isSummarization(text)) return "summarization";
	if (text.includes(FOLD_TRIGGER)) return "fold-trigger";
	return "prompt";
}

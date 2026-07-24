import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, relative } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { VirtualContextConfig } from "./config.ts";
import { estimateMessageTokens, estimateProjectedContext, estimateTextTokens, truncateTextToTokens } from "./tokens.ts";

export interface VirtualCheckpoint {
	kind: "smart" | "deterministic";
	sessionId: string;
	cutIndex: number;
	prefixHash: string;
	summary: string;
	sourceTokens: number;
	createdAt: number;
}

export interface ProjectionResult {
	messages: AgentMessage[];
	projectedTokens: number;
	cutIndex: number;
	omittedMessages: number;
	valid: boolean;
}

function canonicalMessage(message: AgentMessage): unknown {
	if (message.role === "assistant") {
		return {
			...message,
			usage: undefined,
			diagnostics: undefined,
			responseId: undefined,
		};
	}
	return message;
}

export function hashMessages(messages: AgentMessage[]): string {
	const hash = createHash("sha256");
	for (const message of messages) hash.update(JSON.stringify(canonicalMessage(message))).update("\n");
	return hash.digest("hex");
}

export function isSafeCutMessage(message: AgentMessage): boolean {
	return message.role === "assistant"
		|| message.role === "user"
		|| message.role === "custom"
		|| message.role === "bashExecution"
		|| message.role === "branchSummary"
		|| message.role === "compactionSummary";
}

export function activeConvergenceControls(messages: AgentMessage[], cutIndex: number): AgentMessage[] {
	let latestUserIndex = -1;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index].role === "user") {
			latestUserIndex = index;
			break;
		}
	}
	return messages.slice(0, cutIndex).filter((message, index) =>
		message.role === "custom"
		&& (message as { customType?: unknown }).customType === "pi-convergence-control"
		&& index > latestUserIndex
	);
}

export interface ProjectionBudget {
	availableTokens: number;
	summaryTokens: number;
	desiredRecentTokens: number;
	maxRecentTokens: number;
	targetReachable: boolean;
}

/**
 * Split the post-projection budget between the checkpoint and recent messages.
 * Recent context keeps its configured amount whenever possible; the summary is
 * reduced first when provider/system overhead leaves less room than expected.
 */
export function planProjectionBudget(
	targetTokens: number,
	overheadTokens: number,
	keepRecentTokens: number,
	summaryReserveTokens: number,
): ProjectionBudget {
	const availableTokens = Math.max(0, targetTokens - overheadTokens);
	const minimumSummaryTokens = Math.min(1_000, Math.max(1, Math.floor(availableTokens / 4)));
	const summaryTokens = Math.min(
		summaryReserveTokens,
		Math.max(minimumSummaryTokens, availableTokens - keepRecentTokens),
	);
	const maxRecentTokens = Math.max(1, availableTokens - summaryTokens);
	return {
		availableTokens,
		summaryTokens,
		desiredRecentTokens: Math.min(keepRecentTokens, maxRecentTokens),
		maxRecentTokens,
		targetReachable: availableTokens >= 2,
	};
}

export function chooseCutIndex(
	messages: AgentMessage[],
	keepRecentTokens: number,
	maxRecentTokens = Number.POSITIVE_INFINITY,
): number {
	let accumulated = 0;
	let safestWithinBudget: number | undefined;
	const desiredTokens = Math.min(keepRecentTokens, maxRecentTokens);
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		accumulated += estimateMessageTokens(messages[index]);
		if (!isSafeCutMessage(messages[index])) continue;
		if (accumulated <= maxRecentTokens) safestWithinBudget = index;
		if (accumulated >= desiredTokens) {
			return accumulated <= maxRecentTokens ? index : (safestWithinBudget ?? index);
		}
	}
	return 0;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block)
		.map((block) => String((block as { text: unknown }).text))
		.join("\n");
}

function assistantText(message: Extract<AgentMessage, { role: "assistant" }>): string {
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

function toolCalls(message: Extract<AgentMessage, { role: "assistant" }>): string[] {
	return message.content
		.filter((block) => block.type === "toolCall")
		.map((block) => `${block.name}(${truncateTextToTokens(JSON.stringify(block.arguments), 160)})`);
}

export function buildDeterministicSummary(
	prefix: AgentMessage[],
	sessionFile: string | undefined,
	maxTokens = 10_000,
): string {
	const existingSummaries: string[] = [];
	const userMessages: string[] = [];
	const assistantUpdates: string[] = [];
	const calls: string[] = [];
	const errors: string[] = [];

	for (const message of prefix) {
		if (message.role === "compactionSummary" || message.role === "branchSummary") {
			existingSummaries.push(truncateTextToTokens(message.summary, 4_000));
		} else if (message.role === "user" || (message.role === "custom" && (message as { customType?: unknown }).customType !== "pi-convergence-control")) {
			const text = contentText(message.content).trim();
			if (text) userMessages.push(truncateTextToTokens(text, 800));
		} else if (message.role === "assistant") {
			const text = assistantText(message).trim();
			if (text) assistantUpdates.push(truncateTextToTokens(text, 600));
			calls.push(...toolCalls(message));
		} else if (message.role === "toolResult" && message.isError) {
			const text = contentText(message.content).trim();
			if (text) errors.push(`${message.toolName}: ${truncateTextToTokens(text, 400)}`);
		}
	}

	const sections = [
		"## Virtual Context emergency checkpoint",
		"This checkpoint was produced deterministically because the background semantic checkpoint was not ready. Treat the newest complete suffix after this summary as authoritative.",
	];
	if (sessionFile) {
		const homeRelative = relative(homedir(), sessionFile);
		const safeSessionFile = homeRelative !== "" && homeRelative !== ".." && !homeRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(homeRelative)
			? `~/${homeRelative}`
			: `[local Pi session: ${basename(sessionFile)}]`;
		sections.push(`Canonical append-only Pi session: ${safeSessionFile}`);
	}
	if (existingSummaries.length > 0) sections.push("## Existing memory\n" + existingSummaries.slice(-2).join("\n\n"));
	if (userMessages.length > 0) sections.push("## Recent user requirements\n" + userMessages.slice(-6).map((item) => `- ${item}`).join("\n"));
	if (assistantUpdates.length > 0) sections.push("## Recent progress reports\n" + assistantUpdates.slice(-6).map((item) => `- ${item}`).join("\n"));
	if (calls.length > 0) sections.push("## Tool activity\n" + calls.slice(-30).map((item) => `- ${item}`).join("\n"));
	if (errors.length > 0) sections.push("## Errors\n" + errors.slice(-10).map((item) => `- ${item}`).join("\n"));
	return truncateTextToTokens(sections.join("\n\n"), maxTokens);
}

export function makeCheckpoint(
	kind: VirtualCheckpoint["kind"],
	sessionId: string,
	messages: AgentMessage[],
	cutIndex: number,
	summary: string,
	sourceTokens: number,
): VirtualCheckpoint {
	return {
		kind,
		sessionId,
		cutIndex,
		prefixHash: hashMessages(messages.slice(0, cutIndex)),
		summary,
		sourceTokens,
		createdAt: Date.now(),
	};
}

export function checkpointMatches(checkpoint: VirtualCheckpoint, sessionId: string, messages: AgentMessage[]): boolean {
	return checkpoint.sessionId === sessionId
		&& checkpoint.cutIndex > 0
		&& checkpoint.cutIndex < messages.length
		&& isSafeCutMessage(messages[checkpoint.cutIndex])
		&& hashMessages(messages.slice(0, checkpoint.cutIndex)) === checkpoint.prefixHash;
}

function summaryMessage(checkpoint: VirtualCheckpoint): AgentMessage {
	return {
		role: "compactionSummary",
		summary: `[pi-virtual-context ${checkpoint.kind} checkpoint]\n${checkpoint.summary}`,
		tokensBefore: checkpoint.sourceTokens,
		timestamp: checkpoint.createdAt,
	} as AgentMessage;
}

export function projectMessages(
	checkpoint: VirtualCheckpoint,
	sessionId: string,
	messages: AgentMessage[],
	overheadTokens: number,
	transformSuffix: (messages: AgentMessage[]) => AgentMessage[] = (value) => value,
): ProjectionResult {
	if (!checkpointMatches(checkpoint, sessionId, messages)) {
		return { messages, projectedTokens: estimateProjectedContext(messages, overheadTokens), cutIndex: 0, omittedMessages: 0, valid: false };
	}
	const suffix = transformSuffix(messages.slice(checkpoint.cutIndex));
	const projected = [summaryMessage(checkpoint), ...suffix];
	return {
		messages: projected,
		projectedTokens: estimateProjectedContext(projected, overheadTokens),
		cutIndex: checkpoint.cutIndex,
		omittedMessages: checkpoint.cutIndex,
		valid: true,
	};
}

export function meetsReduction(rawTokens: number, projectedTokens: number, config: VirtualContextConfig): boolean {
	const reduction = rawTokens - projectedTokens;
	return reduction >= config.minReductionTokens && reduction / Math.max(rawTokens, 1) >= config.minReductionRatio;
}

/**
 * The reduction gate is an activation policy, not a reason to oscillate back to
 * canonical history. Once a session has successfully projected, keep using a
 * matching checkpoint until an explicit invalidation or refresh replaces it.
 */
export function shouldApplyProjection(
	rawTokens: number,
	projectedTokens: number,
	config: VirtualContextConfig,
	projectionCommitted: boolean,
): boolean {
	return projectionCommitted || meetsReduction(rawTokens, projectedTokens, config);
}

export function summaryTokenCount(checkpoint: VirtualCheckpoint): number {
	return estimateTextTokens(checkpoint.summary);
}

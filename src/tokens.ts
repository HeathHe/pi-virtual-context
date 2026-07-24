import type { AgentMessage } from "@earendil-works/pi-agent-core";

const CJK_PATTERN = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u;

export function estimateTextTokens(text: string): number {
	let cjk = 0;
	let other = 0;
	for (const character of text) {
		if (CJK_PATTERN.test(character)) cjk += 1;
		else other += 1;
	}
	return cjk + Math.ceil(other / 4);
}

function estimateContent(content: unknown): number {
	if (typeof content === "string") return estimateTextTokens(content);
	if (!Array.isArray(content)) return 0;
	let tokens = 0;
	for (const block of content) {
		if (block && typeof block === "object" && "type" in block) {
			if (block.type === "text" && "text" in block && typeof block.text === "string") tokens += estimateTextTokens(block.text);
			else if (block.type === "image") tokens += 1_200;
		}
	}
	return tokens;
}

export function estimateMessageTokens(message: AgentMessage): number {
	switch (message.role) {
		case "user":
		case "custom":
		case "toolResult":
			return estimateContent(message.content);
		case "assistant": {
			let tokens = 0;
			for (const block of message.content) {
				if (block.type === "text") tokens += estimateTextTokens(block.text);
				else if (block.type === "thinking") tokens += estimateTextTokens(block.thinking);
				else if (block.type === "toolCall") tokens += estimateTextTokens(block.name + JSON.stringify(block.arguments));
			}
			return tokens;
		}
		case "bashExecution":
			return estimateTextTokens(message.command) + estimateTextTokens(message.output);
		case "branchSummary":
		case "compactionSummary":
			return estimateTextTokens(message.summary);
	}
	return 0;
}

export function sumMessageTokens(messages: AgentMessage[], start = 0, end = messages.length): number {
	let total = 0;
	for (let index = start; index < end; index += 1) total += estimateMessageTokens(messages[index]);
	return total;
}

function assistantUsageTokens(message: AgentMessage): number | undefined {
	if (message.role !== "assistant" || message.stopReason === "aborted" || message.stopReason === "error") return undefined;
	const usage = message.usage;
	if (!usage) return undefined;
	const tokens = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	return tokens > 0 ? tokens : undefined;
}

export interface ContextEstimate {
	tokens: number;
	overheadTokens: number;
	lastUsageIndex: number | null;
	usageTokens: number;
	trailingTokens: number;
}

export interface ContextEstimateOptions {
	/**
	 * The previous provider request used a virtual projection, so its usage only
	 * describes that projection and must not be treated as the size of the
	 * canonical message history supplied to the next context hook.
	 */
	lastRequestProjected?: boolean;
	overheadHintTokens?: number;
}

function clampOverhead(tokens: number): number {
	return Math.max(2_000, Math.min(80_000, tokens));
}

export function estimateContext(
	messages: AgentMessage[],
	fallbackOverheadTokens: number,
	options: ContextEstimateOptions = {},
): ContextEstimate {
	const fullMessageTokens = sumMessageTokens(messages);
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const usageTokens = assistantUsageTokens(messages[index]);
		if (usageTokens === undefined) continue;
		const estimatedThroughUsage = sumMessageTokens(messages, 0, index + 1);
		const inferredOverheadTokens = clampOverhead(usageTokens - estimatedThroughUsage);
		const trailingTokens = sumMessageTokens(messages, index + 1);
		if (options.lastRequestProjected) {
			const overheadTokens = clampOverhead(options.overheadHintTokens ?? fallbackOverheadTokens);
			return {
				tokens: overheadTokens + fullMessageTokens,
				overheadTokens,
				lastUsageIndex: index,
				usageTokens,
				trailingTokens,
			};
		}
		return {
			tokens: usageTokens + trailingTokens,
			overheadTokens: inferredOverheadTokens,
			lastUsageIndex: index,
			usageTokens,
			trailingTokens,
		};
	}

	const trailingTokens = fullMessageTokens;
	return {
		tokens: fallbackOverheadTokens + trailingTokens,
		overheadTokens: fallbackOverheadTokens,
		lastUsageIndex: null,
		usageTokens: 0,
		trailingTokens,
	};
}

export function estimateProjectedContext(messages: AgentMessage[], overheadTokens: number): number {
	return overheadTokens + sumMessageTokens(messages);
}

export function truncateTextToTokens(text: string, maxTokens: number): string {
	if (estimateTextTokens(text) <= maxTokens) return text;
	const marker = "\n…[truncated by pi-virtual-context]";
	const contentLimit = Math.max(0, maxTokens - estimateTextTokens(marker));
	let tokens = 0;
	let result = "";
	for (const character of text) {
		const cost = CJK_PATTERN.test(character) ? 1 : 0.25;
		if (tokens + cost > contentLimit) break;
		result += character;
		tokens += cost;
	}
	return `${result}${marker}`;
}

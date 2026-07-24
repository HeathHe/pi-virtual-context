import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateContext, estimateTextTokens, sumMessageTokens, truncateTextToTokens } from "../src/tokens.ts";

const timestamp = 1_700_000_000_000;

function assistantWithUsage(text: string, totalTokens: number): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "test",
		model: "test",
		usage: {
			input: totalTokens - 100,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	} as AgentMessage;
}

test("a projected usage record does not shrink the canonical raw estimate", () => {
	const messages: AgentMessage[] = [
		{ role: "user", content: "x".repeat(800_000), timestamp },
		assistantWithUsage("projected response", 58_000),
		{ role: "user", content: "continue", timestamp },
	];
	const estimate = estimateContext(messages, 50_000, {
		lastRequestProjected: true,
		overheadHintTokens: 40_000,
	});

	assert.equal(estimate.overheadTokens, 40_000);
	assert.equal(estimate.tokens, 40_000 + sumMessageTokens(messages));
	assert.ok(estimate.tokens > 200_000);
});

test("ordinary unprojected requests remain anchored to provider usage", () => {
	const messages: AgentMessage[] = [
		{ role: "user", content: "x".repeat(40_000), timestamp },
		assistantWithUsage("full response", 75_000),
		{ role: "user", content: "next", timestamp },
	];
	const estimate = estimateContext(messages, 50_000);

	assert.equal(estimate.usageTokens, 75_000);
	assert.equal(estimate.tokens, 75_001);
});

test("text truncation includes its marker inside the requested token budget", () => {
	const truncated = truncateTextToTokens("上下文".repeat(1_000), 200);
	assert.ok(estimateTextTokens(truncated) <= 200);
	assert.match(truncated, /truncated by pi-virtual-context/);
});

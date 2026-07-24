import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
	activeConvergenceControls,
	buildDeterministicSummary,
	checkpointMatches,
	chooseCutIndex,
	makeCheckpoint,
	meetsReduction,
	planProjectionBudget,
	projectMessages,
	shouldApplyProjection,
} from "../src/projection.ts";
import { estimateTextTokens } from "../src/tokens.ts";

const timestamp = 1_700_000_000_000;

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp };
}

function assistant(text: string, toolCallId?: string): AgentMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			...(toolCallId ? [{ type: "toolCall" as const, id: toolCallId, name: "read", arguments: { path: "/tmp/a" } }] : []),
		],
		api: "openai-responses",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: toolCallId ? "toolUse" : "stop",
		timestamp,
	} as AgentMessage;
}

function toolResult(id: string, text: string): AgentMessage {
	return { role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp };
}

test("Chinese text uses a conservative per-character estimate", () => {
	assert.equal(estimateTextTokens("上下文压缩"), 5);
	assert.equal(estimateTextTokens("abcdefgh"), 2);
});

test("cut starts at a safe assistant boundary and keeps its tool result", () => {
	const messages = [
		user("old".repeat(8_000)),
		assistant("done"),
		user("current task"),
		assistant("reading", "call-1"),
		toolResult("call-1", "result".repeat(2_000)),
	];
	const cut = chooseCutIndex(messages, 1_000);
	assert.equal(cut, 3);
	assert.equal(messages[cut].role, "assistant");
	assert.equal(messages[cut + 1].role, "toolResult");
});

test("a single long tool chain can be split without starting at toolResult", () => {
	const messages = [
		user("one long task"),
		assistant("step one", "call-1"),
		toolResult("call-1", "a".repeat(20_000)),
		assistant("step two", "call-2"),
		toolResult("call-2", "b".repeat(20_000)),
		assistant("step three", "call-3"),
		toolResult("call-3", "c".repeat(20_000)),
	];
	const cut = chooseCutIndex(messages, 6_000);
	assert.ok(cut > 0);
	assert.equal(messages[cut].role, "assistant");
	assert.equal(messages[cut + 1].role, "toolResult");
});

test("target budget protects recent context by shrinking the summary first", () => {
	assert.deepEqual(planProjectionBudget(65_000, 42_000, 12_000, 10_000), {
		availableTokens: 23_000,
		summaryTokens: 10_000,
		desiredRecentTokens: 12_000,
		maxRecentTokens: 13_000,
		targetReachable: true,
	});
	assert.deepEqual(planProjectionBudget(65_000, 50_000, 12_000, 10_000), {
		availableTokens: 15_000,
		summaryTokens: 3_000,
		desiredRecentTokens: 12_000,
		maxRecentTokens: 12_000,
		targetReachable: true,
	});
});

test("cut falls back to the newest safe boundary inside the target budget", () => {
	const messages = [
		user("old".repeat(20_000)),
		user("b".repeat(36_000)),
		user("a".repeat(20_000)),
	];
	const cut = chooseCutIndex(messages, 12_000, 13_000);
	assert.equal(cut, 2);
});

test("projection injects one checkpoint and preserves the complete suffix", () => {
	const messages = [user("old".repeat(10_000)), assistant("old answer"), user("new"), assistant("tool", "call-1"), toolResult("call-1", "ok")];
	const checkpoint = makeCheckpoint("deterministic", "session", messages, 2, "summary", 100_000);
	assert.equal(checkpointMatches(checkpoint, "session", messages), true);
	const result = projectMessages(checkpoint, "session", messages, 20_000);
	assert.equal(result.valid, true);
	assert.equal(result.messages[0].role, "compactionSummary");
	assert.deepEqual(result.messages.slice(1), messages.slice(2));
});

test("checkpoint validation rejects changed prefixes", () => {
	const messages = [user("old"), assistant("answer"), user("new")];
	const checkpoint = makeCheckpoint("smart", "session", messages, 2, "summary", 100_000);
	const changed = [user("changed"), ...messages.slice(1)];
	assert.equal(checkpointMatches(checkpoint, "session", changed), false);
});

test("checkpoint validation rejects a cut boundary that becomes an orphan tool result", () => {
	const messages = [user("old"), assistant("tool", "call-1"), toolResult("call-1", "ok"), user("new")];
	const checkpoint = makeCheckpoint("smart", "session", messages, 1, "summary", 100_000);
	const changed = [messages[0], toolResult("orphan", "bad"), ...messages.slice(2)];

	assert.equal(checkpointMatches(checkpoint, "session", changed), false);
	assert.equal(projectMessages(checkpoint, "session", changed, 1_000).valid, false);
});

test("deterministic summary excludes convergence controls but retains user custom requirements", () => {
	const control = { role: "custom", customType: "pi-convergence-control", content: "Do not call more tools", display: false, timestamp } as any;
	const userNote = { role: "custom", customType: "user-note", content: "Keep this requirement", display: true, timestamp } as any;
	const summary = buildDeterministicSummary([control, userNote], undefined);

	assert.doesNotMatch(summary, /Do not call more tools/);
	assert.match(summary, /Keep this requirement/);
});

test("projection preserves current convergence controls from the omitted prefix only", () => {
	const oldUser = user("old task");
	const oldControl = { role: "custom", customType: "pi-convergence-control", content: "old stop", display: false, timestamp } as any;
	const currentUser = user("current task");
	const currentControl = { role: "custom", customType: "pi-convergence-control", content: "current stop", display: false, timestamp } as any;
	const messages = [oldUser, oldControl, currentUser, currentControl, assistant("tool", "call-1"), toolResult("call-1", "ok")];

	assert.deepEqual(activeConvergenceControls(messages, 4), [currentControl]);
});

test("deterministic fallback retains recent requirements and errors", () => {
	const error = { ...toolResult("call-1", "permission denied"), isError: true } as AgentMessage;
	const summary = buildDeterministicSummary([user("must not edit Pi core"), assistant("attempt", "call-1"), error], "/tmp/session.jsonl");
	assert.match(summary, /must not edit Pi core/);
	assert.match(summary, /permission denied/);
	assert.match(summary, /session\.jsonl/);
});

test("reduction gate requires both absolute and proportional savings", () => {
	assert.equal(meetsReduction(100_000, 65_000, DEFAULT_CONFIG), true);
	assert.equal(meetsReduction(100_000, 75_000, DEFAULT_CONFIG), false);
	assert.equal(meetsReduction(200_000, 165_000, DEFAULT_CONFIG), false);
});

test("a committed projection never oscillates back to canonical history", () => {
	assert.equal(shouldApplyProjection(38_000, 201_000, DEFAULT_CONFIG, false), false);
	assert.equal(shouldApplyProjection(38_000, 201_000, DEFAULT_CONFIG, true), true);
});

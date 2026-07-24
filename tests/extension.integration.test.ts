import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import virtualContextExtension from "../extensions/pi-virtual-context.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown | Promise<unknown>;

async function harness(options: {
	model?: ExtensionContext["model"];
	modelRegistry?: ExtensionContext["modelRegistry"];
} = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-vctx-extension-"));
	await mkdir(root, { recursive: true });
	await writeFile(join(root, "settings.json"), JSON.stringify({
		"virtual-context": {
			mode: "enabled",
			targetTokens: 50,
			prepareTokens: 100,
			swapTokens: 150,
			emergencyTokens: 300,
			keepRecentTokens: 20,
			fallbackOverheadTokens: 20,
			minReductionTokens: 10,
			minReductionRatio: 0.1,
			maxWaitMs: 1,
			summaryTimeoutMs: 10,
			summaryReserveTokens: 30,
			minCallsBetweenRefresh: 1,
			maxSingleInputTokens: 10,
			debugLog: false,
		},
	}), "utf8");
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;

	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		events: { on: () => () => undefined, emit() {} },
		registerCommand() {},
	} as unknown as ExtensionAPI;
	virtualContextExtension(pi);
	const ctx = {
		cwd: root,
		hasUI: false,
		ui: { setStatus() {}, notify() {} },
		sessionManager: {
			getSessionId: () => "integration-session",
			getSessionFile: () => join(root, "session.jsonl"),
		},
		model: options.model ?? { provider: "test", contextWindow: 10_000 },
		modelRegistry: options.modelRegistry ?? {
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: false, error: "unused" }),
		},
	} as unknown as ExtensionContext;
	const invoke = async (name: string, payload: Record<string, unknown> = {}) => {
		let result: unknown;
		for (const handler of handlers.get(name) ?? []) {
			const candidate = await handler({ type: name, ...payload }, ctx);
			if (candidate !== undefined) result = candidate;
		}
		return result;
	};
	await invoke("session_start");
	return {
		invoke,
		async close() {
			await invoke("session_shutdown");
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			await rm(root, { recursive: true, force: true });
		},
	};
}

function assistant(text: string, stopReason: "stop" | "error" | "aborted" = "stop"): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp: Date.now(),
	} as AgentMessage;
}

test("large input remains canonical at input time and is virtualized only for provider context", async () => {
	const h = await harness();
	try {
		const text = "important requirement ".repeat(30);
		assert.equal(await h.invoke("input", { text, images: [] }), undefined);
		const canonical = { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
		const result = await h.invoke("context", { messages: [canonical] }) as { messages?: AgentMessage[] } | undefined;
		assert.ok(result?.messages);
		assert.equal((canonical as any).content, text);
		assert.match(String((result.messages[0] as any).content), /verbatim user input is stored at/);

		const lowProjectedUsage = {
			...assistant("recent response ".repeat(20)),
			usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		} as AgentMessage;
		const nextMessages = [canonical, lowProjectedUsage, { role: "user", content: "next", timestamp: Date.now() } as AgentMessage];
		const next = await h.invoke("context", { messages: nextMessages }) as { messages?: AgentMessage[] } | undefined;
		assert.ok(next?.messages?.some((message) => message.role === "compactionSummary"));
	} finally {
		await h.close();
	}
});

test("provider failure clears a committed projection and fails open once", async () => {
	const h = await harness();
	try {
		const messages = [
			{ role: "user", content: "old ".repeat(800), timestamp: 1 } as AgentMessage,
			assistant("recent ".repeat(80)),
			{ role: "user", content: "new request", timestamp: 3 } as AgentMessage,
		];
		const projected = await h.invoke("context", { messages }) as { messages?: AgentMessage[] } | undefined;
		assert.ok(projected?.messages?.some((message) => message.role === "compactionSummary"));

		await h.invoke("agent_end", { messages: [...messages, assistant("provider failed", "error")] });
		assert.equal(await h.invoke("context", { messages }), undefined);
	} finally {
		await h.close();
	}
});

test("a timed-out smart checkpoint releases pending state so the next refresh can retry", async () => {
	let authCalls = 0;
	const h = await harness({
		model: { provider: "ark", contextWindow: 10_000 } as ExtensionContext["model"],
		modelRegistry: {
			find: () => ({ provider: "ark", id: "glm-5.2" }),
			getApiKeyAndHeaders: async () => {
				authCalls += 1;
				return await new Promise(() => undefined);
			},
		} as any,
	});
	try {
		const messages = [
			{ role: "user", content: "old ".repeat(800), timestamp: 1 } as AgentMessage,
			assistant("recent ".repeat(80)),
			{ role: "user", content: "new request", timestamp: 3 } as AgentMessage,
		];
		await h.invoke("context", { messages });
		await new Promise((resolve) => setTimeout(resolve, 20));
		await h.invoke("context", { messages });

		assert.equal(authCalls, 2);
	} finally {
		await h.close();
	}
});

test("smart checkpoint waits for foreground completion before using the model provider", async () => {
	let authCalls = 0;
	const h = await harness({
		model: { provider: "ark", contextWindow: 10_000 } as ExtensionContext["model"],
		modelRegistry: {
			find: () => ({ provider: "ark", id: "glm-5.2" }),
			getApiKeyAndHeaders: async () => {
				authCalls += 1;
				return { ok: false, error: "test stop" };
			},
		} as any,
	});
	try {
		const messages = [
			{ role: "user", content: "old ".repeat(800), timestamp: 1 } as AgentMessage,
			assistant("recent ".repeat(80)),
			{ role: "user", content: "new request", timestamp: 3 } as AgentMessage,
		];
		await h.invoke("agent_start");
		await h.invoke("context", { messages });
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(authCalls, 0);

		await h.invoke("agent_end", { messages: [...messages, assistant("done")] });
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(authCalls, 1);
	} finally {
		await h.close();
	}
});

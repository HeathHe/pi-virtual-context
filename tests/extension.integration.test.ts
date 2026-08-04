import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import virtualContextExtension from "../extensions/pi-virtual-context.ts";
import { getBackgroundBroker } from "../src/background-broker.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown | Promise<unknown>;
type CommandHandler = (args: string, ctx: ExtensionContext) => unknown | Promise<unknown>;

async function harness(options: {
	model?: ExtensionContext["model"];
	modelRegistry?: ExtensionContext["modelRegistry"];
	config?: Record<string, unknown>;
	setModel?: (model: NonNullable<ExtensionContext["model"]>) => boolean | Promise<boolean>;
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
			...options.config,
		},
	}), "utf8");
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;

	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, CommandHandler>();
	const notifications: string[] = [];
	const setModelCalls: NonNullable<ExtensionContext["model"]>[] = [];
	const userMessages: Array<{ content: unknown; options: unknown }> = [];
	let ctx: ExtensionContext;
	const pi = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		events: { on: () => () => undefined, emit() {} },
		registerCommand(name: string, command: { handler: CommandHandler }) {
			commands.set(name, command.handler);
		},
		async setModel(model: NonNullable<ExtensionContext["model"]>) {
			setModelCalls.push(model);
			const switched = options.setModel ? await options.setModel(model) : true;
			if (switched) {
				const previousModel = ctx.model;
				(ctx as { model: ExtensionContext["model"] }).model = model;
				for (const handler of handlers.get("model_select") ?? []) {
					await handler({ type: "model_select", model, previousModel, source: "set" }, ctx);
				}
			}
			return switched;
		},
		sendUserMessage(content: unknown, messageOptions: unknown) {
			userMessages.push({ content, options: messageOptions });
		},
	} as unknown as ExtensionAPI;
	virtualContextExtension(pi);
	ctx = {
		cwd: root,
		hasUI: false,
		ui: { setStatus() {}, notify(message: string) { notifications.push(message); } },
		sessionManager: {
			getSessionId: () => "integration-session",
			getSessionFile: () => join(root, "session.jsonl"),
		},
		model: options.model ?? { provider: "test", id: "test", contextWindow: 10_000 },
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
		notifications,
		setModelCalls,
		userMessages,
		get model() { return ctx.model; },
		async invokeCommand(name: string, args = "") {
			return await commands.get(name)?.(args, ctx);
		},
		async readTelemetry(): Promise<any[]> {
			await new Promise((resolve) => setTimeout(resolve, 20));
			const telemetryRoot = join(root, "virtual-context", "telemetry");
			const files = await readdir(telemetryRoot);
			const records: any[] = [];
			for (const file of files.filter((name) => name.endsWith(".jsonl"))) {
				const text = await readFile(join(telemetryRoot, file), "utf8");
				records.push(...text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)));
			}
			return records;
		},
		async close() {
			await invoke("session_shutdown");
			await new Promise((resolve) => setTimeout(resolve, 20));
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			await rm(root, { recursive: true, force: true });
		},
	};
}

function assistant(text: string, stopReason: "stop" | "error" | "aborted" = "stop", errorMessage?: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		...(errorMessage === undefined ? {} : { errorMessage }),
		timestamp: Date.now(),
	} as AgentMessage;
}

function projectableMessages(): AgentMessage[] {
	return [
		{ role: "user", content: "old ".repeat(800), timestamp: 1 } as AgentMessage,
		assistant("recent ".repeat(80)),
		{ role: "user", content: "new request", timestamp: 3 } as AgentMessage,
	];
}

function modelRegistry(...models: Array<{ provider: string; id: string; contextWindow?: number }>): ExtensionContext["modelRegistry"] {
	return {
		find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
		getApiKeyAndHeaders: async () => ({ ok: false, error: "unused" }),
	} as unknown as ExtensionContext["modelRegistry"];
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

test("a 429 provider error preserves the active projection without failover", async () => {
	const h = await harness({
		model: { provider: "kimi-coding", id: "kimi-k2", contextWindow: 128_000 } as ExtensionContext["model"],
		modelRegistry: modelRegistry({ provider: "ark", id: "glm-5.2" }),
		config: { debugLog: true },
	});
	try {
		const messages = projectableMessages();
		const projected = await h.invoke("context", { messages }) as { messages?: AgentMessage[] } | undefined;
		assert.ok(projected?.messages?.some((message) => message.role === "compactionSummary"));

		await h.invoke("agent_start");
		assert.equal(getBackgroundBroker().snapshot().foregroundActive, true);
		await h.invoke("agent_end", {
			messages: [...messages, assistant("provider failed", "error", `HTTP 429 too many requests ${"x".repeat(250)}`)],
		});
		assert.equal(getBackgroundBroker().snapshot().foregroundActive, false);
		assert.deepEqual(h.setModelCalls, []);
		assert.deepEqual(h.userMessages, []);

		const retry = await h.invoke("context", { messages }) as { messages?: AgentMessage[] } | undefined;
		assert.ok(retry?.messages?.some((message) => message.role === "compactionSummary"));
		const records = await h.readTelemetry();
		const decision = records.find((record) => record.action === "provider_transient_error");
		assert.equal(decision?.details?.stopReason, "error");
		assert.equal(decision?.details?.errorMessage, "[omitted-untrusted-text]");
		assert.equal(records.some((record) => record.action === "fail_open_after_provider_failure"), false);
	} finally {
		await h.close();
	}
});

test("an aborted provider request preserves the active projection without failover", async () => {
	const h = await harness({
		model: { provider: "kimi-coding", id: "kimi-k2", contextWindow: 128_000 } as ExtensionContext["model"],
		modelRegistry: modelRegistry({ provider: "ark", id: "glm-5.2" }),
		config: { debugLog: true },
	});
	try {
		const messages = projectableMessages();
		const projected = await h.invoke("context", { messages }) as { messages?: AgentMessage[] } | undefined;
		assert.ok(projected?.messages?.some((message) => message.role === "compactionSummary"));

		await h.invoke("agent_end", { messages: [...messages, assistant("aborted", "aborted")] });
		// User aborts must never trigger a model switch or auto-continue.
		assert.deepEqual(h.setModelCalls, []);
		assert.deepEqual(h.userMessages, []);
		const retry = await h.invoke("context", { messages }) as { messages?: AgentMessage[] } | undefined;
		assert.ok(retry?.messages?.some((message) => message.role === "compactionSummary"));
	} finally {
		await h.close();
	}
});

test("a structural provider error clears the projection and fails open once without failover", async () => {
	const h = await harness({
		model: { provider: "kimi-coding", id: "kimi-k2", contextWindow: 128_000 } as ExtensionContext["model"],
		modelRegistry: modelRegistry({ provider: "ark", id: "glm-5.2" }),
		config: { debugLog: true },
	});
	try {
		const messages = projectableMessages();
		const projected = await h.invoke("context", { messages }) as { messages?: AgentMessage[] } | undefined;
		assert.ok(projected?.messages?.some((message) => message.role === "compactionSummary"));

		await h.invoke("agent_end", {
			messages: [...messages, assistant("provider failed", "error", "invalid message format")],
		});
		assert.equal(await h.invoke("context", { messages }), undefined);
		const resumed = await h.invoke("context", { messages }) as { messages?: AgentMessage[] } | undefined;
		assert.ok(resumed?.messages?.some((message) => message.role === "compactionSummary"));

		const records = await h.readTelemetry();
		assert.ok(records.some((record) => record.action === "provider_failure_reset" && record.details?.stopReason === "error"));
		assert.equal(records.filter((record) => record.action === "fail_open_after_provider_failure").length, 1);
		assert.deepEqual(h.setModelCalls, []);
		assert.deepEqual(h.userMessages, []);
	} finally {
		await h.close();
	}
});

test("vctx status reports provider-and-model threshold overrides", async () => {
	const h = await harness({
		model: { provider: "kimi-coding", id: "kimi-k2", contextWindow: 1_000_000 } as ExtensionContext["model"],
		config: {
			thresholdOverrides: [{
				provider: "kimi-coding",
				model: "kimi-k2",
				prepareTokens: 60,
				swapTokens: 80,
				targetTokens: 40,
				emergencyTokens: 100,
			}],
		},
	});
	try {
		await h.invokeCommand("vctx:status");
		assert.match(h.notifications[h.notifications.length - 1] ?? "", /Thresholds \(override\): prepare 60 \/ swap 80 \/ target 40 \/ emergency 100/);
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

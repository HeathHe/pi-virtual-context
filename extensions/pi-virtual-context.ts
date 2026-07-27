import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	CONFIG_DIR_NAME,
	generateSummary,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ArtifactStore } from "../src/artifacts.ts";
import { getBackgroundBroker, withBackgroundLease } from "../src/background-broker.ts";
import {
	DEFAULT_CONFIG,
	mergeConfigValues,
	normalizeConfig,
	resolveThresholds,
	type ResolvedThresholds,
	type VirtualContextConfig,
	type VirtualContextMode,
} from "../src/config.ts";
import {
	buildDeterministicSummary,
	activeConvergenceControls,
	checkpointMatches,
	chooseCutIndex,
	hashMessages,
	makeCheckpoint,
	projectMessages,
	summaryTokenCount,
	shouldApplyProjection,
	type ProjectionResult,
	type VirtualCheckpoint,
} from "../src/projection.ts";
import { TelemetryWriter } from "../src/telemetry.ts";
import { estimateContext, estimateProjectedContext, estimateTextTokens, truncateTextToTokens } from "../src/tokens.ts";

interface PendingCheckpoint {
	key: string;
	cutIndex: number;
	prefixHash: string;
	controller: AbortController;
	promise: Promise<VirtualCheckpoint | undefined>;
	ready?: VirtualCheckpoint;
	error?: string;
}

interface RuntimeStats {
	rawTokens: number;
	projectedTokens?: number;
	action: string;
	overheadTokens: number;
	requestCount: number;
}

interface ProjectionSnapshot {
	rawTokens: number;
	projectedTokens: number;
	action: string;
	targetMet: boolean;
}

interface RuntimeState {
	sessionId: string;
	mode: VirtualContextMode;
	config: VirtualContextConfig;
	artifacts: ArtifactStore;
	telemetry: TelemetryWriter;
	active?: VirtualCheckpoint;
	pending?: PendingCheckpoint;
	callsSinceActivation: number;
	projectionCommitted: boolean;
	failOpenRequests: number;
	stats: RuntimeStats;
	lastProjection?: ProjectionSnapshot;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

async function loadConfig(cwd: string): Promise<{ config: VirtualContextConfig; warnings: string[] }> {
	const globalSettings = await readJson(join(getAgentDir(), "settings.json"));
	const projectSettings = await readJson(join(cwd, CONFIG_DIR_NAME, "settings.json"));
	return normalizeConfig(mergeConfigValues(globalSettings["virtual-context"], projectSettings["virtual-context"]));
}

function statusText(state: RuntimeState, thresholds: ResolvedThresholds): string {
	const active = state.active ? `${state.active.kind}, cut=${state.active.cutIndex}` : "none";
	const pending = state.pending ? (state.pending.ready ? "ready" : state.pending.error ? `error: ${state.pending.error}` : "running") : "none";
	const current = state.stats.projectedTokens === undefined
		? `estimated ${state.stats.rawTokens.toLocaleString()} / ${state.stats.action} / overhead ${state.stats.overheadTokens.toLocaleString()}`
		: `raw ${state.stats.rawTokens.toLocaleString()} / sent ${state.stats.projectedTokens.toLocaleString()} / ${state.stats.action}`;
	const lastProjection = state.lastProjection
		? `raw ${state.lastProjection.rawTokens.toLocaleString()} → sent ${state.lastProjection.projectedTokens.toLocaleString()} / ${state.lastProjection.action} / ${state.lastProjection.targetMet ? "target met" : "OVER TARGET"}`
		: "none";
	return [
		`Mode: ${state.mode}`,
		`Thresholds (${thresholds.source}): prepare ${thresholds.prepareTokens.toLocaleString()} / swap ${thresholds.swapTokens.toLocaleString()} / target ${thresholds.targetTokens.toLocaleString()} / emergency ${thresholds.emergencyTokens.toLocaleString()}`,
		`Current request: ${current}`,
		`Last projection: ${lastProjection}`,
		`Checkpoint: active ${active} / pending ${pending}`,
		`Requests observed: ${state.stats.requestCount}`,
	].join("\n");
}

const STATUS_BAR_WIDTH = 10;

function statusBar(ratio: number): string {
	const filled = Math.max(0, Math.min(STATUS_BAR_WIDTH, Math.round(ratio * STATUS_BAR_WIDTH)));
	return "█".repeat(filled) + "░".repeat(STATUS_BAR_WIDTH - filled);
}

function activeThresholdModel(ctx: ExtensionContext): { provider?: string; id?: string } | undefined {
	return ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
}

function updateFooter(ctx: ExtensionContext, state: RuntimeState): void {
	if (state.mode === "off") {
		ctx.ui.setStatus("virtual-context", undefined);
		return;
	}
	const theme = ctx.ui.theme;
	const fg = theme?.fg?.bind(theme) ?? ((_color: string, text: string) => text);
	const rawK = Math.round(state.stats.rawTokens / 1000);
	const prefix = state.mode === "shadow" ? "◈ shadow " : "◈ ";
	const thresholds = resolveThresholds(state.config, ctx.model?.contextWindow, activeThresholdModel(ctx));
	const bar = statusBar(state.stats.rawTokens / thresholds.swapTokens);
	if (state.stats.projectedTokens === undefined) {
		ctx.ui.setStatus("virtual-context", fg("dim", `${prefix}${bar} ~${rawK}K ${state.stats.action}`));
		return;
	}
	const sentK = Math.round(state.stats.projectedTokens / 1000);
	const compressed = state.stats.projectedTokens < state.stats.rawTokens;
	const text = compressed ? `${prefix}${bar} ${rawK}K→${sentK}K` : `${prefix}${bar} ${sentK}K`;
	const color = state.stats.rawTokens >= thresholds.swapTokens
		? "error"
		: state.stats.rawTokens >= thresholds.prepareTokens
			? "warning"
			: compressed
				? "accent"
				: "dim";
	ctx.ui.setStatus("virtual-context", fg(color, text));
}

const TRANSIENT_PROVIDER_ERROR_RE = /(?:overloaded|rate[\s_-]*limit|too many requests|\b429\b|\b5(?:\d{2}|xx)\b|service unavailable|\bnetwork\b|\bconnection\b|\beconn(?:reset|refused|aborted)\b|socket hang up|\btimeouts?\b|\btimed?\s*out\b|context.?length)/i;

function providerErrorMessage(message: AgentMessage): string {
	const errorMessage = (message as { errorMessage?: unknown }).errorMessage;
	return typeof errorMessage === "string" ? errorMessage : "";
}

function cancelPending(state: RuntimeState, reason: string): void {
	if (state.pending) {
		state.pending.controller.abort(reason);
		state.pending = undefined;
	}
}

function invalidate(state: RuntimeState | undefined, reason: string): void {
	if (!state) return;
	cancelPending(state, reason);
	state.active = undefined;
	state.callsSinceActivation = 0;
	state.projectionCommitted = false;
	state.failOpenRequests = 0;
	state.telemetry.write({ mode: state.mode, action: "invalidate", details: { reason } });
}

function timeout<T>(promise: Promise<T>, milliseconds: number): Promise<T | undefined> {
	return Promise.race([
		promise,
		new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), milliseconds)),
	]);
}

async function waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) throw new Error(String(signal.reason ?? "aborted"));
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(new Error(String(signal.reason ?? "aborted")));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([promise, aborted]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}

function candidateKey(sessionId: string, messages: AgentMessage[], cutIndex: number): string {
	return `${sessionId}:${cutIndex}:${hashMessages(messages.slice(0, cutIndex))}`;
}

function startSmartCheckpoint(
	state: RuntimeState,
	messages: AgentMessage[],
	rawTokens: number,
	ctx: ExtensionContext,
	thresholds: ResolvedThresholds,
): void {
	const cutIndex = chooseCutIndex(messages, state.config.keepRecentTokens);
	if (cutIndex <= 0 || cutIndex >= messages.length) return;
	if (
		state.pending
		&& !state.pending.error
		&& state.pending.cutIndex < messages.length
		&& hashMessages(messages.slice(0, state.pending.cutIndex)) === state.pending.prefixHash
	) return;
	const key = candidateKey(state.sessionId, messages, cutIndex);
	if (state.pending?.key === key) return;
	cancelPending(state, "superseded");

	const prefix = structuredClone(messages.slice(0, cutIndex));
	const controller = new AbortController();
	const task: PendingCheckpoint = {
		key,
		cutIndex,
		prefixHash: hashMessages(prefix),
		controller,
		promise: Promise.resolve(undefined),
	};
	state.pending = task;
	state.telemetry.write({
		mode: state.mode,
		action: "checkpoint_prepare_start",
		rawTokens,
		rawMessages: messages.length,
		details: { cutIndex, model: `${state.config.summaryModel.provider}/${state.config.summaryModel.id}` },
	});

	let brokerSignal: AbortSignal | undefined;
	task.promise = withBackgroundLease({
		owner: `virtual-context:${state.sessionId}`,
		priority: rawTokens >= thresholds.emergencyTokens ? 400 : 300,
		signal: controller.signal,
	}, async (signal, waitedMs) => {
		brokerSignal = signal;
		const timer = setTimeout(() => {
			controller.abort("summary timeout");
			if (state.pending === task) state.pending = undefined;
			state.telemetry.write({ mode: state.mode, action: "checkpoint_prepare_timeout", rawTokens });
		}, state.config.summaryTimeoutMs);
		state.telemetry.write({ mode: state.mode, action: "checkpoint_prepare_acquired", rawTokens, details: { waitedMs } });
		try {
			const activeProvider = String(ctx.model?.provider ?? "");
			if (activeProvider && activeProvider !== state.config.summaryModel.provider && !state.config.allowCrossProvider) {
				throw new Error(`cross-provider summary model is disabled: ${activeProvider} -> ${state.config.summaryModel.provider}`);
			}
			const model = ctx.modelRegistry.find(state.config.summaryModel.provider, state.config.summaryModel.id);
			if (!model) throw new Error(`summary model not found: ${state.config.summaryModel.provider}/${state.config.summaryModel.id}`);
			const auth = await waitWithAbort(ctx.modelRegistry.getApiKeyAndHeaders(model), signal);
			if (!auth.ok) throw new Error("error" in auth ? String(auth.error) : "summary model authentication failed");
			if (signal.aborted || state.pending !== task) return undefined;
			const summaryMessages = prefix
				.filter((message) => message.role !== "custom" || (message as { customType?: unknown }).customType !== "pi-convergence-control")
				.map((message) => sanitizeForTextSummary(message));
			const generatedSummary = await waitWithAbort(generateSummary(
				summaryMessages,
				model,
				state.config.summaryReserveTokens,
				auth.apiKey,
				auth.headers,
				signal,
				"Preserve exact user constraints, pending work, file paths, errors, side effects, and verification status. Never claim that an action happened unless it appears in the source messages.",
				undefined,
				state.config.summaryModel.thinking as ThinkingLevel,
				undefined,
				auth.env,
			), signal);
			const summary = truncateTextToTokens(generatedSummary, state.config.summaryReserveTokens);
			return makeCheckpoint("smart", state.sessionId, messages, cutIndex, summary, rawTokens);
		} finally {
			clearTimeout(timer);
		}
	})
		.then((checkpoint) => {
			if (checkpoint && state.pending === task && !controller.signal.aborted) {
				task.ready = checkpoint;
				state.telemetry.write({ mode: state.mode, action: "checkpoint_prepare_ready", rawTokens, checkpointKind: checkpoint.kind });
			} else if (state.pending === task) state.pending = undefined;
			return checkpoint;
		})
		.catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			if (state.pending === task) {
				task.error = message;
				state.pending = undefined;
			}
			state.telemetry.write({
				mode: state.mode,
				action: "checkpoint_prepare_error",
				rawTokens,
				details: { failureKind: controller.signal.aborted ? "aborted" : brokerSignal?.aborted ? "foreground_preempted" : "summary_failed" },
			});
			return undefined;
		});
}

function sanitizeForTextSummary(message: AgentMessage): AgentMessage {
	if (message.role !== "user" && message.role !== "custom" && message.role !== "toolResult") return message;
	if (typeof message.content === "string") return message;
	return {
		...message,
		content: message.content.map((block) => block.type === "image"
			? { type: "text" as const, text: `[image omitted from text-only checkpoint; mime=${block.mimeType}]` }
			: block),
	} as AgentMessage;
}

async function transformSuffix(state: RuntimeState, messages: AgentMessage[], hypothetical = false): Promise<AgentMessage[]> {
	return state.artifacts.transformMessages(messages, state.config, hypothetical);
}

async function createProjection(
	state: RuntimeState,
	checkpoint: VirtualCheckpoint,
	messages: AgentMessage[],
	overheadTokens: number,
	hypothetical = false,
): Promise<ProjectionResult> {
	if (!checkpointMatches(checkpoint, state.sessionId, messages)) {
		return projectMessages(checkpoint, state.sessionId, messages, overheadTokens);
	}
	const transformed = await transformSuffix(state, messages.slice(checkpoint.cutIndex), hypothetical);
	const activeControls = activeConvergenceControls(messages, checkpoint.cutIndex);
	return projectMessages(checkpoint, state.sessionId, messages, overheadTokens, () => [...activeControls, ...transformed]);
}

function promoteReadyCheckpoint(state: RuntimeState, messages: AgentMessage[]): void {
	const ready = state.pending?.ready;
	if (!ready || !checkpointMatches(ready, state.sessionId, messages)) return;
	state.active = ready;
	state.pending = undefined;
	state.callsSinceActivation = 0;
}

async function deterministicCheckpoint(
	state: RuntimeState,
	messages: AgentMessage[],
	rawTokens: number,
	ctx: ExtensionContext,
	options: { maxRecentTokens?: number; maxSummaryTokens?: number } = {},
): Promise<VirtualCheckpoint | undefined> {
	const maxRecentTokens = options.maxRecentTokens ?? Number.POSITIVE_INFINITY;
	const planningMessages = Number.isFinite(maxRecentTokens)
		? await transformSuffix(state, messages, true)
		: messages;
	const cutIndex = chooseCutIndex(planningMessages, state.config.keepRecentTokens, maxRecentTokens);
	if (cutIndex <= 0 || cutIndex >= messages.length) return undefined;
	const summary = buildDeterministicSummary(
		messages.slice(0, cutIndex),
		ctx.sessionManager.getSessionFile(),
		options.maxSummaryTokens ?? state.config.summaryReserveTokens,
	);
	return makeCheckpoint("deterministic", state.sessionId, messages, cutIndex, summary, rawTokens);
}

export default function virtualContextExtension(pi: ExtensionAPI): void {
	let state: RuntimeState | undefined;

	pi.on("agent_start", () => getBackgroundBroker().setForegroundActive(true));

	pi.events.on("pi-convergence:state", (event: any) => {
		if (!state || event?.phase !== "aborted") return;
		cancelPending(state, "convergence_aborted");
		state.active = undefined;
		state.callsSinceActivation = 0;
		state.projectionCommitted = false;
		state.failOpenRequests = 1;
		state.telemetry.write({ mode: state.mode, action: "convergence_abort_reset" });
	});

	pi.on("session_start", async (_event, ctx) => {
		const loaded = await loadConfig(ctx.cwd);
		const sessionId = ctx.sessionManager.getSessionId();
		const root = join(getAgentDir(), "virtual-context");
		state = {
			sessionId,
			mode: loaded.config.mode,
			config: loaded.config,
			artifacts: new ArtifactStore(join(root, "artifacts"), sessionId),
			telemetry: new TelemetryWriter(join(root, "telemetry"), sessionId, loaded.config.debugLog),
			callsSinceActivation: 0,
			projectionCommitted: false,
			failOpenRequests: 0,
			stats: { rawTokens: 0, action: "session_start", overheadTokens: loaded.config.fallbackOverheadTokens, requestCount: 0 },
		};
		for (const warning of loaded.warnings) ctx.ui.notify(`pi-virtual-context: ${warning}`, "warning");
		// 启动时还没有任何 token 数据，不占用状态栏；首次请求后由 updateFooter 填充
		ctx.ui.setStatus("virtual-context", undefined);
		state.telemetry.write({ mode: state.mode, action: "session_start" });
	});

	pi.on("tool_result", async (event) => {
		if (!state || state.mode !== "enabled") return;
		const message = {
			role: "toolResult",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			content: event.content,
			details: event.details,
			isError: event.isError,
			timestamp: Date.now(),
		} as AgentMessage;
		if (message.role !== "toolResult") return;
		try {
			const artifact = await state.artifacts.archiveToolResult(message, state.config);
			if (artifact) state.telemetry.write({
				mode: state.mode,
				action: "artifact_archived",
				details: {
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					sha256: artifact.sha256,
					characters: artifact.characters,
				},
			});
		} catch {
			state.telemetry.write({ mode: state.mode, action: "artifact_archive_failed", details: { toolName: event.toolName } });
		}
		return undefined;
	});

	pi.on("input", async (event) => {
		if (!state || state.mode !== "enabled" || !state.config.virtualizeLargeInputs) return;
		const tokens = estimateTextTokens(event.text);
		if (tokens < state.config.maxSingleInputTokens) return;
		try {
			const artifact = await state.artifacts.archiveText(event.text, "large-user-input");
			state.telemetry.write({
				mode: state.mode,
				action: "large_input_archived",
				rawTokens: tokens,
				details: { sha256: artifact.sha256, characters: artifact.characters },
			});
		} catch {
			state.telemetry.write({ mode: state.mode, action: "large_input_archive_failed", rawTokens: tokens });
		}
		return undefined;
	});

	pi.on("context", async (event, ctx) => {
		if (!state) return;
		const thresholds = resolveThresholds(state.config, ctx.model?.contextWindow, activeThresholdModel(ctx));
		const previousRequestProjected = state.stats.action.startsWith("project_");
		const estimate = estimateContext(event.messages, state.config.fallbackOverheadTokens, {
			lastRequestProjected: previousRequestProjected,
			overheadHintTokens: state.stats.overheadTokens,
		});
		state.stats = {
			rawTokens: estimate.tokens,
			action: state.mode === "off" ? "off" : "pass",
			overheadTokens: estimate.overheadTokens,
			requestCount: state.stats.requestCount + 1,
		};

		if (state.mode === "off") {
			updateFooter(ctx, state);
			return;
		}

		if (state.mode === "shadow") {
			if (estimate.tokens >= thresholds.prepareTokens) {
				const checkpoint = await deterministicCheckpoint(state, event.messages, estimate.tokens, ctx);
				if (checkpoint) {
					const projection = await createProjection(state, checkpoint, event.messages, estimate.overheadTokens, true);
					state.stats.projectedTokens = projection.projectedTokens;
					state.stats.action = "shadow_projection";
				}
			}
			state.telemetry.write({
				mode: state.mode,
				action: state.stats.action,
				rawTokens: estimate.tokens,
				projectedTokens: state.stats.projectedTokens,
				overheadTokens: estimate.overheadTokens,
				rawMessages: event.messages.length,
			});
			updateFooter(ctx, state);
			return;
		}

		if (state.failOpenRequests > 0) {
			state.failOpenRequests -= 1;
			state.stats.action = "fail_open_after_provider_failure";
			state.telemetry.write({ mode: state.mode, action: state.stats.action, rawTokens: estimate.tokens, overheadTokens: estimate.overheadTokens, rawMessages: event.messages.length });
			updateFooter(ctx, state);
			return;
		}

		const directInputProjection = await state.artifacts.transformLargeUserInputs(event.messages, state.config);
		const directInputChanged = directInputProjection.length !== event.messages.length
			|| directInputProjection.some((message, index) => message !== event.messages[index]);
		const directState = state;
		const useDirectInputProjection = () => {
			const projectedTokens = estimateProjectedContext(directInputProjection, estimate.overheadTokens);
			directState.stats.action = "project_large_input";
			directState.stats.projectedTokens = projectedTokens;
			directState.lastProjection = {
				rawTokens: estimate.tokens,
				projectedTokens,
				action: directState.stats.action,
				targetMet: projectedTokens <= thresholds.targetTokens,
			};
			directState.telemetry.write({
				mode: directState.mode,
				action: directState.stats.action,
				rawTokens: estimate.tokens,
				projectedTokens,
				overheadTokens: estimate.overheadTokens,
				rawMessages: event.messages.length,
				projectedMessages: directInputProjection.length,
			});
			updateFooter(ctx, directState);
			return { messages: directInputProjection };
		};

		if (estimate.tokens >= thresholds.prepareTokens && (!state.active || state.callsSinceActivation >= state.config.minCallsBetweenRefresh)) {
			startSmartCheckpoint(state, event.messages, estimate.tokens, ctx, thresholds);
		}

		if (!state.active && estimate.tokens < thresholds.swapTokens) {
			if (directInputChanged) return useDirectInputProjection();
			state.telemetry.write({ mode: state.mode, action: "pass", rawTokens: estimate.tokens, overheadTokens: estimate.overheadTokens, rawMessages: event.messages.length });
			updateFooter(ctx, state);
			return;
		}

		promoteReadyCheckpoint(state, event.messages);
		if (!state.active && state.pending) {
			await timeout(state.pending.promise, state.config.maxWaitMs);
			promoteReadyCheckpoint(state, event.messages);
		}

		let checkpoint = state.active;
		if (!checkpoint || !checkpointMatches(checkpoint, state.sessionId, event.messages)) {
			checkpoint = await deterministicCheckpoint(state, event.messages, estimate.tokens, ctx);
			if (checkpoint) state.active = checkpoint;
		}

		if (!checkpoint) {
			state.projectionCommitted = false;
			if (directInputChanged) return useDirectInputProjection();
			state.stats.action = "no_safe_cut";
			state.telemetry.write({ mode: state.mode, action: state.stats.action, rawTokens: estimate.tokens, overheadTokens: estimate.overheadTokens, rawMessages: event.messages.length });
			updateFooter(ctx, state);
			return;
		}

		let projection = await createProjection(state, checkpoint, event.messages, estimate.overheadTokens);
		if (!projection.valid) {
			state.active = undefined;
			state.projectionCommitted = false;
			if (directInputChanged) return useDirectInputProjection();
			state.stats.action = "stale_checkpoint";
			updateFooter(ctx, state);
			return;
		}

		if (!shouldApplyProjection(
			estimate.tokens,
			projection.projectedTokens,
			state.config,
			state.projectionCommitted,
		) && estimate.tokens < thresholds.emergencyTokens) {
			if (directInputChanged) return useDirectInputProjection();
			state.stats.action = "insufficient_reduction";
			state.stats.projectedTokens = projection.projectedTokens;
			state.telemetry.write({ mode: state.mode, action: state.stats.action, rawTokens: estimate.tokens, projectedTokens: projection.projectedTokens, overheadTokens: estimate.overheadTokens });
			updateFooter(ctx, state);
			return;
		}

		if (projection.projectedTokens > thresholds.targetTokens) {
			const excessTokens = projection.projectedTokens - thresholds.targetTokens;
			const currentSummaryTokens = summaryTokenCount(checkpoint);
			const minimumSummaryTokens = Math.min(1_000, currentSummaryTokens);
			const tighterSummaryTokens = Math.max(
				minimumSummaryTokens,
				currentSummaryTokens - excessTokens - 64,
			);
			if (tighterSummaryTokens < currentSummaryTokens) {
				const summaryTightened = {
					...checkpoint,
					summary: truncateTextToTokens(checkpoint.summary, tighterSummaryTokens),
					createdAt: Date.now(),
				};
				const tighterProjection = await createProjection(state, summaryTightened, event.messages, estimate.overheadTokens);
				if (tighterProjection.valid && tighterProjection.projectedTokens < projection.projectedTokens) {
					checkpoint = summaryTightened;
					state.active = summaryTightened;
					projection = tighterProjection;
				}
			}

			const minimumTargetSummaryTokens = 1_000;
			const maxRecentTokens = Math.max(
				1,
				thresholds.targetTokens - estimate.overheadTokens - minimumTargetSummaryTokens,
			);
			const targetCheckpoint = projection.projectedTokens > thresholds.targetTokens
				? await deterministicCheckpoint(state, event.messages, estimate.tokens, ctx, {
					maxRecentTokens,
					maxSummaryTokens: minimumTargetSummaryTokens,
				})
				: undefined;
			if (targetCheckpoint) {
				const targetProjection = await createProjection(state, targetCheckpoint, event.messages, estimate.overheadTokens);
				if (targetProjection.valid && targetProjection.projectedTokens < projection.projectedTokens) {
					checkpoint = targetCheckpoint;
					state.active = targetCheckpoint;
					projection = targetProjection;
				}
			}
		}

		const continuedProjection = state.projectionCommitted;
		state.callsSinceActivation += 1;
		state.projectionCommitted = true;
		state.stats.action = `project_${checkpoint.kind}`;
		state.stats.projectedTokens = projection.projectedTokens;
		state.lastProjection = {
			rawTokens: estimate.tokens,
			projectedTokens: projection.projectedTokens,
			action: state.stats.action,
			targetMet: projection.projectedTokens <= thresholds.targetTokens,
		};
		state.telemetry.write({
			mode: state.mode,
			action: state.stats.action,
			rawTokens: estimate.tokens,
			projectedTokens: projection.projectedTokens,
			overheadTokens: estimate.overheadTokens,
			rawMessages: event.messages.length,
			projectedMessages: projection.messages.length,
			checkpointKind: checkpoint.kind,
			details: {
				omittedMessages: projection.omittedMessages,
				callsSinceActivation: state.callsSinceActivation,
				continuedProjection,
				targetTokens: thresholds.targetTokens,
				targetMet: projection.projectedTokens <= thresholds.targetTokens,
			},
		});
		updateFooter(ctx, state);
		return { messages: projection.messages };
	});

	pi.on("agent_end", (event) => {
		getBackgroundBroker().setForegroundActive(false);
		const lastAssistant = [...event.messages].reverse().find((message: AgentMessage) => message.role === "assistant");
		if (lastAssistant?.role !== "assistant" || (lastAssistant.stopReason !== "error" && lastAssistant.stopReason !== "aborted") || !state) return;

		const errorMessage = providerErrorMessage(lastAssistant);
		const details = { stopReason: lastAssistant.stopReason, errorMessage: errorMessage.slice(0, 200) };
		const transient = lastAssistant.stopReason === "aborted" || TRANSIENT_PROVIDER_ERROR_RE.test(errorMessage);
		if (transient) {
			state.telemetry.write({ mode: state.mode, action: "provider_transient_error", details });
			return;
		}

		cancelPending(state, `provider_${lastAssistant.stopReason}`);
		state.active = undefined;
		state.callsSinceActivation = 0;
		state.projectionCommitted = false;
		state.failOpenRequests = 1;
		state.telemetry.write({ mode: state.mode, action: "provider_failure_reset", details });
	});

	pi.on("session_before_compact", () => invalidate(state, "session_before_compact"));
	pi.on("session_compact", () => invalidate(state, "session_compact"));
	pi.on("session_before_tree", () => invalidate(state, "session_before_tree"));
	pi.on("session_tree", () => invalidate(state, "session_tree"));
	pi.on("session_before_switch", () => invalidate(state, "session_before_switch"));
	pi.on("session_before_fork", () => invalidate(state, "session_before_fork"));
	pi.on("model_select", () => invalidate(state, "model_select"));
	pi.on("session_shutdown", (_event, ctx) => {
		getBackgroundBroker().setForegroundActive(false);
		invalidate(state, "session_shutdown");
		ctx.ui.setStatus("virtual-context", undefined);
		state = undefined;
	});

	pi.registerCommand("vctx:status", {
		description: "Show current context estimate, thresholds, and last projection",
		handler: async (_args, ctx) => {
			ctx.ui.notify(state ? statusText(state, resolveThresholds(state.config, ctx.model?.contextWindow, activeThresholdModel(ctx))) : "pi-virtual-context has no active session state", state ? "info" : "warning");
		},
	});

	pi.registerCommand("vctx:mode", {
		description: "Temporarily set pi-virtual-context mode: off, shadow, or enabled",
		handler: async (args, ctx) => {
			if (!state) return;
			const mode = args.trim();
			if (mode !== "off" && mode !== "shadow" && mode !== "enabled") {
				ctx.ui.notify("Usage: /vctx:mode off|shadow|enabled", "warning");
				return;
			}
			invalidate(state, `mode_change:${mode}`);
			state.mode = mode;
			updateFooter(ctx, state);
			ctx.ui.notify(`pi-virtual-context mode is now ${mode} for this runtime; settings.json is unchanged`, mode === "enabled" ? "warning" : "info");
		},
	});

	pi.registerCommand("vctx:reset", {
		description: "Discard active and pending virtual checkpoints",
		handler: async (_args, ctx) => {
			invalidate(state, "manual_reset");
			ctx.ui.notify("pi-virtual-context checkpoints reset", "info");
		},
	});
}

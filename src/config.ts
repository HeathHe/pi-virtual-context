export type VirtualContextMode = "off" | "shadow" | "enabled";

export interface SummaryModelConfig {
	provider: string;
	id: string;
	thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

export interface VirtualContextConfig {
	mode: VirtualContextMode;
	prepareTokens: number;
	swapTokens: number;
	targetTokens: number;
	emergencyTokens: number;
	keepRecentTokens: number;
	fallbackOverheadTokens: number;
	minReductionTokens: number;
	minReductionRatio: number;
	maxWaitMs: number;
	summaryTimeoutMs: number;
	summaryReserveTokens: number;
	minCallsBetweenRefresh: number;
	artifactThresholdTokens: number;
	artifactPreviewChars: number;
	artifactToolNames: string[];
	virtualizeLargeInputs: boolean;
	maxSingleInputTokens: number;
	debugLog: boolean;
	allowCrossProvider: boolean;
	summaryModel: SummaryModelConfig;
}

export interface NormalizedConfig {
	config: VirtualContextConfig;
	warnings: string[];
}

export const DEFAULT_CONFIG: VirtualContextConfig = {
	mode: "shadow",
	prepareTokens: 80_000,
	swapTokens: 95_000,
	targetTokens: 65_000,
	emergencyTokens: 120_000,
	keepRecentTokens: 12_000,
	fallbackOverheadTokens: 50_000,
	minReductionTokens: 30_000,
	minReductionRatio: 0.3,
	maxWaitMs: 3_000,
	summaryTimeoutMs: 60_000,
	summaryReserveTokens: 10_000,
	minCallsBetweenRefresh: 10,
	artifactThresholdTokens: 2_000,
	artifactPreviewChars: 4_000,
	artifactToolNames: ["read", "grep", "find", "ls", "bash"],
	virtualizeLargeInputs: true,
	maxSingleInputTokens: 60_000,
	debugLog: false,
	allowCrossProvider: false,
	summaryModel: {
		provider: "ark",
		id: "glm-5.2",
		thinking: "off",
	},
};

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function positiveInteger(value: unknown, fallback: number, name: string, warnings: string[]): number {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
	if (value !== undefined) warnings.push(`${name} must be a positive number; using ${fallback}`);
	return fallback;
}

function ratio(value: unknown, fallback: number, name: string, warnings: string[]): number {
	if (typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1) return value;
	if (value !== undefined) warnings.push(`${name} must be between 0 and 1; using ${fallback}`);
	return fallback;
}

export function normalizeConfig(value: unknown): NormalizedConfig {
	const input = record(value);
	const warnings: string[] = [];
	const rawMode = input.mode;
	const mode: VirtualContextMode = rawMode === "off" || rawMode === "shadow" || rawMode === "enabled"
		? rawMode
		: DEFAULT_CONFIG.mode;
	if (rawMode !== undefined && rawMode !== mode) warnings.push(`mode must be off, shadow, or enabled; using ${mode}`);

	const rawSummaryModel = record(input.summaryModel);
	const rawThinking = rawSummaryModel.thinking;
	const thinking = typeof rawThinking === "string" && THINKING_LEVELS.has(rawThinking)
		? (rawThinking as SummaryModelConfig["thinking"])
		: DEFAULT_CONFIG.summaryModel.thinking;
	if (rawThinking !== undefined && rawThinking !== thinking) warnings.push(`summaryModel.thinking is invalid; using ${thinking}`);

	const toolNames = Array.isArray(input.artifactToolNames)
		? input.artifactToolNames.filter((item): item is string => typeof item === "string" && item.length > 0)
		: DEFAULT_CONFIG.artifactToolNames;

	const config: VirtualContextConfig = {
		mode,
		prepareTokens: positiveInteger(input.prepareTokens, DEFAULT_CONFIG.prepareTokens, "prepareTokens", warnings),
		swapTokens: positiveInteger(input.swapTokens, DEFAULT_CONFIG.swapTokens, "swapTokens", warnings),
		targetTokens: positiveInteger(input.targetTokens, DEFAULT_CONFIG.targetTokens, "targetTokens", warnings),
		emergencyTokens: positiveInteger(input.emergencyTokens, DEFAULT_CONFIG.emergencyTokens, "emergencyTokens", warnings),
		keepRecentTokens: positiveInteger(input.keepRecentTokens, DEFAULT_CONFIG.keepRecentTokens, "keepRecentTokens", warnings),
		fallbackOverheadTokens: positiveInteger(input.fallbackOverheadTokens, DEFAULT_CONFIG.fallbackOverheadTokens, "fallbackOverheadTokens", warnings),
		minReductionTokens: positiveInteger(input.minReductionTokens, DEFAULT_CONFIG.minReductionTokens, "minReductionTokens", warnings),
		minReductionRatio: ratio(input.minReductionRatio, DEFAULT_CONFIG.minReductionRatio, "minReductionRatio", warnings),
		maxWaitMs: positiveInteger(input.maxWaitMs, DEFAULT_CONFIG.maxWaitMs, "maxWaitMs", warnings),
		summaryTimeoutMs: positiveInteger(input.summaryTimeoutMs, DEFAULT_CONFIG.summaryTimeoutMs, "summaryTimeoutMs", warnings),
		summaryReserveTokens: positiveInteger(input.summaryReserveTokens, DEFAULT_CONFIG.summaryReserveTokens, "summaryReserveTokens", warnings),
		minCallsBetweenRefresh: positiveInteger(input.minCallsBetweenRefresh, DEFAULT_CONFIG.minCallsBetweenRefresh, "minCallsBetweenRefresh", warnings),
		artifactThresholdTokens: positiveInteger(input.artifactThresholdTokens, DEFAULT_CONFIG.artifactThresholdTokens, "artifactThresholdTokens", warnings),
		artifactPreviewChars: positiveInteger(input.artifactPreviewChars, DEFAULT_CONFIG.artifactPreviewChars, "artifactPreviewChars", warnings),
		artifactToolNames: toolNames.length > 0 ? toolNames : DEFAULT_CONFIG.artifactToolNames,
		virtualizeLargeInputs: typeof input.virtualizeLargeInputs === "boolean" ? input.virtualizeLargeInputs : DEFAULT_CONFIG.virtualizeLargeInputs,
		maxSingleInputTokens: positiveInteger(input.maxSingleInputTokens, DEFAULT_CONFIG.maxSingleInputTokens, "maxSingleInputTokens", warnings),
		debugLog: typeof input.debugLog === "boolean" ? input.debugLog : DEFAULT_CONFIG.debugLog,
		allowCrossProvider: typeof input.allowCrossProvider === "boolean" ? input.allowCrossProvider : DEFAULT_CONFIG.allowCrossProvider,
		summaryModel: {
			provider: typeof rawSummaryModel.provider === "string" && rawSummaryModel.provider.length > 0
				? rawSummaryModel.provider
				: DEFAULT_CONFIG.summaryModel.provider,
			id: typeof rawSummaryModel.id === "string" && rawSummaryModel.id.length > 0
				? rawSummaryModel.id
				: DEFAULT_CONFIG.summaryModel.id,
			thinking,
		},
	};

	if (!(config.targetTokens < config.prepareTokens && config.prepareTokens < config.swapTokens && config.swapTokens < config.emergencyTokens)) {
		warnings.push("token thresholds must satisfy target < prepare < swap < emergency; restored safe defaults");
		config.targetTokens = DEFAULT_CONFIG.targetTokens;
		config.prepareTokens = DEFAULT_CONFIG.prepareTokens;
		config.swapTokens = DEFAULT_CONFIG.swapTokens;
		config.emergencyTokens = DEFAULT_CONFIG.emergencyTokens;
	}
	if (config.keepRecentTokens >= config.targetTokens) {
		warnings.push("keepRecentTokens must be below targetTokens; using the default");
		config.keepRecentTokens = DEFAULT_CONFIG.keepRecentTokens;
	}

	return { config, warnings };
}

export function mergeConfigValues(globalValue: unknown, projectValue: unknown): Record<string, unknown> {
	const globalConfig = record(globalValue);
	const projectConfig = record(projectValue);
	return {
		...globalConfig,
		...projectConfig,
		summaryModel: {
			...record(globalConfig.summaryModel),
			...record(projectConfig.summaryModel),
		},
	};
}

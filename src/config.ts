export type VirtualContextMode = "off" | "shadow" | "enabled";

export type ThresholdsMode = "static" | "ratio";

export interface SummaryModelConfig {
	provider: string;
	id: string;
	thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

export interface ThresholdOverride {
	provider?: string;
	model?: string;
	prepareTokens: number;
	swapTokens: number;
	targetTokens: number;
	emergencyTokens: number;
}

export interface VirtualContextConfig {
	mode: VirtualContextMode;
	thresholdsMode: ThresholdsMode;
	thresholdOverrides: ThresholdOverride[];
	prepareTokens: number;
	swapTokens: number;
	targetTokens: number;
	emergencyTokens: number;
	prepareRatio: number;
	swapRatio: number;
	targetRatio: number;
	emergencyRatio: number;
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
	thresholdsMode: "static",
	thresholdOverrides: [],
	prepareTokens: 80_000,
	swapTokens: 95_000,
	targetTokens: 65_000,
	emergencyTokens: 120_000,
	prepareRatio: 0.3,
	swapRatio: 0.4,
	targetRatio: 0.25,
	emergencyRatio: 0.55,
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

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveIntegerOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function normalizeThresholdOverrides(value: unknown, warnings: string[]): ThresholdOverride[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		warnings.push("thresholdOverrides must be an array; ignoring it");
		return [];
	}

	const overrides: ThresholdOverride[] = [];
	const selectors = new Set<string>();
	for (const [index, item] of value.entries()) {
		const input = record(item);
		const provider = nonEmptyString(input.provider);
		const model = nonEmptyString(input.model);
		if (!provider && !model) {
			warnings.push(`thresholdOverrides[${index}] must specify a non-empty provider or model; ignoring it`);
			continue;
		}

		const prepareTokens = positiveIntegerOrUndefined(input.prepareTokens);
		const swapTokens = positiveIntegerOrUndefined(input.swapTokens);
		const targetTokens = positiveIntegerOrUndefined(input.targetTokens);
		const emergencyTokens = positiveIntegerOrUndefined(input.emergencyTokens);
		if (prepareTokens === undefined || swapTokens === undefined || targetTokens === undefined || emergencyTokens === undefined) {
			warnings.push(`thresholdOverrides[${index}] must provide four positive integer thresholds; ignoring it`);
			continue;
		}
		if (!(targetTokens < prepareTokens && prepareTokens < swapTokens && swapTokens < emergencyTokens)) {
			warnings.push(`thresholdOverrides[${index}] thresholds must satisfy target < prepare < swap < emergency; ignoring it`);
			continue;
		}

		const selectorKey = JSON.stringify([provider, model]);
		if (selectors.has(selectorKey)) {
			warnings.push(`thresholdOverrides[${index}] duplicates an earlier provider/model selector; ignoring it`);
			continue;
		}
		selectors.add(selectorKey);
		overrides.push({
			...(provider ? { provider } : {}),
			...(model ? { model } : {}),
			prepareTokens,
			swapTokens,
			targetTokens,
			emergencyTokens,
		});
	}
	return overrides;
}

export function normalizeConfig(value: unknown): NormalizedConfig {
	const input = record(value);
	const warnings: string[] = [];
	const rawMode = input.mode;
	const mode: VirtualContextMode = rawMode === "off" || rawMode === "shadow" || rawMode === "enabled"
		? rawMode
		: DEFAULT_CONFIG.mode;
	if (rawMode !== undefined && rawMode !== mode) warnings.push(`mode must be off, shadow, or enabled; using ${mode}`);

	const rawThresholdsMode = input.thresholdsMode;
	const thresholdsMode: ThresholdsMode = rawThresholdsMode === "ratio" || rawThresholdsMode === "static"
		? rawThresholdsMode
		: DEFAULT_CONFIG.thresholdsMode;
	if (rawThresholdsMode !== undefined && rawThresholdsMode !== thresholdsMode) warnings.push(`thresholdsMode must be static or ratio; using ${thresholdsMode}`);

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
		thresholdsMode,
		thresholdOverrides: normalizeThresholdOverrides(input.thresholdOverrides, warnings),
		prepareTokens: positiveInteger(input.prepareTokens, DEFAULT_CONFIG.prepareTokens, "prepareTokens", warnings),
		swapTokens: positiveInteger(input.swapTokens, DEFAULT_CONFIG.swapTokens, "swapTokens", warnings),
		targetTokens: positiveInteger(input.targetTokens, DEFAULT_CONFIG.targetTokens, "targetTokens", warnings),
		emergencyTokens: positiveInteger(input.emergencyTokens, DEFAULT_CONFIG.emergencyTokens, "emergencyTokens", warnings),
		prepareRatio: ratio(input.prepareRatio, DEFAULT_CONFIG.prepareRatio, "prepareRatio", warnings),
		swapRatio: ratio(input.swapRatio, DEFAULT_CONFIG.swapRatio, "swapRatio", warnings),
		targetRatio: ratio(input.targetRatio, DEFAULT_CONFIG.targetRatio, "targetRatio", warnings),
		emergencyRatio: ratio(input.emergencyRatio, DEFAULT_CONFIG.emergencyRatio, "emergencyRatio", warnings),
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
	if (!(config.targetRatio < config.prepareRatio && config.prepareRatio < config.swapRatio && config.swapRatio < config.emergencyRatio)) {
		warnings.push("ratio thresholds must satisfy target < prepare < swap < emergency; restored safe defaults");
		config.targetRatio = DEFAULT_CONFIG.targetRatio;
		config.prepareRatio = DEFAULT_CONFIG.prepareRatio;
		config.swapRatio = DEFAULT_CONFIG.swapRatio;
		config.emergencyRatio = DEFAULT_CONFIG.emergencyRatio;
	}
	if (config.keepRecentTokens >= config.targetTokens) {
		warnings.push("keepRecentTokens must be below targetTokens; using the default");
		config.keepRecentTokens = DEFAULT_CONFIG.keepRecentTokens;
	}

	return { config, warnings };
}

export interface ResolvedThresholds {
	prepareTokens: number;
	swapTokens: number;
	targetTokens: number;
	emergencyTokens: number;
	source: "static" | "ratio" | "override";
}

/**
 * Resolve the effective thresholds for the active model. A provider+model
 * override takes precedence over a single-field selector, with the first entry
 * winning within the same specificity. Without a match, ratio mode keeps the
 * static token values as the floor.
 */
export function resolveThresholds(
	config: VirtualContextConfig,
	contextWindow: number | undefined,
	model?: { provider?: string; id?: string },
): ResolvedThresholds {
	let matchedOverride: ThresholdOverride | undefined;
	let matchedSpecificity = 0;
	for (const override of config.thresholdOverrides ?? []) {
		if (override.provider !== undefined && override.provider !== model?.provider) continue;
		if (override.model !== undefined && override.model !== model?.id) continue;
		const specificity = Number(override.provider !== undefined) + Number(override.model !== undefined);
		if (specificity > matchedSpecificity) {
			matchedOverride = override;
			matchedSpecificity = specificity;
		}
	}
	if (matchedOverride) {
		return {
			prepareTokens: matchedOverride.prepareTokens,
			swapTokens: matchedOverride.swapTokens,
			targetTokens: matchedOverride.targetTokens,
			emergencyTokens: matchedOverride.emergencyTokens,
			source: "override",
		};
	}

	const staticThresholds: ResolvedThresholds = {
		prepareTokens: config.prepareTokens,
		swapTokens: config.swapTokens,
		targetTokens: config.targetTokens,
		emergencyTokens: config.emergencyTokens,
		source: "static",
	};
	if (config.thresholdsMode !== "ratio") return staticThresholds;
	if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) return staticThresholds;
	return {
		prepareTokens: Math.max(config.prepareTokens, Math.floor(contextWindow * config.prepareRatio)),
		swapTokens: Math.max(config.swapTokens, Math.floor(contextWindow * config.swapRatio)),
		targetTokens: Math.max(config.targetTokens, Math.floor(contextWindow * config.targetRatio)),
		emergencyTokens: Math.max(config.emergencyTokens, Math.floor(contextWindow * config.emergencyRatio)),
		source: "ratio",
	};
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

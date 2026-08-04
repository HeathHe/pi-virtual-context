import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, mergeConfigValues, normalizeConfig, resolveThresholds } from "../src/config.ts";

test("normalizes the recommended threshold order", () => {
	const { config, warnings } = normalizeConfig({
		mode: "enabled",
		targetTokens: 60_000,
		prepareTokens: 80_000,
		swapTokens: 95_000,
		emergencyTokens: 120_000,
	});
	assert.equal(config.mode, "enabled");
	assert.equal(config.targetTokens, 60_000);
	assert.equal(config.debugLog, false);
	assert.equal(config.allowCrossProvider, false);
	assert.deepEqual(warnings, []);
});

test("cross-provider summaries require an explicit opt-in", () => {
	assert.equal(normalizeConfig({ allowCrossProvider: true }).config.allowCrossProvider, true);
	assert.equal(normalizeConfig({ allowCrossProvider: "yes" }).config.allowCrossProvider, false);
});

test("restores safe thresholds when order is invalid", () => {
	const { config, warnings } = normalizeConfig({ targetTokens: 100_000, prepareTokens: 80_000 });
	assert.equal(config.targetTokens, DEFAULT_CONFIG.targetTokens);
	assert.equal(config.prepareTokens, DEFAULT_CONFIG.prepareTokens);
	assert.ok(warnings.some((warning) => warning.includes("target < prepare")));
});

test("project settings override global summary model fields", () => {
	const merged = mergeConfigValues(
		{ mode: "shadow", summaryModel: { provider: "ark", id: "one", thinking: "off" } },
		{ mode: "enabled", summaryModel: { id: "two" } },
	);
	assert.deepEqual(merged.summaryModel, { provider: "ark", id: "two", thinking: "off" });
	assert.equal(merged.mode, "enabled");
});

test("ratio mode scales thresholds with the active model context window", () => {
	const { config } = normalizeConfig({ thresholdsMode: "ratio" });
	const resolved = resolveThresholds(config, 1_000_000);
	assert.equal(resolved.source, "ratio");
	assert.equal(resolved.prepareTokens, 300_000);
	assert.equal(resolved.swapTokens, 400_000);
	assert.equal(resolved.targetTokens, 250_000);
	assert.equal(resolved.emergencyTokens, 550_000);
});

test("ratio mode keeps static thresholds as the floor for small windows", () => {
	const { config } = normalizeConfig({ thresholdsMode: "ratio" });
	const resolved = resolveThresholds(config, 200_000);
	assert.equal(resolved.source, "ratio");
	assert.equal(resolved.prepareTokens, DEFAULT_CONFIG.prepareTokens);
	assert.equal(resolved.swapTokens, DEFAULT_CONFIG.swapTokens);
	assert.equal(resolved.targetTokens, DEFAULT_CONFIG.targetTokens);
	assert.equal(resolved.emergencyTokens, DEFAULT_CONFIG.emergencyTokens);
});

test("ratio mode falls back to static thresholds without a usable context window", () => {
	const { config } = normalizeConfig({ thresholdsMode: "ratio" });
	for (const contextWindow of [undefined, 0, Number.NaN]) {
		const resolved = resolveThresholds(config, contextWindow);
		assert.equal(resolved.source, "static");
		assert.equal(resolved.prepareTokens, DEFAULT_CONFIG.prepareTokens);
	}
});

test("invalid ratio ordering restores safe ratio defaults", () => {
	const { config, warnings } = normalizeConfig({ thresholdsMode: "ratio", prepareRatio: 0.5, swapRatio: 0.4 });
	assert.equal(config.prepareRatio, DEFAULT_CONFIG.prepareRatio);
	assert.equal(config.swapRatio, DEFAULT_CONFIG.swapRatio);
	assert.ok(warnings.some((warning) => warning.includes("ratio thresholds")));
});

test("static mode ignores the context window", () => {
	const { config } = normalizeConfig({});
	const resolved = resolveThresholds(config, 1_000_000);
	assert.equal(resolved.source, "static");
	assert.equal(resolved.prepareTokens, DEFAULT_CONFIG.prepareTokens);
});

const VALID_OVERRIDE = {
	provider: "kimi-coding",
	prepareTokens: 60_000,
	swapTokens: 75_000,
	targetTokens: 45_000,
	emergencyTokens: 90_000,
};

test("normalizes a complete threshold override", () => {
	const { config, warnings } = normalizeConfig({ thresholdOverrides: [VALID_OVERRIDE] });
	assert.deepEqual(config.thresholdOverrides, [VALID_OVERRIDE]);
	assert.deepEqual(warnings, []);
});

test("rejects a threshold override without a selector", () => {
	const { config, warnings } = normalizeConfig({
		thresholdOverrides: [{ ...VALID_OVERRIDE, provider: undefined }],
	});
	assert.deepEqual(config.thresholdOverrides, []);
	assert.ok(warnings.some((warning) => warning.includes("provider or model")));
});

test("rejects a threshold override with a missing or non-integer threshold", () => {
	const missing = { ...VALID_OVERRIDE } as Record<string, unknown>;
	delete missing.emergencyTokens;
	const { config, warnings } = normalizeConfig({
		thresholdOverrides: [missing, { ...VALID_OVERRIDE, provider: "other", swapTokens: 75_000.5 }],
	});
	assert.deepEqual(config.thresholdOverrides, []);
	assert.equal(warnings.filter((warning) => warning.includes("four positive integer thresholds")).length, 2);
});

test("rejects an incorrectly ordered threshold override", () => {
	const { config, warnings } = normalizeConfig({
		thresholdOverrides: [{ ...VALID_OVERRIDE, targetTokens: 70_000 }],
	});
	assert.deepEqual(config.thresholdOverrides, []);
	assert.ok(warnings.some((warning) => warning.includes("target < prepare")));
});

test("keeps the first duplicate threshold override selector and warns", () => {
	const { config, warnings } = normalizeConfig({
		thresholdOverrides: [VALID_OVERRIDE, { ...VALID_OVERRIDE, prepareTokens: 65_000 }],
	});
	assert.deepEqual(config.thresholdOverrides, [VALID_OVERRIDE]);
	assert.ok(warnings.some((warning) => warning.includes("duplicates")));
});

test("resolves a provider-only threshold override", () => {
	const { config } = normalizeConfig({ thresholdOverrides: [VALID_OVERRIDE] });
	const resolved = resolveThresholds(config, 1_000_000, { provider: "kimi-coding", id: "kimi-k2" });
	assert.equal(resolved.source, "override");
	assert.equal(resolved.prepareTokens, VALID_OVERRIDE.prepareTokens);
	assert.equal(resolved.targetTokens, VALID_OVERRIDE.targetTokens);
});

test("a provider-and-model threshold override takes precedence over a provider-only match", () => {
	const exact = {
		provider: "kimi-coding",
		model: "kimi-k2",
		prepareTokens: 50_000,
		swapTokens: 65_000,
		targetTokens: 40_000,
		emergencyTokens: 80_000,
	};
	const { config } = normalizeConfig({ thresholdOverrides: [VALID_OVERRIDE, exact] });
	const resolved = resolveThresholds(config, 1_000_000, { provider: "kimi-coding", id: "kimi-k2" });
	assert.equal(resolved.source, "override");
	assert.equal(resolved.prepareTokens, exact.prepareTokens);
});

test("uses the first matching threshold override at the same specificity", () => {
	const first = { ...VALID_OVERRIDE, provider: undefined, model: "kimi-k2" };
	const second = { ...VALID_OVERRIDE, provider: undefined, model: "kimi-k2", prepareTokens: 65_000 };
	const config = { ...DEFAULT_CONFIG, thresholdOverrides: [first, second] };
	const resolved = resolveThresholds(config, 1_000_000, { provider: "kimi-coding", id: "kimi-k2" });
	assert.equal(resolved.prepareTokens, first.prepareTokens);
});

test("unmatched threshold overrides retain base ratio and static resolution", () => {
	const ratioConfig = normalizeConfig({ thresholdsMode: "ratio", thresholdOverrides: [VALID_OVERRIDE] }).config;
	assert.equal(resolveThresholds(ratioConfig, 1_000_000, { provider: "other", id: "model" }).source, "ratio");
	assert.equal(resolveThresholds(ratioConfig, 1_000_000, { provider: "other", id: "model" }).prepareTokens, 300_000);

	const staticConfig = normalizeConfig({ thresholdOverrides: [VALID_OVERRIDE] }).config;
	assert.equal(resolveThresholds(staticConfig, 1_000_000, { provider: "other", id: "model" }).source, "static");
	assert.equal(resolveThresholds(staticConfig, 1_000_000, { provider: "other", id: "model" }).prepareTokens, DEFAULT_CONFIG.prepareTokens);
});

test("project thresholdOverrides replace the global override table", () => {
	const projectOverrides = [{ ...VALID_OVERRIDE, provider: "project-provider" }];
	const merged = mergeConfigValues(
		{ thresholdOverrides: [VALID_OVERRIDE] },
		{ thresholdOverrides: projectOverrides },
	);
	assert.deepEqual(merged.thresholdOverrides, projectOverrides);
});

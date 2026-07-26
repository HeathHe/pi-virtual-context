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

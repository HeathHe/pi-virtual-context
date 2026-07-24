import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, mergeConfigValues, normalizeConfig } from "../src/config.ts";

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

import assert from "node:assert/strict";
import test from "node:test";
import type { FailoverConfig } from "../src/config.ts";
import { planFailover } from "../src/failover.ts";

const CONFIG: FailoverConfig = {
	enabled: true,
	chains: { "kimi-coding": ["ark/glm-5.2", "openai/gpt-next"] },
	maxFailoversPerSession: 6,
};

test("a source provider starts at the first configured failover target", () => {
	assert.deepEqual(planFailover(CONFIG, { provider: "kimi-coding", id: "kimi-k2" }, 0), {
		kind: "candidates",
		candidates: [
			{ provider: "ark", id: "glm-5.2" },
			{ provider: "openai", id: "gpt-next" },
		],
	});
});

test("a model already in a failover chain advances to the next target", () => {
	assert.deepEqual(planFailover(CONFIG, { provider: "ark", id: "glm-5.2" }, 1), {
		kind: "candidates",
		candidates: [{ provider: "openai", id: "gpt-next" }],
	});
	assert.deepEqual(planFailover(CONFIG, { provider: "openai", id: "gpt-next" }, 2), { kind: "exhausted" });
});

test("a configured chain cannot advance after reaching the session cap", () => {
	assert.deepEqual(planFailover({ ...CONFIG, maxFailoversPerSession: 1 }, { provider: "ark", id: "glm-5.2" }, 1), {
		kind: "cap_reached",
	});
});

test("disabled or unrelated providers do not produce a failover plan", () => {
	assert.deepEqual(planFailover({ ...CONFIG, enabled: false }, { provider: "kimi-coding", id: "kimi-k2" }, 0), { kind: "none" });
	assert.deepEqual(planFailover(CONFIG, { provider: "unconfigured", id: "model" }, 0), { kind: "none" });
});

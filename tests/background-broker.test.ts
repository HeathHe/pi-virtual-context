import assert from "node:assert/strict";
import test from "node:test";

import { BackgroundBroker } from "../src/background-broker.ts";

test("background broker serializes work and orders queued jobs by priority", async () => {
	const broker = new BackgroundBroker();
	broker.setForegroundActive(true);
	const lowPromise = broker.acquire({ owner: "low", priority: 10 });
	const highPromise = broker.acquire({ owner: "high", priority: 20 });
	await Promise.resolve();
	assert.deepEqual(broker.snapshot().queuedOwners, ["high", "low"]);

	broker.setForegroundActive(false);
	const high = await highPromise;
	assert.equal(broker.snapshot().activeOwner, "high");
	let lowSettled = false;
	void lowPromise.then(() => { lowSettled = true; });
	await Promise.resolve();
	assert.equal(lowSettled, false);

	high.release();
	const low = await lowPromise;
	assert.equal(broker.snapshot().activeOwner, "low");
	low.release();
});

test("foreground activity preempts active background work and blocks queued work", async () => {
	const broker = new BackgroundBroker();
	const active = await broker.acquire({ owner: "active", priority: 10 });
	broker.setForegroundActive(true, "foreground test");
	assert.equal(active.signal.aborted, true);
	assert.equal(active.signal.reason, "foreground test");

	const queuedPromise = broker.acquire({ owner: "queued", priority: 20 });
	active.release();
	await Promise.resolve();
	assert.equal(broker.snapshot().activeOwner, undefined);
	assert.deepEqual(broker.snapshot().queuedOwners, ["queued"]);

	broker.setForegroundActive(false);
	const queued = await queuedPromise;
	assert.equal(broker.snapshot().activeOwner, "queued");
	queued.release();
});

test("an aborted queued request is removed without blocking the queue", async () => {
	const broker = new BackgroundBroker();
	broker.setForegroundActive(true);
	const controller = new AbortController();
	const aborted = broker.acquire({ owner: "aborted", priority: 20, signal: controller.signal });
	controller.abort("cancelled");
	await assert.rejects(aborted, /cancelled/);
	assert.deepEqual(broker.snapshot().queuedOwners, []);
});

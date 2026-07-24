import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../src/artifacts.ts";
import { TelemetryWriter } from "../src/telemetry.ts";

test("provider artifact references remain readable under both home and external roots", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-vctx-artifact-"));
	try {
		const store = new ArtifactStore(root, "session-private");
		const artifact = await store.archiveText("full private result");
		const reference = store.providerPath(artifact.path);
		assert.ok(reference.startsWith("~/") || reference.startsWith("/"));
		const resolved = reference.startsWith("~/") ? join(process.env.HOME ?? "", reference.slice(2)) : reference;
		assert.equal(await readFile(resolved, "utf8"), "full private result");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("large user input virtualization is provider-only and preserves a readable full artifact", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-vctx-user-artifact-"));
	try {
		const store = new ArtifactStore(root, "session");
		const original = { role: "user", content: "important ".repeat(100), timestamp: Date.now() } as any;
		const config = { maxSingleInputTokens: 10, virtualizeLargeInputs: true } as any;
		const [projected] = await store.transformLargeUserInputs([original], config);

		assert.notEqual(projected, original);
		assert.equal(original.content, "important ".repeat(100));
		assert.match(String((projected as any).content), /verbatim user input is stored at/);
		const path = String((projected as any).content).match(/stored at (.+?) \(sha256/)?.[1];
		assert.ok(path);
		const resolved = path.startsWith("~/") ? join(process.env.HOME ?? "", path.slice(2)) : path;
		assert.equal(await readFile(resolved, "utf8"), original.content);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("provider transformation drops only convergence controls from older user turns", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-vctx-control-"));
	try {
		const store = new ArtifactStore(root, "session");
		const oldUser = { role: "user", content: "old task", timestamp: 1 } as any;
		const staleControl = { role: "custom", customType: "pi-convergence-control", content: "stop tools", display: false, timestamp: 2 } as any;
		const newUser = { role: "user", content: "new task", timestamp: 3 } as any;
		const currentControl = { role: "custom", customType: "pi-convergence-control", content: "current control", display: false, timestamp: 4 } as any;
		const config = { maxSingleInputTokens: 10_000, virtualizeLargeInputs: true } as any;

		const projected = await store.transformLargeUserInputs([oldUser, staleControl, newUser, currentControl], config);

		assert.deepEqual(projected, [oldUser, newUser, currentControl]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("large user input fails open when its artifact cannot be written", async () => {
	const store = new ArtifactStore("/unused", "session");
	store.archiveText = async () => {
		throw new Error("disk full");
	};
	const original = { role: "user", content: "important ".repeat(100), timestamp: Date.now() } as any;
	const config = { maxSingleInputTokens: 10, virtualizeLargeInputs: true } as any;

	const [projected] = await store.transformLargeUserInputs([original], config);

	assert.equal(projected, original);
});

test("telemetry hashes session ids, redacts paths and credentials, and uses private permissions", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-vctx-telemetry-"));
	try {
		const writer = new TelemetryWriter(root, "raw-session-id", true);
		writer.write({
			mode: "enabled",
			action: "test",
			details: { path: "/Users/private/project", authorization: "Bearer secret-token", error: "CUSTOMER_PROMPT_SECRET_9f31" },
		});
		await writer.flush();
		const files = (await import("node:fs/promises")).readdir(root);
		const [file] = await files;
		const text = await readFile(join(root, file), "utf8");
		assert.doesNotMatch(file, /raw-session-id/);
		assert.doesNotMatch(text, /raw-session-id|\/Users\/private|secret-token|CUSTOMER_PROMPT_SECRET_9f31/);
		assert.equal((await stat(root)).mode & 0o777, 0o700);
		assert.equal((await stat(join(root, file))).mode & 0o777, 0o600);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

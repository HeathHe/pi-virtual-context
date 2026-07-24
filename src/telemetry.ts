import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { appendFile, chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface TelemetryRecord {
	timestamp?: string;
	sessionKey: string;
	mode: string;
	action: string;
	rawTokens?: number;
	projectedTokens?: number;
	overheadTokens?: number;
	rawMessages?: number;
	projectedMessages?: number;
	checkpointKind?: string;
	details?: Record<string, unknown>;
}

const SENSITIVE_KEY = /(?:path|cwd|sessionFile|api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|password|secret|credential)/i;
const UNTRUSTED_TEXT_KEY = /^(?:error|errorMessage|diagnostic|prompt|content)$/i;

function redact(value: unknown, key = ""): unknown {
	if (SENSITIVE_KEY.test(key)) return "[omitted]";
	if (UNTRUSTED_TEXT_KEY.test(key)) return "[omitted-untrusted-text]";
	if (typeof value === "string") {
		return value
			.replaceAll(homedir(), "~")
			.replace(/\/(?:Users|home)\/[^/\s"']+/g, "~")
			.replace(/\bBearer\s+[^\s"']+/gi, "Bearer [redacted]")
			.replace(/\b(?:sk|ark)-[A-Za-z0-9_-]{12,}\b/g, "[redacted-token]");
	}
	if (Array.isArray(value)) return value.map((item) => redact(item));
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
			childKey,
			redact(child, childKey),
		]));
	}
	return value;
}

export class TelemetryWriter {
	private readonly root: string;
	private readonly sessionKey: string;
	private readonly enabled: boolean;
	private queue: Promise<void> = Promise.resolve();

	constructor(root: string, sessionId: string, enabled = true) {
		this.root = root;
		this.sessionKey = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
		this.enabled = enabled;
	}

	write(record: Omit<TelemetryRecord, "timestamp" | "sessionKey">): void {
		if (!this.enabled) return;
		const line = JSON.stringify(redact({ timestamp: new Date().toISOString(), sessionKey: this.sessionKey, ...record })) + "\n";
		this.queue = this.queue
			.then(async () => {
				await mkdir(this.root, { recursive: true, mode: 0o700 });
				await chmod(this.root, 0o700);
				const path = join(this.root, `${this.sessionKey}.jsonl`);
				await appendFile(path, line, { encoding: "utf8", mode: 0o600 });
				await chmod(path, 0o600);
			})
			.catch(() => undefined);
	}

	async flush(): Promise<void> {
		await this.queue;
	}
}

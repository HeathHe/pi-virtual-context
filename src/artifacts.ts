import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { VirtualContextConfig } from "./config.ts";
import { estimateMessageTokens } from "./tokens.ts";

export interface ArtifactRecord {
	sha256: string;
	path: string;
	characters: number;
}

function safeSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "unknown";
}

function textOnly(message: Extract<AgentMessage, { role: "toolResult" }>): string | undefined {
	if (message.content.some((block) => block.type !== "text")) return undefined;
	return message.content.map((block) => block.type === "text" ? block.text : "").join("\n");
}

function userTextOnly(message: Extract<AgentMessage, { role: "user" }>): string | undefined {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content) || message.content.some((block) => block.type !== "text")) return undefined;
	return message.content.map((block) => block.type === "text" ? block.text : "").join("\n");
}

function isStaleConvergenceControl(message: AgentMessage, index: number, lastUserIndex: number): boolean {
	return message.role === "custom"
		&& (message as { customType?: unknown }).customType === "pi-convergence-control"
		&& index < lastUserIndex;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export class ArtifactStore {
	readonly sessionRoot: string;

	constructor(root: string, sessionId: string) {
		this.sessionRoot = join(root, safeSegment(sessionId));
	}

	async initialize(): Promise<void> {
		await mkdir(this.sessionRoot, { recursive: true, mode: 0o700 });
		await chmod(this.sessionRoot, 0o700);
	}

	providerPath(path: string): string {
		const homeRelative = relative(homedir(), path);
		return homeRelative !== "" && homeRelative !== ".." && !homeRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(homeRelative)
			? `~/${homeRelative}`
			: path;
	}

	async archiveText(text: string, label = "content"): Promise<ArtifactRecord> {
		await this.initialize();
		const sha256 = createHash("sha256").update(text).digest("hex");
		const path = join(this.sessionRoot, `${sha256}.txt`);
		if (!(await pathExists(path))) {
			const temporary = join(this.sessionRoot, `.${safeSegment(label)}-${randomUUID()}.tmp`);
			await writeFile(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
			try {
				await rename(temporary, path);
			} catch (error) {
				if (!(await pathExists(path))) throw error;
			}
		}
		await chmod(path, 0o600);
		return { sha256, path, characters: text.length };
	}

	async archiveToolResult(message: Extract<AgentMessage, { role: "toolResult" }>, config: VirtualContextConfig): Promise<ArtifactRecord | undefined> {
		if (!config.artifactToolNames.includes(message.toolName)) return undefined;
		if (estimateMessageTokens(message) < config.artifactThresholdTokens) return undefined;
		const text = textOnly(message);
		if (!text) return undefined;
		return this.archiveText(text, `${message.toolName}-${message.toolCallId}`);
	}

	async virtualizeToolResult(
		message: Extract<AgentMessage, { role: "toolResult" }>,
		config: VirtualContextConfig,
		allowHypothetical = false,
	): Promise<AgentMessage> {
		if (!config.artifactToolNames.includes(message.toolName)) return message;
		if (estimateMessageTokens(message) < config.artifactThresholdTokens) return message;
		const text = textOnly(message);
		if (!text) return message;
		const sha256 = createHash("sha256").update(text).digest("hex");
		const path = join(this.sessionRoot, `${sha256}.txt`);
		if (!allowHypothetical && !(await pathExists(path))) return message;
		const half = Math.max(200, Math.floor(config.artifactPreviewChars / 2));
		const preview = text.length <= config.artifactPreviewChars
			? text
			: `${text.slice(0, half)}\n…[middle omitted]…\n${text.slice(-half)}`;
		return {
			...message,
			content: [{
				type: "text",
				text: `${preview}\n\n[pi-virtual-context archived full ${message.toolName} result]\npath: ${this.providerPath(path)}\nsha256: ${sha256}\ncharacters: ${text.length}`,
			}],
		};
	}

	async virtualizeUserMessage(
		message: Extract<AgentMessage, { role: "user" }>,
		config: VirtualContextConfig,
		allowHypothetical = false,
	): Promise<AgentMessage> {
		if (!config.virtualizeLargeInputs || estimateMessageTokens(message) < config.maxSingleInputTokens) return message;
		const text = userTextOnly(message);
		if (!text) return message;
		const sha256 = createHash("sha256").update(text).digest("hex");
		const path = join(this.sessionRoot, `${sha256}.txt`);
		if (!allowHypothetical) {
			try {
				await this.archiveText(text, "large-user-input");
			} catch {
				return message;
			}
		}
		const half = 2_000;
		const preview = text.length <= half * 2
			? text
			: `${text.slice(0, half)}\n…[large input archived]…\n${text.slice(-half)}`;
		return {
			...message,
			content: `[pi-virtual-context: the verbatim user input is stored at ${this.providerPath(path)} (sha256 ${sha256}). Read that file in chunks before acting; the preview below is incomplete.]\n\n${preview}`,
		} as AgentMessage;
	}

	async transformLargeUserInputs(messages: AgentMessage[], config: VirtualContextConfig): Promise<AgentMessage[]> {
		const result: AgentMessage[] = [];
		let lastUserIndex = -1;
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			if (messages[index].role === "user") {
				lastUserIndex = index;
				break;
			}
		}
		for (let index = 0; index < messages.length; index += 1) {
			const message = messages[index];
			if (isStaleConvergenceControl(message, index, lastUserIndex)) continue;
			if (message.role === "user") result.push(await this.virtualizeUserMessage(message, config));
			else result.push(message);
		}
		return result;
	}

	async transformMessages(messages: AgentMessage[], config: VirtualContextConfig, allowHypothetical = false): Promise<AgentMessage[]> {
		const result: AgentMessage[] = [];
		let lastUserIndex = -1;
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			if (messages[index].role === "user") {
				lastUserIndex = index;
				break;
			}
		}
		for (let index = 0; index < messages.length; index += 1) {
			const message = messages[index];
			if (isStaleConvergenceControl(message, index, lastUserIndex)) continue;
			if (message.role === "toolResult") result.push(await this.virtualizeToolResult(message, config, allowHypothetical));
			else if (message.role === "user") result.push(await this.virtualizeUserMessage(message, config, allowHypothetical));
			else result.push(message);
		}
		return result;
	}
}

import type { FailoverConfig } from "./config.ts";

export interface FailoverModelRef {
	provider: string;
	id: string;
}

export type FailoverPlan =
	| { kind: "none" }
	| { kind: "cap_reached" }
	| { kind: "exhausted" }
	| { kind: "candidates"; candidates: FailoverModelRef[] };

export function formatModelRef(model: FailoverModelRef): string {
	return `${model.provider}/${model.id}`;
}

export function parseModelRef(value: string): FailoverModelRef | undefined {
	const separator = value.indexOf("/");
	if (separator <= 0) return undefined;
	const provider = value.slice(0, separator).trim();
	const id = value.slice(separator + 1).trim();
	return provider && id ? { provider, id } : undefined;
}

export function sameModelRef(left: FailoverModelRef | undefined, right: FailoverModelRef | undefined): boolean {
	return left?.provider === right?.provider && left?.id === right?.id;
}

/**
 * Resolve the remaining provider/model targets for a transient failure. A
 * provider key starts a chain; a model already present in a chain advances to
 * the entries after it.
 */
export function planFailover(
	config: FailoverConfig,
	current: FailoverModelRef,
	failoverCount: number,
): FailoverPlan {
	if (!config.enabled) return { kind: "none" };

	let targets: string[] | undefined = config.chains[current.provider];
	let matched = targets !== undefined;
	if (!matched) {
		const currentKey = formatModelRef(current);
		for (const chain of Object.values(config.chains)) {
			const index = chain.indexOf(currentKey);
			if (index < 0) continue;
			targets = chain.slice(index + 1);
			matched = true;
			break;
		}
	}
	if (!matched || !targets) return { kind: "none" };
	if (failoverCount >= config.maxFailoversPerSession) return { kind: "cap_reached" };
	if (targets.length === 0) return { kind: "exhausted" };

	return {
		kind: "candidates",
		candidates: targets.flatMap((target) => {
			const parsed = parseModelRef(target);
			return parsed ? [parsed] : [];
		}),
	};
}

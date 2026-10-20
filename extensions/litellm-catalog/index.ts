/**
 * litellm-catalog — модели провайдера litellm берутся из самого LiteLLM, а не из models.json.
 *
 * Зачем: длина контекста, потолок вывода и картинки — свойства бэкенда (CTX_SIZE в .env
 * llama-server, mmproj и т.п.). Они уже записаны в model_info LiteLLM, и держать их копию
 * в models.json значит править её при каждой смене ctx.
 *
 * Что берётся из GET <baseUrl>/model/info (по ключу pi — только модели из его скоупа):
 *   id/name        model_name
 *   contextWindow  max_input_tokens (или context_window)
 *   maxTokens      max_tokens (или max_output_tokens)
 *   input          supports_vision → ["text","image"]
 *   reasoning      supports_reasoning
 * Несколько деплойментов под одним model_name (фолбэк-группа) сводятся к наименьшим
 * лимитам и к пересечению возможностей — запрос может уйти в любой из них.
 * Модель без max_input_tokens пропускается: молча подставить чужое число — ровно та
 * ошибка, от которой расширение избавляет.
 *
 * Чего LiteLLM не знает, остаётся в models.json: baseUrl, api, ключ и compat провайдера
 * читаются оттуда, а thinkingLevelMap, chatTemplateKwargs и прочее — в modelOverrides,
 * которые pi накладывает поверх моделей расширения.
 *
 * Каталог запрашивается в фабрике (pi её дожидается, так что модели есть уже при выборе
 * модели на старте) с таймаутом и пишется в <agentDir>/litellm-catalog.json. Нет сети или
 * LiteLLM лежит — берётся этот снимок. refreshModels перечитывает каталог, когда pi
 * обновляет модели с разрешённой сетью.
 *
 * /litellm-catalog — показать, откуда и что загружено.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ProviderConfig,
	type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";

const PROVIDER = "litellm";
const FETCH_TIMEOUT_MS = 4000;

/** Поля provider-записи models.json, нужные расширению. */
type ProviderJson = {
	baseUrl?: string;
	api?: ProviderConfig["api"];
	compat?: Record<string, unknown>;
};

/** Одна запись /model/info. LiteLLM отдаёт сотни полей, читаем пять. */
type ModelInfoEntry = {
	model_name?: string;
	model_info?: {
		max_input_tokens?: number | null;
		context_window?: number | null;
		max_tokens?: number | null;
		max_output_tokens?: number | null;
		supports_vision?: boolean | null;
		supports_reasoning?: boolean | null;
	};
};

/** Chat-ветка ProviderModelConfig: только у неё есть contextWindow, maxTokens, reasoning и compat. */
type ChatModelConfig = Extract<ProviderModelConfig, { reasoning: boolean }>;

type Catalog = {
	fetchedAt: string;
	baseUrl: string;
	models: ChatModelConfig[];
	skipped: string[];
};

function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function positive(...values: Array<number | null | undefined>): number | undefined {
	for (const value of values) {
		if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
	}
	return undefined;
}

/** Записи /model/info → модели pi. Чистая функция, без сети. */
export function toModels(
	entries: ModelInfoEntry[],
	compat: Record<string, unknown> | undefined,
): { models: ChatModelConfig[]; skipped: string[] } {
	const groups = new Map<string, ModelInfoEntry[]>();
	for (const entry of entries) {
		const name = entry.model_name;
		if (!name) continue;
		groups.set(name, [...(groups.get(name) ?? []), entry]);
	}

	const models: ChatModelConfig[] = [];
	const skipped: string[] = [];
	for (const [name, deployments] of groups) {
		const infos = deployments.map((entry) => entry.model_info ?? {});
		const contexts = infos.map((info) => positive(info.max_input_tokens, info.context_window));
		if (contexts.some((value) => value === undefined)) {
			skipped.push(name);
			continue;
		}
		const outputs = infos
			.map((info) => positive(info.max_tokens, info.max_output_tokens))
			.filter((value): value is number => value !== undefined);
		const contextWindow = Math.min(...(contexts as number[]));
		models.push({
			id: name,
			name,
			input: infos.every((info) => info.supports_vision === true) ? ["text", "image"] : ["text"],
			reasoning: infos.every((info) => info.supports_reasoning === true),
			contextWindow,
			// Без max_tokens у LiteLLM — тот же дефолт, что pi ставит моделям models.json.
			maxTokens: outputs.length > 0 ? Math.min(...outputs) : Math.min(16384, contextWindow),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			...(compat ? { compat: compat as ChatModelConfig["compat"] } : {}),
		});
	}
	models.sort((a, b) => a.id.localeCompare(b.id));
	return { models, skipped };
}

/** Ключ из auth.json (/login или ручная запись): { "litellm": { "type": "api_key", "key": ... } }. */
function apiKey(agentDir: string): string | undefined {
	const auth = readJson<Record<string, { type?: string; key?: string }>>(join(agentDir, "auth.json"));
	const entry = auth?.[PROVIDER];
	return entry?.type === "api_key" && entry.key ? entry.key : undefined;
}

async function fetchCatalog(
	baseUrl: string,
	key: string,
	compat: Record<string, unknown> | undefined,
	signal?: AbortSignal,
): Promise<Catalog> {
	const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/model/info`, {
		headers: { Authorization: `Bearer ${key}` },
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const body = (await response.json()) as { data?: ModelInfoEntry[] };
	const { models, skipped } = toModels(body.data ?? [], compat);
	if (models.length === 0) throw new Error("в ответе нет ни одной модели с max_input_tokens");
	return { fetchedAt: new Date().toISOString(), baseUrl, models, skipped };
}

export default async function litellmCatalog(pi: ExtensionAPI): Promise<void> {
	const agentDir = getAgentDir();
	const cachePath = join(agentDir, "litellm-catalog.json");
	const providerJson = readJson<{ providers?: Record<string, ProviderJson> }>(join(agentDir, "models.json"))
		?.providers?.[PROVIDER];
	const baseUrl = providerJson?.baseUrl;
	const api = providerJson?.api;
	const compat = providerJson?.compat;
	// Без baseUrl/api в models.json провайдера нет — это не наша конфигурация, молчим.
	if (!baseUrl || !api) return;

	let catalog: Catalog | undefined;
	let source = "нет каталога";
	let lastError: string | undefined;

	const save = (next: Catalog) => {
		catalog = next;
		try {
			writeFileSync(cachePath, `${JSON.stringify(next, null, "\t")}\n`);
		} catch {
			// Кеш — удобство, а не условие работы.
		}
	};

	const key = apiKey(agentDir);
	if (process.env.PI_OFFLINE) {
		lastError = "PI_OFFLINE: каталог не запрашивался";
	} else if (key) {
		try {
			save(await fetchCatalog(baseUrl, key, compat));
			source = "LiteLLM";
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
	} else {
		lastError = `нет ключа ${PROVIDER} в auth.json`;
	}
	if (!catalog) {
		const cached = readJson<Catalog>(cachePath);
		// Снимок с другим baseUrl (сменили адрес в pi.nix) — не наш, не берём.
		if (cached?.baseUrl === baseUrl && cached.models?.length) {
			catalog = cached;
			source = `кеш от ${cached.fetchedAt}`;
		}
	}

	if (catalog) {
		pi.registerProvider(PROVIDER, {
			baseUrl,
			api,
			models: catalog.models,
			async refreshModels(context) {
				const current = catalog?.models ?? [];
				if (!context.allowNetwork || context.signal.aborted) return current;
				const refreshKey = context.credential?.type === "api_key" ? context.credential.key : apiKey(agentDir);
				if (!refreshKey) return current;
				try {
					save(await fetchCatalog(baseUrl, refreshKey, compat, context.signal));
					source = "LiteLLM";
					lastError = undefined;
				} catch (error) {
					lastError = error instanceof Error ? error.message : String(error);
				}
				return catalog?.models ?? current;
			},
		});
	}

	pi.registerCommand("litellm-catalog", {
		description: "Откуда загружен каталог моделей litellm и что в нём",
		handler: async (_args, ctx) => {
			const lines = [`источник: ${source}`];
			if (lastError) lines.push(`ошибка запроса: ${lastError}`);
			for (const model of catalog?.models ?? []) {
				lines.push(
					`${model.id}: ctx ${model.contextWindow}, out ${model.maxTokens}, ${model.input.join("+")}` +
						`${model.reasoning ? ", reasoning" : ""}`,
				);
			}
			if (catalog?.skipped.length) lines.push(`без max_input_tokens, пропущены: ${catalog.skipped.join(", ")}`);
			ctx.ui.notify(lines.join("\n"), catalog ? "info" : "warning");
		},
	});
}

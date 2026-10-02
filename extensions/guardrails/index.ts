/**
 * Guardrails — правила работы с памятью graphiti, которые раньше жили в
 * промпте как «пожалуйста, не делай так».
 *
 * Правила висят на tool_call, поэтому работают независимо от того, прочитала
 * ли модель CONTEXT.md и в каком она настроении:
 *   - episode_body > 900 символов, длинный fact в add_triplet, clear_graph,
 *     кириллица в поисковом запросе → блок;
 *   - delete_episode / delete_entity_edge → диалог подтверждения.
 *
 * Инструменты встроенного MCP Pi называются mcp__<сервер>__<tool>, вызовы из
 * codemode-скриптов идут через тот же пайплайн и тоже сюда попадают.
 *
 * Подтверждение спрашивается один раз на правило: второй ответ «не спрашивать»
 * помечает правило разрешённым до конца сессии.
 *
 * /guardrails [on|off|status] — выключить на время отладки.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Verdict = {
	/** block — отказ без диалога, confirm — диалог подтверждения */
	mode: "block" | "confirm";
	rule: string;
	reason: string;
};

const MEMORY_PREFIX = "mcp__memory__";
const MAX_EPISODE_BODY = 900;
const MAX_TRIPLET_FACT = 200;
const CYRILLIC = /[а-яё]/i;

function inspectMemory(tool: string, input: Record<string, unknown>): Verdict | undefined {
	if (tool === "clear_graph") {
		return {
			mode: "block",
			rule: "clear-graph",
			reason: "clear_graph стирает всю группу main целиком — если это правда нужно, сделай вручную",
		};
	}

	if (tool === "add_memory") {
		const body = typeof input.episode_body === "string" ? input.episode_body : "";
		if (body.length > MAX_EPISODE_BODY) {
			return {
				mode: "block",
				rule: "episode-too-long",
				reason: `episode_body ${body.length} символов при лимите ${MAX_EPISODE_BODY}: длинные эпизоды теряются молча, разбей на несколько`,
			};
		}
	}

	if (tool === "add_triplet") {
		const fact = typeof input.fact === "string" ? input.fact : "";
		if (fact.length > MAX_TRIPLET_FACT) {
			return {
				mode: "block",
				rule: "triplet-too-long",
				reason: `fact ${fact.length} символов: одно ребро — один эмбеддинг, длинный fact засоряет поиск. Пиши эпизод через add_memory`,
			};
		}
	}

	if (tool === "search_nodes" || tool === "search_memory_facts") {
		const query = typeof input.query === "string" ? input.query : "";
		if (CYRILLIC.test(query)) {
			return {
				mode: "block",
				rule: "russian-query",
				reason: "память хранится по-английски, русский запрос вернёт пустоту — переформулируй",
			};
		}
	}

	if (tool === "delete_episode" || tool === "delete_entity_edge") {
		return { mode: "confirm", rule: "memory-delete", reason: "удаление из графа памяти" };
	}

	return undefined;
}

function inspect(toolName: string, input: Record<string, unknown>): Verdict | undefined {
	if (!toolName.startsWith(MEMORY_PREFIX)) return undefined;
	return inspectMemory(toolName.slice(MEMORY_PREFIX.length), input);
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	/** правила, для которых пользователь сказал «больше не спрашивай» */
	const allowed = new Set<string>();

	function showState(ctx: ExtensionContext): void {
		// Статус в футере нужен только когда гардрейлы выключены — это
		// нештатное состояние, о нём лучше помнить.
		ctx.ui.setStatus("guardrails", enabled ? undefined : ctx.ui.theme.fg("warning", "guardrails off"));
		const suffix = allowed.size > 0 ? `, разрешено на сессию: ${[...allowed].join(", ")}` : "";
		ctx.ui.notify(`Guardrails: ${enabled ? "on" : "off"}${suffix}`, "info");
	}

	pi.on("session_start", async (_event, ctx) => {
		allowed.clear();
		if (ctx.hasUI && !enabled) ctx.ui.setStatus("guardrails", ctx.ui.theme.fg("warning", "guardrails off"));
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) return undefined;

		const verdict = inspect(event.toolName, event.input as Record<string, unknown>);
		if (!verdict) return undefined;

		if (verdict.mode === "block") {
			if (ctx.hasUI) ctx.ui.notify(`Guardrail ${verdict.rule}: ${verdict.reason}`, "warning");
			return { block: true, reason: `Guardrail «${verdict.rule}»: ${verdict.reason}` };
		}

		if (allowed.has(verdict.rule)) return undefined;

		// Без UI (RPC, --print, cron) подтверждать некому — отказываем.
		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `Guardrail «${verdict.rule}»: ${verdict.reason}. Нет интерактивного режима для подтверждения.`,
			};
		}

		const choice = await ctx.ui.select(`Guardrail «${verdict.rule}»: ${verdict.reason}`, [
			"Отменить",
			"Выполнить один раз",
			`Выполнить и не спрашивать про «${verdict.rule}» до конца сессии`,
		]);

		if (choice === undefined || choice === "Отменить") {
			return { block: true, reason: `Отменено пользователем: ${event.toolName}` };
		}
		if (choice.startsWith("Выполнить и не спрашивать")) {
			allowed.add(verdict.rule);
		}
		return undefined;
	});

	pi.registerCommand("guardrails", {
		description: "Гардрейлы на работу с памятью graphiti: on | off | status",
		getArgumentCompletions: (prefix: string) => {
			const items = ["status", "on", "off"]
				.filter((v) => v.startsWith(prefix.toLowerCase()))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const arg = args?.trim().toLowerCase();
			if (arg === "on") enabled = true;
			else if (arg === "off") enabled = false;
			else if (arg && arg !== "status") {
				ctx.ui.notify("Usage: /guardrails [on|off|status]", "error");
				return;
			}
			showState(ctx);
		},
	});
}

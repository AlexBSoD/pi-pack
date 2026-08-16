/**
 * Guardrails — то, что раньше жило в промпте как «пожалуйста, не делай так».
 *
 * Правила висят на tool_call, поэтому работают независимо от того, прочитала
 * ли модель CONTEXT.md и в каком она настроении:
 *   - деструктивные bash-команды (rm, git reset --hard, podman rm, SQL DELETE
 *     без WHERE, перезапись файла редиректом) → диалог подтверждения;
 *   - запись в защищённые пути (agenix, *.age, ~/.ssh, disko.nix) → блок;
 *   - find/grep -r → блок с напоминанием про fd/rg;
 *   - fish-синтаксис в bash-инструменте → блок;
 *   - graphiti: episode_body > 900 символов, длинный fact в add_triplet,
 *     clear_graph, кириллица в поисковом запросе → блок.
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

/** Начало команды или начало сегмента после ; | && */
const SEGMENT = String.raw`(?:^|[;&|]\s*)`;

/** Деструктивные команды: спрашиваем подтверждение. */
const CONFIRM_BASH: Array<[RegExp, string, string]> = [
	[new RegExp(`${SEGMENT}(?:sudo\\s+)?rm\\s`), "rm", "удаление файлов"],
	[new RegExp(`${SEGMENT}(?:sudo\\s+)?rmdir\\s`), "rmdir", "удаление каталога"],
	[new RegExp(`${SEGMENT}(?:sudo\\s+)?(?:shred|truncate)\\s`), "shred", "затирание файла"],
	// rm, приехавший не первым словом: xargs rm, fd -x rm, find -exec rm
	[/\bxargs\s+(?:-\S+\s+)*rm\b|-[xX]\s+rm\b|-exec\s+rm\b/, "rm", "массовое удаление файлов"],
	[/\bgit\s+reset\s+--hard\b/, "git-reset-hard", "git reset --hard теряет незакоммиченное"],
	[/\bgit\s+push\b[^;&|]*\s(?:--force\b|-f\b)/, "git-push-force", "принудительный push переписывает историю"],
	[/\bgit\s+clean\b[^;&|]*\s-[a-zA-Z]*f/, "git-clean", "git clean -f удаляет неотслеживаемые файлы"],
	[/\bgit\s+rebase\b[^;&|]*--force/, "git-rebase-force", "принудительный rebase переписывает историю"],
	[/\b(?:podman|docker)\s+(?:rm|rmi)\b/, "podman-rm", "удаление контейнера или образа"],
	[/\b(?:podman|docker)\s+(?:\w+\s+)?prune\b/, "podman-prune", "prune удаляет всё неиспользуемое"],
	[/\b(?:podman|docker)\s+volume\s+rm\b/, "podman-volume-rm", "удаление тома вместе с данными"],
	[/\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE|SCHEMA)\b/i, "sql-drop", "DROP/TRUNCATE необратим"],
	[/\bDELETE\s+FROM\b(?![\s\S]*\bWHERE\b)/i, "sql-delete-all", "DELETE без WHERE чистит таблицу целиком"],
	[/\bmkfs\b|\bdd\s[^;&|]*\bof=\/dev\//, "raw-device-write", "запись напрямую на устройство"],
	[/\bnix-collect-garbage\b|\bnix\s+store\s+gc\b/, "nix-gc", "сборка мусора удаляет старые поколения"],
	[
		/(?<![>&\d])>(?!>)\s*(?!\/dev\/null|\/tmp\/|&)[^\s;&|]+/,
		"redirect-overwrite",
		"редирект > перезаписывает файл целиком",
	],
];

/** Блокируем наглухо: обратного пути нет либо чинится только руками. */
const BLOCK_BASH: Array<[RegExp, string, string]> = [
	[/\brm\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*[rf][a-zA-Z]*\s+\/(?:\s|$)/, "rm-root", "rm -rf / — нет"],
	[/\bnix-store\s+--delete\b/, "nix-store-delete", "ручное удаление из store ломает поколения"],
];

/** Пути, которые правит только человек (agenix, ключи, разметка дисков). */
const PROTECTED_PATHS: Array<[RegExp, string]> = [
	[/\/run\/agenix(?:\/|$)/, "секреты agenix монтируются рантаймом"],
	[/\.age$/, "шифрованные секреты правятся через `agenix -e`"],
	[/(?:^|\/)\.ssh\//, "ключи и конфиг SSH"],
	[/(?:^|\/)disko\.nix$/, "disko.nix применяется только при установке системы"],
	[/^\/nix\/store\//, "store неизменяем"],
	[/(?:^|\/)\.git\/(?:objects|refs|HEAD)/, "внутренности .git"],
];

/** Инструменты поиска: у нас есть fd и rg, и они быстрее. */
const SEARCH_TOOLING: Array<[RegExp, string, string]> = [
	[new RegExp(`${SEGMENT}find\\s`), "use-fd", "используй `fd` вместо `find`"],
	[new RegExp(`${SEGMENT}grep\\s[^;&|]*-[a-zA-Z]*[rR]`), "use-rg", "используй `rg` вместо `grep -r`"],
];

/** Fish-синтаксис в bash-инструменте: он исполняется под bash и упадёт. */
const FISH_SYNTAX: Array<[RegExp, string]> = [
	[/;\s*(?:and|or)\s/, "`; and` / `; or` — это fish, в bash пиши `&&` / `||`"],
	[/\bset\s+-[gxlU]+\s+\w+\s+\S/, "`set -gx VAR value` — это fish, в bash пиши `VAR=value`"],
	[/\bstring\s+(?:match|split|replace|join)\s/, "`string ...` — это fish, в bash используй sed/awk/parameter expansion"],
];

const MAX_EPISODE_BODY = 900;
const MAX_TRIPLET_FACT = 200;
const CYRILLIC = /[а-яё]/i;

function firstMatch<T extends unknown[]>(rules: Array<[RegExp, ...T]>, text: string): [RegExp, ...T] | undefined {
	return rules.find(([pattern]) => pattern.test(text));
}

function inspectBash(command: string): Verdict | undefined {
	const blocked = firstMatch(BLOCK_BASH, command);
	if (blocked) return { mode: "block", rule: blocked[1], reason: blocked[2] };

	const fish = firstMatch(FISH_SYNTAX, command);
	if (fish) return { mode: "block", rule: "fish-in-bash", reason: fish[1] };

	const search = firstMatch(SEARCH_TOOLING, command);
	if (search) return { mode: "block", rule: search[1], reason: search[2] };

	// Защищённые пути упомянуты в команде, которая пишет или удаляет
	if (/\b(?:rm|mv|cp|tee|truncate|shred)\b|>\s*\S|\bsed\s+-i\b/.test(command)) {
		const protectedPath = firstMatch(PROTECTED_PATHS, command);
		if (protectedPath) {
			return { mode: "block", rule: "protected-path", reason: `защищённый путь: ${protectedPath[1]}` };
		}
	}

	const destructive = firstMatch(CONFIRM_BASH, command);
	if (destructive) return { mode: "confirm", rule: destructive[1], reason: destructive[2] };

	return undefined;
}

function inspectPath(path: string): Verdict | undefined {
	const hit = firstMatch(PROTECTED_PATHS, path);
	if (!hit) return undefined;
	return { mode: "block", rule: "protected-path", reason: `${path}: ${hit[1]}` };
}

function inspectMemory(toolName: string, input: Record<string, unknown>): Verdict | undefined {
	const tool = toolName.replace(/^mcp__memory[_-]/, "");

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
	if (toolName === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		return inspectBash(command);
	}

	if (toolName === "write" || toolName === "edit") {
		const path = typeof input.path === "string" ? input.path : "";
		return inspectPath(path);
	}

	if (toolName.startsWith("mcp__memory")) {
		return inspectMemory(toolName, input);
	}

	return undefined;
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

		const command = typeof (event.input as { command?: unknown }).command === "string"
			? ((event.input as { command: string }).command)
			: event.toolName;

		const choice = await ctx.ui.select(`Guardrail «${verdict.rule}»: ${verdict.reason}`, [
			"Отменить",
			"Выполнить один раз",
			`Выполнить и не спрашивать про «${verdict.rule}» до конца сессии`,
		]);

		if (choice === undefined || choice === "Отменить") {
			return { block: true, reason: `Отменено пользователем: ${command}` };
		}
		if (choice.startsWith("Выполнить и не спрашивать")) {
			allowed.add(verdict.rule);
		}
		return undefined;
	});

	pi.registerCommand("guardrails", {
		description: "Гардрейлы на опасные команды: on | off | status",
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

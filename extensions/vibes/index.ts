/**
 * Vibes — тематические сообщения в строке загрузки pi.
 *
 * Наборы читаются из двух мест:
 *   - <директория расширения>/*.txt — встроенные (в NixOS приезжают из репы)
 *   - $PI_CODING_AGENT_DIR/vibes/*.txt (по умолчанию ~/.pi/agent/vibes) —
 *     пользовательские, одноимённый файл перекрывает встроенный
 *
 * Формат строки:
 *   [read,grep] Считываю дамп чужой памяти...   — показывается при вызове
 *                                                 этих инструментов
 *   Корректирую настройку деки...                — общий пул, показывается
 *                                                 на старте запроса
 *   # комментарий                                — игнорируется
 *
 * Команды:
 *   /vibes            — показать активный набор
 *   /vibes <набор>    — переключиться (all | off | имя файла)
 *
 * Выбор переживает перезапуск: пишется в $PI_CODING_AGENT_DIR/vibes-state.json.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, WorkingIndicatorOptions } from "@earendil-works/pi-coding-agent";

type VibeSet = {
	/** строки без тега — общий пул */
	general: string[];
	/** тег инструмента -> строки */
	byTool: Map<string, string[]>;
};

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const USER_VIBES_DIR = join(AGENT_DIR, "vibes");
const BUILTIN_VIBES_DIR = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(AGENT_DIR, "vibes-state.json");

const OFF = "off";
const ALL = "all";

/**
 * Инструмент -> тег в файле вайбов. Точное имя ищется первым, потом
 * префиксные правила (mcp-инструменты приходят как mcp__<сервер>__<tool>).
 */
const TOOL_PREFIX_TAGS: Array<[RegExp, string]> = [
	// pi называет MCP-инструменты как mcp__<сервер>_<tool>
	[/^mcp__memory[_-]/, "memory"],
	[/^mcp__(?:ripdown|search)[_-]|^fetch$|^web/, "web"],
	[/^mcp__/, "mcp"],
	[/subagent|^task$|^agent$/, "task"],
	[/todo/, "todo"],
	[/question|^ask/, "ask"],
];

/** Кадры спиннера под настроение набора. */
const INDICATORS: Record<string, WorkingIndicatorOptions> = {
	cyber: { frames: ["░", "▒", "▓", "█", "▓", "▒"], intervalMs: 110 },
	fallout: { frames: ["·", "∙", "•", "☢", "•", "∙"], intervalMs: 140 },
};

function parseVibeFile(content: string): VibeSet {
	const set: VibeSet = { general: [], byTool: new Map() };

	for (const raw of content.split("\n")) {
		const line = raw.trim();
		if (line.length === 0 || line.startsWith("#")) continue;

		const tagged = line.match(/^\[([a-z0-9_,\s-]+)\]\s*(.+)$/i);
		if (!tagged) {
			set.general.push(line);
			continue;
		}

		const text = tagged[2]!.trim();
		for (const tag of tagged[1]!.split(",")) {
			const key = tag.trim().toLowerCase();
			if (key.length === 0) continue;
			const bucket = set.byTool.get(key);
			if (bucket) bucket.push(text);
			else set.byTool.set(key, [text]);
		}
	}

	return set;
}

function loadDir(dir: string, into: Map<string, VibeSet>): void {
	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".txt"));
	} catch {
		return; // директории может не быть — это не ошибка
	}

	for (const file of files) {
		try {
			const parsed = parseVibeFile(readFileSync(join(dir, file), "utf-8"));
			if (parsed.general.length > 0 || parsed.byTool.size > 0) {
				into.set(file.replace(/\.txt$/, ""), parsed);
			}
		} catch {
			// нечитаемый файл пропускаем, остальные наборы должны работать
		}
	}
}

function pick(lines: string[]): string | undefined {
	if (lines.length === 0) return undefined;
	return lines[Math.floor(Math.random() * lines.length)];
}

function readState(): string | undefined {
	try {
		const parsed = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as { activeSet?: unknown };
		return typeof parsed.activeSet === "string" ? parsed.activeSet : undefined;
	} catch {
		return undefined;
	}
}

function writeState(activeSet: string): void {
	try {
		writeFileSync(STATE_FILE, `${JSON.stringify({ activeSet }, null, 2)}\n`);
	} catch {
		// не смогли сохранить — переживём, выбор просто не переживёт рестарт
	}
}

export default function (pi: ExtensionAPI) {
	const sets = new Map<string, VibeSet>();
	loadDir(BUILTIN_VIBES_DIR, sets);
	loadDir(USER_VIBES_DIR, sets); // пользовательский файл перекрывает встроенный

	const names = [...sets.keys()].sort();
	const options = [ALL, ...names, OFF].join(" | ");

	const saved = readState();
	let activeSet = saved && (saved === ALL || saved === OFF || sets.has(saved)) ? saved : ALL;

	// В режиме all тексты мешаются из всех наборов, но спиннер так не умеет:
	// кадры, меняющиеся на каждый инструмент, читаются как глитч. Поэтому
	// анимация выбирается случайно один раз за запуск и дальше не меняется.
	const sessionAllSet = pick(names.filter((name) => INDICATORS[name] !== undefined));

	const cycle = [ALL, ...names, OFF];
	pi.registerFlag("vibes", {
		description: `Набор вайбов на старте: ${cycle.join(" | ")}`,
		type: "string",
	});

	function isKnown(name: string): boolean {
		return name === ALL || name === OFF || sets.has(name);
	}

	function activeSets(): VibeSet[] {
		if (activeSet === OFF) return [];
		if (activeSet === ALL) return [...sets.values()];
		const one = sets.get(activeSet);
		return one ? [one] : [];
	}

	function generalVibe(): string | undefined {
		return pick(activeSets().flatMap((s) => s.general));
	}

	function toolVibe(toolName: string): string | undefined {
		const active = activeSets();
		if (active.length === 0) return undefined;

		const name = toolName.toLowerCase();
		const tags = [name];
		for (const [pattern, tag] of TOOL_PREFIX_TAGS) {
			if (pattern.test(name)) tags.push(tag);
		}

		for (const tag of tags) {
			const lines = active.flatMap((s) => s.byTool.get(tag) ?? []);
			const hit = pick(lines);
			if (hit) return hit;
		}
		return undefined;
	}

	function applyIndicator(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		// off и наборы без своих кадров отдают undefined — это штатный способ
		// вернуть дефолтный спиннер pi.
		const source = activeSet === ALL ? sessionAllSet : activeSet;
		ctx.ui.setWorkingIndicator(source ? INDICATORS[source] : undefined);
	}

	pi.on("session_start", async (_event, ctx) => {
		const fromFlag = pi.getFlag("vibes");
		if (typeof fromFlag === "string" && isKnown(fromFlag.toLowerCase())) {
			activeSet = fromFlag.toLowerCase(); // флаг важнее сохранённого выбора, но его не перезаписывает
		}
		applyIndicator(ctx);
	});

	pi.registerShortcut("ctrl+alt+v", {
		description: "Переключить набор вайбов",
		handler: async (ctx) => {
			activeSet = cycle[(cycle.indexOf(activeSet) + 1) % cycle.length] ?? ALL;
			writeState(activeSet);
			applyIndicator(ctx);
			if (activeSet === OFF) ctx.ui.setWorkingMessage();
			ctx.ui.notify(`Vibes: ${activeSet}`, "info");
		},
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const vibe = generalVibe();
		if (vibe) ctx.ui.setWorkingMessage(vibe);
	});

	// Сообщение меняется на каждый инструмент — видно, чем харнесс занят сейчас.
	pi.on("tool_execution_start", async (event, ctx) => {
		const vibe = toolVibe(event.toolName) ?? generalVibe();
		if (vibe) ctx.ui.setWorkingMessage(vibe);
	});

	pi.on("agent_end", async (_event, ctx) => {
		ctx.ui.setWorkingMessage();
	});

	pi.registerCommand("vibes", {
		description: `Набор вайбов в строке загрузки. Usage: /vibes [${options}]`,
		getArgumentCompletions: (prefix: string) => {
			const items = [ALL, ...names, OFF]
				.filter((name) => name.startsWith(prefix.toLowerCase()))
				.map((name) => ({
					value: name,
					label: name,
					description:
						name === ALL
							? "все наборы"
							: name === OFF
								? "выключить"
								: `${sets.get(name)?.general.length ?? 0} строк + ${sets.get(name)?.byTool.size ?? 0} тегов`,
				}));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const arg = args?.trim().toLowerCase();
			if (!arg) {
				ctx.ui.notify(`Vibes: ${activeSet}. Доступно: ${options}`, "info");
				return;
			}
			if (arg !== ALL && arg !== OFF && !sets.has(arg)) {
				ctx.ui.notify(`Неизвестный набор "${arg}". Доступно: ${options}`, "error");
				return;
			}

			activeSet = arg;
			writeState(activeSet);
			applyIndicator(ctx);
			if (activeSet === OFF) ctx.ui.setWorkingMessage();
			ctx.ui.notify(`Vibes: ${activeSet}`, "info");
		},
	});
}

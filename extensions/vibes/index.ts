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
 * У набора могут быть свои кадры спиннера; в режиме all анимация идёт за
 * показанной строкой — какому набору строка, того и кадры.
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

/** Строка вместе с набором, из которого она пришла — по нему выбирается спиннер. */
type Vibe = {
	text: string;
	set: string;
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
	mechanicus: { frames: ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"], intervalMs: 90 },
	eldritch: { frames: ["·", "∘", "○", "◉", "○", "∘"], intervalMs: 170 },
	noir: { frames: ["▖", "▘", "▝", "▗"], intervalMs: 190 },
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

function pick<T>(items: T[]): T | undefined {
	if (items.length === 0) return undefined;
	return items[Math.floor(Math.random() * items.length)];
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

	// В режиме all анимация идёт за текстом: показали строку из fallout —
	// крутится счётчик Гейгера. До первой строки показывать нечего, поэтому
	// стартовый набор выбирается случайно один раз за запуск.
	const sessionAllSet = pick(names.filter((name) => INDICATORS[name] !== undefined));

	const cycle = [ALL, ...names, OFF];
	pi.registerFlag("vibes", {
		description: `Набор вайбов на старте: ${cycle.join(" | ")}`,
		type: "string",
	});

	function isKnown(name: string): boolean {
		return name === ALL || name === OFF || sets.has(name);
	}

	function activeSets(): Array<[string, VibeSet]> {
		if (activeSet === OFF) return [];
		if (activeSet === ALL) return [...sets.entries()];
		const one = sets.get(activeSet);
		return one ? [[activeSet, one]] : [];
	}

	function generalVibe(): Vibe | undefined {
		return pick(activeSets().flatMap(([set, s]) => s.general.map((text) => ({ text, set }))));
	}

	function toolVibe(toolName: string): Vibe | undefined {
		const active = activeSets();
		if (active.length === 0) return undefined;

		const name = toolName.toLowerCase();
		const tags = [name];
		for (const [pattern, tag] of TOOL_PREFIX_TAGS) {
			if (pattern.test(name)) tags.push(tag);
		}

		for (const tag of tags) {
			const lines = active.flatMap(([set, s]) => (s.byTool.get(tag) ?? []).map((text) => ({ text, set })));
			const hit = pick(lines);
			if (hit) return hit;
		}
		return undefined;
	}

	// Какой набор сейчас на спиннере — чтобы не дёргать UI одними и теми же кадрами.
	let indicatorSet: string | undefined;

	function applyIndicator(ctx: ExtensionContext, source: string | undefined): void {
		if (!ctx.hasUI) return;
		if (indicatorSet === source) return;
		indicatorSet = source;
		// off и наборы без своих кадров отдают undefined — это штатный способ
		// вернуть дефолтный спиннер pi.
		ctx.ui.setWorkingIndicator(source ? INDICATORS[source] : undefined);
	}

	/** Спиннер выбранного вручную набора; в all — стартовый, до первой строки. */
	function resetIndicator(ctx: ExtensionContext): void {
		if (activeSet === OFF) applyIndicator(ctx, undefined);
		else applyIndicator(ctx, activeSet === ALL ? sessionAllSet : activeSet);
	}

	/** Строка и её анимация ставятся вместе — иначе в all они разъезжаются. */
	function showVibe(ctx: ExtensionContext, vibe: Vibe | undefined): void {
		if (!vibe) return;
		ctx.ui.setWorkingMessage(vibe.text);
		applyIndicator(ctx, vibe.set);
	}

	pi.on("session_start", async (_event, ctx) => {
		const fromFlag = pi.getFlag("vibes");
		if (typeof fromFlag === "string" && isKnown(fromFlag.toLowerCase())) {
			activeSet = fromFlag.toLowerCase(); // флаг важнее сохранённого выбора, но его не перезаписывает
		}
		resetIndicator(ctx);
	});

	pi.registerShortcut("ctrl+alt+v", {
		description: "Переключить набор вайбов",
		handler: async (ctx) => {
			activeSet = cycle[(cycle.indexOf(activeSet) + 1) % cycle.length] ?? ALL;
			writeState(activeSet);
			resetIndicator(ctx);
			if (activeSet === OFF) ctx.ui.setWorkingMessage();
			ctx.ui.notify(`Vibes: ${activeSet}`, "info");
		},
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		showVibe(ctx, generalVibe());
	});

	// Сообщение меняется на каждый инструмент — видно, чем харнесс занят сейчас.
	pi.on("tool_execution_start", async (event, ctx) => {
		showVibe(ctx, toolVibe(event.toolName) ?? generalVibe());
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
			resetIndicator(ctx);
			if (activeSet === OFF) ctx.ui.setWorkingMessage();
			ctx.ui.notify(`Vibes: ${activeSet}`, "info");
		},
	});
}

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
 *   /vibes                — показать текущий выбор
 *   /vibes <набор> [..]   — переключиться (all | off | имена наборов, несколько
 *                           — через пробел или запятую)
 *   /vibes +<набор>       — добавить в текущий выбор
 *   /vibes -<набор>       — убрать из текущего выбора
 *
 * Флаг --vibes принимает то же самое: --vibes fallout,noir.
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

/** Ключ спиннера на время диалога: с именем набора не столкнётся. */
const WAIT_KEY = "\u0000wait";
/** Пустой список кадров прячет индикатор — pi ничего не делает, нечего крутить. */
const FROZEN: WorkingIndicatorOptions = { frames: [] };

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

/** Сохранённый выбор: [] — off, ["all"] — все, иначе список имён наборов. */
function readState(): string[] | undefined {
	try {
		const parsed = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as {
			activeSet?: unknown; // старый формат — всё ещё читаем
			activeSets?: unknown;
		};
		const raw = Array.isArray(parsed.activeSets)
			? parsed.activeSets
			: typeof parsed.activeSet === "string"
				? [parsed.activeSet]
				: undefined;
		return Array.isArray(raw) ? raw.filter((n): n is string => typeof n === "string") : undefined;
	} catch {
		return undefined;
	}
}

function writeState(active: string[]): void {
	try {
		// off пишем как ["off"]: пустой список при чтении — «файла не было»
		writeFileSync(STATE_FILE, `${JSON.stringify({ activeSets: active.length > 0 ? active : [OFF] }, null, 2)}\n`);
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

	// Выбор — список имён наборов: ["all"] — все, [] — off. Неизвестные имена из
	// сохранённого состояния отбрасываем; пустой остаток значит «файла не было».
	const saved = (readState() ?? []).filter((name) => name === ALL || name === OFF || sets.has(name));
	let active: string[] = saved.length > 0 ? (saved.includes(OFF) ? [] : saved) : [ALL];

	// В режиме all анимация идёт за текстом: показали строку из fallout —
	// крутится счётчик Гейгера. До первой строки показывать нечего, поэтому
	// стартовый набор выбирается случайно один раз за запуск.
	const sessionAllSet = pick(names.filter((name) => INDICATORS[name] !== undefined));

	/** Открыт диалог pi — сообщение и спиннер заморожены до ui_prompt_end. */
	let waiting = false;

	const cycle = [ALL, ...names, OFF];
	pi.registerFlag("vibes", {
		description: `Наборы вайбов на старте: ${cycle.join(" | ")}, несколько — через пробел или запятую`,
		type: "string",
	});

	function isKnown(name: string): boolean {
		return name === ALL || name === OFF || sets.has(name);
	}

	/** "all" | "off" | "fallout + noir" — для уведомлений и выводов. */
	function label(): string {
		if (active.length === 0) return OFF;
		if (active.includes(ALL)) return ALL;
		return active.join(" + ");
	}

	/** Аргумент флага/команды -> выбор: через пробел или запятую. */
	function parseList(raw: string): string[] | undefined {
		const parts = raw.toLowerCase().split(/[\s,]+/).filter((p) => p.length > 0);
		if (parts.length === 0) return undefined;
		if (parts.some((p) => !isKnown(p))) return undefined;
		if (parts.includes(OFF)) return [];
		if (parts.includes(ALL)) return [ALL];
		return parts;
	}

	function activeSets(): Array<[string, VibeSet]> {
		if (active.length === 0) return [];
		const pool = active.includes(ALL) ? names : active;
		const out: Array<[string, VibeSet]> = [];
		for (const name of pool) {
			const set = sets.get(name);
			if (set) out.push([name, set]);
		}
		return out;
	}

	function generalVibe(): Vibe | undefined {
		return pick(activeSets().flatMap(([set, s]) => s.general.map((text) => ({ text, set }))));
	}

	function toolVibe(toolName: string): Vibe | undefined {
		const pool = activeSets();
		if (pool.length === 0) return undefined;

		const name = toolName.toLowerCase();
		const tags = [name];
		for (const [pattern, tag] of TOOL_PREFIX_TAGS) {
			if (pattern.test(name)) tags.push(tag);
		}

		for (const tag of tags) {
			const lines = pool.flatMap(([set, s]) => (s.byTool.get(tag) ?? []).map((text) => ({ text, set })));
			const hit = pick(lines);
			if (hit) return hit;
		}
		return undefined;
	}

	// Что сейчас на спиннере — чтобы не дёргать UI одними и теми же кадрами.
	// Ключ: имя набора, WAIT_KEY на время диалога или undefined для дефолта.
	let indicatorKey: string | undefined;

	function setIndicator(
		ctx: ExtensionContext,
		key: string | undefined,
		frames: WorkingIndicatorOptions | undefined,
	): void {
		if (!ctx.hasUI) return;
		if (indicatorKey === key) return;
		indicatorKey = key;
		ctx.ui.setWorkingIndicator(frames);
	}

	function applyIndicator(ctx: ExtensionContext, source: string | undefined): void {
		// off и наборы без своих кадров отдают undefined — это штатный способ
		// вернуть дефолтный спиннер pi.
		setIndicator(ctx, source, source ? INDICATORS[source] : undefined);
	}

	/** Случайный набор со своими кадрами в пуле; стабилен на выбор, чтобы кадры
	 * не менялись при каждом сбросе. */
	const indicatorPoolPick = new Map<string, string | undefined>();
	function stableIndicatorPick(pool: string[]): string | undefined {
		const key = pool.join(",");
		if (!indicatorPoolPick.has(key)) {
			indicatorPoolPick.set(key, pick(pool.filter((name) => INDICATORS[name] !== undefined)));
		}
		return indicatorPoolPick.get(key);
	}

	/** Спиннер выбранного набора; в all — стартовый, до первой строки. */
	function resetIndicator(ctx: ExtensionContext): void {
		if (active.length === 0) applyIndicator(ctx, undefined);
		else if (active.includes(ALL)) applyIndicator(ctx, sessionAllSet);
		else applyIndicator(ctx, stableIndicatorPick(active));
	}

	/** Последняя показанная строка — её возвращаем после диалога. */
	let lastVibe: Vibe | undefined;

	/** Строка и её анимация ставятся вместе — иначе в all они разъезжаются. */
	function showVibe(ctx: ExtensionContext, vibe: Vibe | undefined): void {
		if (!vibe) return;
		lastVibe = vibe;
		if (waiting) return; // диалог важнее, строку вернём на ui_prompt_end
		ctx.ui.setWorkingMessage(vibe.text);
		applyIndicator(ctx, vibe.set);
	}

	pi.on("session_start", async (_event, ctx) => {
		const fromFlag = pi.getFlag("vibes");
		if (typeof fromFlag === "string") {
			const fromParsed = parseList(fromFlag);
			if (fromParsed) active = fromParsed; // флаг важнее сохранённого выбора, но его не перезаписывает
		}
		resetIndicator(ctx);
	});

	pi.registerShortcut("ctrl+alt+v", {
		description: "Переключить набор вайбов",
		handler: async (ctx) => {
			// Цикл работает как раньше: каждый нажатие заменяет выбор одним шагом;
			// из многонaborного выбора цикл начинается заново с all.
			const single = active.length === 1 ? active[0] : undefined;
			const idx =
				active.length === 0
					? cycle.indexOf(OFF)
					: single && (single === ALL || sets.has(single))
						? cycle.indexOf(single)
						: -1;
			const next = cycle[(idx + 1) % cycle.length] ?? ALL;
			active = next === OFF ? [] : [next];
			writeState(active);
			resetIndicator(ctx);
			if (active.length === 0) ctx.ui.setWorkingMessage();
			ctx.ui.notify(`Vibes: ${label()}`, "info");
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
		lastVibe = undefined;
		if (waiting) return;
		ctx.ui.setWorkingMessage();
	});

	// Пока открыт диалог (ctx.ui.select и родня — например подтверждение
	// guardrails), pi не работает, а ждёт человека. Крутить в это время спиннер
	// и писать «взламываю Пентагон» — враньё: показываем строку с тегом ask и
	// гасим анимацию. Вложенные диалоги pi схлопывает в один интервал, но флаг
	// всё равно проверяем: обработчики зовутся best-effort и не ожидаются.
	pi.on("ui_prompt_start", async (_event, ctx) => {
		if (!ctx.hasUI || waiting) return;
		waiting = true;
		ctx.ui.setWorkingMessage(toolVibe("ask")?.text ?? "Жду ответа...");
		setIndicator(ctx, WAIT_KEY, FROZEN);
	});

	pi.on("ui_prompt_end", async (_event, ctx) => {
		if (!ctx.hasUI || !waiting) return;
		waiting = false;
		if (lastVibe) {
			ctx.ui.setWorkingMessage(lastVibe.text);
			applyIndicator(ctx, lastVibe.set);
		} else {
			ctx.ui.setWorkingMessage();
			resetIndicator(ctx);
		}
	});

	function applyAndNotify(ctx: ExtensionContext): void {
		writeState(active);
		resetIndicator(ctx);
		if (active.length === 0) ctx.ui.setWorkingMessage();
		ctx.ui.notify(`Vibes: ${label()}`, "info");
	}

	pi.registerCommand("vibes", {
		description: `Наборы вайбов в строке загрузки. Usage: /vibes [${options}], +<набор> — добавить, -<набор> — убрать`,
		getArgumentCompletions: (prefix: string) => {
			const raw = prefix.toLowerCase();
			const sign = raw.startsWith("+") || raw.startsWith("-") ? raw[0]! : "";
			const stem = raw.slice(sign.length);
			const items = [ALL, ...names, OFF]
				.filter((name) => name.startsWith(stem))
				.map((name) => ({
					value: sign + name,
					label: sign + name,
					description:
						sign === "+"
							? "добавить в текущий выбор"
							: sign === "-"
								? "убрать из текущего выбора"
								: name === ALL
									? "все наборы"
									: name === OFF
										? "выключить"
										: `${sets.get(name)?.general.length ?? 0} строк + ${sets.get(name)?.byTool.size ?? 0} тегов`,
				}));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();
			if (!raw) {
				ctx.ui.notify(`Vibes: ${label()}. Доступно: ${options}`, "info");
				return;
			}
			const parts = raw.toLowerCase().split(/[\s,]+/).filter((p) => p.length > 0);

			// +x / -x — править текущий выбор, а не заменять его
			if (parts.every((p) => p[0] === "+" || p[0] === "-")) {
				let next: Set<string> = active.includes(ALL) ? new Set(names) : new Set(active);
				for (const p of parts) {
					const name = p.slice(1);
					if (!isKnown(name)) {
						ctx.ui.notify(`Неизвестный набор "${name}". Доступно: ${options}`, "error");
						return;
					}
					if (p[0] === "+") {
						if (name === ALL) next = new Set(names);
						else if (name !== OFF) next.add(name);
					} else if (name === ALL || name === OFF) next = new Set();
					else next.delete(name);
				}
				// Полный выбор сворачиваем в all — иначе новые наборы будут мимо
				active = next.size === names.length ? [ALL] : [...next];
				applyAndNotify(ctx);
				return;
			}

			const parsed = parseList(raw);
			if (!parsed) {
				ctx.ui.notify(`Неизвестный набор в "${raw}". Доступно: ${options}`, "error");
				return;
			}
			active = parsed;
			applyAndNotify(ctx);
		},
	});
}

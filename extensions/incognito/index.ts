/**
 * Incognito — разговор, который не оставляет следов: ни в памяти graphiti, ни
 * на диске.
 *
 * Режим живёт на весь процесс, как приватное окно браузера: `--incognito`,
 * `PI_INCOGNITO=1` или `/incognito on`. /new и /fork остаются инкогнито;
 * переменная окружения наследуется дочерними pi (субагентами), и они тоже
 * работают инкогнито.
 *
 * Память:
 *   - запись в graphiti (всё, кроме search_* / get_*), memory-digest и
 *     memory-import из bash, правки в <agent dir>/memory → диалог
 *     подтверждения, без UI — блок. «Явное указание» пользователя — это его
 *     ответ в этом диалоге;
 *   - в системный промпт уходит секция <incognito>, чтобы модель и не пыталась.
 *
 * Диск: на session_shutdown (quit, /new, /resume, /fork; но не reload — сессия
 * та же) удаляются .jsonl, каталог дочерних сессий субагентов `<ts>_<id>/` и
 * архив obspack `obspack/<id>/`. Сессия помечена custom-записью `incognito`,
 * по ней ночной memory-digest её пропускает. Если pi упал, сессию находит
 * реестр `<agent dir>/incognito/<id>.json` ({file, pid}): на следующем старте
 * всё, чей pid мёртв, дочищается.
 *
 * Открыть обычную сессию (/resume, --continue) в инкогнито нельзя без потери
 * истории, поэтому режим в этом случае выключается с предупреждением.
 *
 * /incognito [on|off|status].
 */

import { mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENTRY = "incognito";
const ENV = "PI_INCOGNITO";
const MEMORY_PREFIX = "mcp__memory__";
/** Инструменты graphiti, которые ничего не пишут. Всё остальное — запись. */
const MEMORY_READ_ONLY = new Set([
	"search_nodes",
	"search_memory_facts",
	"get_episodes",
	"get_entity_edge",
	"get_episode_entities",
	"get_status",
]);
const MEMORY_SCRIPTS = /\bmemory-(digest|import)\b/;
/** Имя транскрипта верхнего уровня: `<ISO-дата>Z_<uuid>.jsonl`. */
const TRANSCRIPT_RE = /^\d{4}-\d{2}-\d{2}T[\d.-]+Z_([0-9a-f-]+)\.jsonl$/i;

const PROMPT_SECTION = [
	"Режим инкогнито: этот разговор не должен попасть в долговременную память и будет удалён с диска по завершении.",
	"Не вызывай add_memory, add_triplet и другие записи в graphiti, не запускай memory-digest / memory-import и не",
	"сохраняй выдержки из разговора куда-либо ещё — даже если CONTEXT.md или скилл велят сохранять факты.",
	"Исключение: пользователь прямо просит сохранить что-то конкретное. Тогда вызов всё равно пройдёт через его",
	"подтверждение. Читать память (search_nodes, search_memory_facts) можно.",
].join(" ");

/**
 * Состояние процесса. Рантайм расширений пересоздаётся при /new, /resume,
 * /fork и reload, а режим должен эти переходы пережить — поэтому globalThis.
 */
type ProcessState = { on: boolean; initialized: boolean; exitHook: boolean };
const STATE_KEY = Symbol.for("pi-pack.incognito");

function processState(): ProcessState {
	const g = globalThis as Record<symbol, ProcessState | undefined>;
	g[STATE_KEY] ??= { on: false, initialized: false, exitHook: false };
	return g[STATE_KEY];
}

type Registration = { file: string; pid: number };

function registryDir(): string {
	return join(getAgentDir(), "incognito");
}

function registryPath(sessionId: string): string {
	if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(sessionId)) throw new Error(`unsafe session id: ${sessionId}`);
	return join(registryDir(), `${sessionId}.json`);
}

function register(sessionId: string, file: string): void {
	mkdirSync(registryDir(), { recursive: true, mode: 0o700 });
	writeFileSync(registryPath(sessionId), JSON.stringify({ file, pid: process.pid } satisfies Registration));
}

function unregister(sessionId: string): void {
	rmSync(registryPath(sessionId), { force: true });
}

/**
 * Транскрипт верхнего уровня. Сессии субагентов (`<parent>/<agent>/run-0/session.jsonl`)
 * не подходят: их удаляет родитель вместе со своим каталогом.
 */
function isTranscript(file: string | undefined): file is string {
	return file !== undefined && isAbsolute(file) && TRANSCRIPT_RE.test(basename(file));
}

/** Транскрипт и всё, что pi-pack и pi-subagents складывают рядом под его id. */
function wipe(file: string): void {
	const match = TRANSCRIPT_RE.exec(basename(file));
	if (!isAbsolute(file) || !match) throw new Error(`refusing to wipe unexpected path: ${file}`);
	const dir = dirname(file);
	rmSync(file, { force: true });
	rmSync(file.slice(0, -".jsonl".length), { recursive: true, force: true });
	rmSync(join(dir, "obspack", match[1]), { recursive: true, force: true });
	try {
		rmdirSync(join(dir, "obspack")); // только пустой: в нём архивы других сессий
	} catch {
		// не пуст или его не было
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM — процесс есть, но чужой; живой.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Дочистка за процессами, ушедшими мимо session_shutdown. Текущую сессию не трогаем. */
function sweep(currentFile: string | undefined): void {
	let names: string[];
	try {
		names = readdirSync(registryDir());
	} catch {
		return;
	}
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const path = join(registryDir(), name);
		try {
			const reg = JSON.parse(readFileSync(path, "utf8")) as Registration;
			if (reg.file === currentFile) continue;
			if (reg.pid !== process.pid && alive(reg.pid)) continue;
			if (isTranscript(reg.file)) wipe(reg.file);
			rmSync(path, { force: true });
		} catch (error) {
			console.error(`[incognito] sweep ${name}: ${errorText(error)}`);
		}
	}
}

/** Последняя отметка инкогнито в файле сессии: true / false / undefined (не было). */
function markedIncognito(ctx: ExtensionContext): boolean | undefined {
	let mark: boolean | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "custom" && entry.customType === ENTRY) {
			mark = (entry.data as { on?: boolean } | undefined)?.on === true;
		}
	}
	return mark;
}

function hasConversation(ctx: ExtensionContext): boolean {
	return ctx.sessionManager.getEntries().some((entry) => entry.type === "message");
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI) {
	const state = processState();
	/**
	 * Id и файл текущей сессии — снимок на session_start, контекст к shutdown может
	 * протухнуть. file есть только у транскрипта верхнего уровня, который удаляем мы.
	 */
	let current: { id: string; file: string | undefined } | undefined;

	pi.registerFlag("incognito", {
		description: "Режим инкогнито: без записи в память, сессия удаляется по завершении",
		type: "boolean",
	});

	function showStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(ENTRY, state.on ? ctx.ui.theme.fg("warning", "\u{f21b} incognito") : undefined);
	}

	function setEnv(): void {
		if (state.on) process.env[ENV] = "1";
		else delete process.env[ENV];
	}

	/** Пометить текущую сессию и взять её на учёт для удаления. */
	function adopt(ctx: ExtensionContext): void {
		if (markedIncognito(ctx) !== true) pi.appendEntry(ENTRY, { on: true });
		if (current?.file) register(current.id, current.file);
	}

	function release(ctx: ExtensionContext): void {
		if (markedIncognito(ctx) === true) pi.appendEntry(ENTRY, { on: false });
		if (current) unregister(current.id);
	}

	pi.on("session_start", async (event, ctx) => {
		const sm = ctx.sessionManager;
		// У --no-session файла нет, удалять нечего.
		const file = sm.getSessionFile();
		current = { id: sm.getSessionId(), file: isTranscript(file) ? file : undefined };

		if (!state.initialized) {
			// Флаги разобраны только к старту сессии, в фабрике их ещё нет.
			state.initialized = true;
			state.on = pi.getFlag("incognito") === true || process.env[ENV] === "1";
		}

		try {
			sweep(current.file);
		} catch (error) {
			console.error(`[incognito] sweep failed: ${errorText(error)}`);
		}

		if (markedIncognito(ctx) === true) {
			// Отмеченная сессия — продолжение или остаток после падения: режим включается.
			state.on = true;
		} else if (state.on && (event.reason === "startup" || event.reason === "resume") && hasConversation(ctx)) {
			// Обычная сессия с историей (--continue, /resume). Пометить её — значит
			// удалить по выходу всю историю; молча писать дальше — нарушить инкогнито.
			// /new и /fork сюда не попадают: форк инкогнито-сессии остаётся инкогнито,
			// даже если отметка стоит позже точки форка.
			state.on = false;
			if (ctx.hasUI) {
				ctx.ui.notify("Инкогнито выключено: открыта обычная сессия, продолжение сохранится на диск", "warning");
			}
		}

		if (state.on) adopt(ctx);
		setEnv();
		showStatus(ctx);

		if (!state.exitHook) {
			// Страховка на выход мимо session_shutdown. Только синхронный код.
			state.exitHook = true;
			process.once("exit", () => {
				try {
					sweep(undefined);
				} catch {
					// процесс и так уходит
				}
			});
		}
	});

	pi.on("session_shutdown", async (event) => {
		if (event.reason === "reload" || !state.on || !current?.file) return;
		try {
			wipe(current.file);
			unregister(current.id);
		} catch (error) {
			console.error(`[incognito] wipe failed: ${errorText(error)}`);
		}
		current = undefined;
	});

	pi.on("before_agent_start", async (event) => {
		const sections = event.systemPromptOptions.sections;
		if (state.on) sections.incognito = PROMPT_SECTION;
		else delete sections.incognito;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!state.on) return undefined;

		let what: string | undefined;
		const input = event.input as Record<string, unknown>;
		if (event.toolName.startsWith(MEMORY_PREFIX)) {
			const tool = event.toolName.slice(MEMORY_PREFIX.length);
			if (!MEMORY_READ_ONLY.has(tool)) what = `запись в память: ${tool}`;
		} else if (event.toolName === "bash" && typeof input.command === "string") {
			const m = MEMORY_SCRIPTS.exec(input.command);
			if (m) what = `запуск ${m[0]}`;
		} else if ((event.toolName === "write" || event.toolName === "edit") && typeof input.path === "string") {
			if (resolve(ctx.cwd, input.path).startsWith(join(getAgentDir(), "memory"))) what = `правка ${input.path}`;
		}
		if (!what) return undefined;

		if (!ctx.hasUI) {
			return { block: true, reason: `Инкогнито: ${what} без подтверждения пользователя запрещена` };
		}
		const ok = await ctx.ui.confirm(
			"Инкогнито",
			`Модель хочет: ${what}.\nРазрешай, только если сам просил это сохранить.`,
		);
		return ok ? undefined : { block: true, reason: `Инкогнито: ${what} — отклонено пользователем` };
	});

	pi.registerCommand("incognito", {
		description: "Режим инкогнито: on | off | status",
		getArgumentCompletions: (prefix: string) => {
			const items = ["status", "on", "off"]
				.filter((v) => v.startsWith(prefix.toLowerCase()))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const arg = args?.trim().toLowerCase() || "status";
			if (arg !== "on" && arg !== "off" && arg !== "status") {
				ctx.ui.notify("Usage: /incognito [on|off|status]", "error");
				return;
			}
			if (arg === "on" && !state.on) {
				if (current?.file && hasConversation(ctx)) {
					const ok = await ctx.ui.confirm(
						"Инкогнито",
						"В сессии уже есть сообщения. При выходе будет удалена вся сессия, включая их. Продолжить?",
					);
					if (!ok) return;
				}
				state.on = true;
				adopt(ctx);
			} else if (arg === "off" && state.on) {
				state.on = false;
				release(ctx);
			}
			setEnv();
			showStatus(ctx);
			const disk = !current?.file
				? "сессия и так не пишется на диск"
				: state.on
					? "сессия удалится при выходе"
					: "сессия сохранится";
			ctx.ui.notify(`Инкогнито: ${state.on ? "on" : "off"} — ${disk}`, "info");
		},
	});
}

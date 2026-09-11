/**
 * Obspack — большие результаты инструментов не гоняются в каждом запросе.
 *
 * Идея взята из ObservationPack (NVlabs/SoL-Pi, MIT): большой текстовый
 * tool result уходит модели целиком только в первые FULL_SENDS запроса —
 * пока модель на него реагирует. Дальше в контекст подставляется короткая
 * заглушка: id, размер, первые и последние строки. Оригинал лежит на диске
 * рядом с сессией, модель достаёт нужный кусок инструментом obs_recall —
 * по номеру строки или регуляркой.
 *
 * Сессия не трогается: подмена только в проекции (`pi.on("context")`),
 * поэтому история остаётся полной, а recall работает после resume и
 * нативной компакции. Счётчик «сколько раз уже отправляли» выводится из
 * самой истории (число assistant-сообщений после результата), без
 * состояния в памяти — одинаковый запрос всегда проецируется одинаково,
 * что дружит с prompt cache.
 *
 * Чем отличается от оригинала: постраничный доступ по строкам вместо
 * байтовых смещений, поиск регуляркой по архиву, без JSONL-леджера,
 * автоочистка архивов сессий, чьи .jsonl уже удалены, tmpdir-фолбэк для
 * непостоянных сессий.
 *
 * Любая ошибка = fail-open: результат уходит модели как есть.
 *
 * /obspack [on|off|status] — выключить на время отладки, посмотреть счёт.
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

/** Результаты меньше этого не трогаем. */
const THRESHOLD_BYTES = 10 * 1024;
/** Сколько запросов подряд результат уходит целиком, прежде чем стать заглушкой. */
const FULL_SENDS = 2;
/** Бюджет выдержки в заглушке: голова + хвост, только целые строки. */
const EXCERPT_HEAD_BYTES = 640;
const EXCERPT_TAIL_BYTES = 384;

/** Лимиты одного ответа obs_recall. */
const RECALL_DEFAULT_LINES = 200;
const RECALL_MAX_LINES = 400;
const RECALL_MAX_BYTES = 16 * 1024;
const GREP_MAX_MATCHES = 100;

/** Строки длиннее этого режем в выдаче — минифицированный JSON не должен съесть весь лимит. */
const MAX_LINE_CHARS = 2000;
const CHARS_PER_TOKEN = 4;
const ID_PATTERN = /^obs_[a-f0-9]{16}$/u;
const TOOL_NAME = "obs_recall";
const STATUS_KEY = "obspack";
const STATUS_MS = 4_000;

type Observation = {
	id: string;
	toolName: string;
	text: string;
	bytes: number;
	lines: number;
	tokens: number;
};

type Stats = {
	archived: number;
	/** Уникальные результаты, которые хоть раз ушли заглушкой. */
	replaced: Set<string>;
	/** Сумма по всем запросам: столько токенов не поехало в провайдера. */
	tokensSaved: number;
	recalls: number;
};

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function countLines(text: string): number {
	if (text.length === 0) return 0;
	let n = text.endsWith("\n") ? 0 : 1;
	for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) n += 1;
	return n;
}

function clip(line: string): string {
	return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…[+${line.length - MAX_LINE_CHARS} chars]` : line;
}

function formatTokens(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/u, "")}k` : String(n);
}

/** Только успешные, чисто текстовые результаты, и не от самого obs_recall. */
function isPackable(message: AgentMessage): message is ToolResultMessage {
	return (
		message.role === "toolResult" &&
		!message.isError &&
		message.toolName !== TOOL_NAME &&
		message.content.length > 0 &&
		message.content.every((block) => block.type === "text")
	);
}

function textOf(message: ToolResultMessage): string {
	return (message.content as TextContent[]).map((block) => block.text).join("\n");
}

function toObservation(message: ToolResultMessage): Observation | undefined {
	const text = textOf(message);
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= THRESHOLD_BYTES) return undefined;
	const id = `obs_${sha256(`${message.toolName}\0${message.toolCallId}\0${sha256(text)}`).slice(0, 16)}`;
	return { id, toolName: message.toolName, text, bytes, lines: countLines(text), tokens: estimateTokens(text) };
}

/** Целые строки с начала или с конца, пока влезают в бюджет. */
function excerpt(text: string, budget: number, fromEnd: boolean): string {
	const lines = text.split(/(?<=\n)/u);
	const picked: string[] = [];
	let used = 0;
	for (let i = fromEnd ? lines.length - 1 : 0; i >= 0 && i < lines.length; i += fromEnd ? -1 : 1) {
		const line = lines[i] ?? "";
		const size = Buffer.byteLength(line, "utf8");
		if (used + size > budget) break;
		if (fromEnd) picked.unshift(line);
		else picked.push(line);
		used += size;
	}
	return picked.join("").replace(/\n$/u, "");
}

function placeholderFor(o: Observation): string {
	const head = excerpt(o.text, EXCERPT_HEAD_BYTES, false);
	const tail = excerpt(o.text, EXCERPT_TAIL_BYTES, true);
	return [
		`[obspack] large ${o.toolName} result archived: id=${o.id} ${o.bytes} bytes, ${o.lines} lines, ~${formatTokens(o.tokens)} tokens.`,
		`Full text is on disk. Recall with ${TOOL_NAME}: {"id":"${o.id}","line":1} pages ${RECALL_DEFAULT_LINES} lines from a 1-based line; {"id":"${o.id}","grep":"<regex>"} lists matching lines with numbers.`,
		`--- first lines ---`,
		head,
		`--- ... ${o.lines} lines total, middle omitted ... ---`,
		tail,
		`--- end ---`,
	].join("\n");
}

/** Каталог архива: рядом с сессией, для непостоянной — в tmp. */
function archiveRoot(ctx: ExtensionContext): string {
	const sm = ctx.sessionManager;
	const id = sm.getSessionId();
	if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(id)) throw new Error(`unsafe session id: ${id}`);
	const dir = sm.getSessionFile() ? sm.getSessionDir() : join(tmpdir(), "pi-obspack");
	return join(dir, "obspack", id);
}

function objectPath(root: string, id: string): string {
	return join(root, `${id}.txt`);
}

/**
 * Архивы сессий, чьих .jsonl больше нет (имя файла сессии — `<ts>_<id>.jsonl`).
 * Своё и только своё, поэтому без подтверждения.
 */
async function pruneOrphans(ctx: ExtensionContext): Promise<void> {
	const sm = ctx.sessionManager;
	if (!sm.getSessionFile()) return;
	const sessionDir = sm.getSessionDir();
	const root = join(sessionDir, "obspack");
	let archived: string[];
	try {
		archived = await readdir(root);
	} catch {
		return;
	}
	if (archived.length === 0) return;
	const alive = new Set(
		(await readdir(sessionDir))
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => f.slice(f.lastIndexOf("_") + 1, -".jsonl".length)),
	);
	await Promise.all(
		archived
			.filter((id) => !alive.has(id))
			.map((id) => rm(join(root, id), { recursive: true, force: true })),
	);
}

type Page = { text: string; from: number; to: number; total: number; truncated: boolean };

/** Строки [from, from+count) с 1-базовым from, с ограничением по байтам. */
function pageLines(lines: string[], from: number, count: number): Page {
	const start = Math.max(1, from);
	const picked: string[] = [];
	let bytes = 0;
	let truncated = false;
	for (let i = start - 1; i < lines.length && picked.length < count; i += 1) {
		const line = clip(lines[i] ?? "");
		const size = Buffer.byteLength(line, "utf8") + 1;
		if (bytes + size > RECALL_MAX_BYTES) {
			truncated = true;
			break;
		}
		picked.push(line);
		bytes += size;
	}
	return { text: picked.join("\n"), from: start, to: start + picked.length - 1, total: lines.length, truncated };
}

function grepLines(lines: string[], pattern: string): { text: string; matches: number; capped: boolean } {
	const re = new RegExp(pattern, "iu");
	const out: string[] = [];
	let matches = 0;
	let bytes = 0;
	let capped = false;
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		if (!re.test(line)) continue;
		matches += 1;
		const row = `${i + 1}: ${clip(line)}`;
		const size = Buffer.byteLength(row, "utf8") + 1;
		if (out.length >= GREP_MAX_MATCHES || bytes + size > RECALL_MAX_BYTES) {
			capped = true;
			continue;
		}
		out.push(row);
		bytes += size;
	}
	return { text: out.join("\n"), matches, capped };
}

export default function obspack(pi: ExtensionAPI): void {
	let enabled = true;
	const stats: Stats = { archived: 0, replaced: new Set(), tokensSaved: 0, recalls: 0 };
	/** Что уже лежит на диске в этой сессии — чтобы не перепроверять каждый запрос. */
	const stored = new Set<string>();
	let statusTimer: ReturnType<typeof setTimeout> | undefined;

	function flash(ctx: ExtensionContext, text: string): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", text));
		if (statusTimer) clearTimeout(statusTimer);
		statusTimer = setTimeout(() => ctx.ui.setStatus(STATUS_KEY, undefined), STATUS_MS);
		statusTimer.unref?.();
	}

	async function ensureStored(root: string, o: Observation): Promise<void> {
		if (stored.has(o.id)) return;
		const path = objectPath(root, o.id);
		try {
			const s = await stat(path);
			if (s.isFile() && s.size === o.bytes) {
				stored.add(o.id);
				return;
			}
		} catch {
			// нет файла — пишем
		}
		await mkdir(root, { recursive: true, mode: 0o700 });
		await writeFile(path, o.text, { encoding: "utf8", mode: 0o600 });
		stored.add(o.id);
		stats.archived += 1;
	}

	pi.on("session_start", (_event, ctx) => {
		stored.clear();
		pruneOrphans(ctx).catch((error: unknown) => {
			console.error(`[obspack] prune failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	});

	pi.on("context", async (event, ctx) => {
		if (!enabled) return undefined;
		let root: string;
		try {
			root = archiveRoot(ctx);
		} catch (error) {
			console.error(`[obspack] disabled for this session: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}

		const messages = event.messages;
		// Сколько assistant-сообщений идёт после каждого элемента = сколько раз
		// он уже побывал в запросе. Считается с хвоста за один проход. Пустые
		// assistant-заглушки (stopReason: error при обрыве соединения, ретрай
		// pi) не считаем — модель тот запрос не читала.
		const sendsAfter = new Array<number>(messages.length);
		let assistants = 0;
		for (let i = messages.length - 1; i >= 0; i -= 1) {
			sendsAfter[i] = assistants;
			const m = messages[i];
			if (m?.role === "assistant" && m.content.length > 0) assistants += 1;
		}

		let changed = false;
		const projected = [...messages];
		for (let i = 0; i < messages.length; i += 1) {
			const message = messages[i];
			if (!message || !isPackable(message)) continue;
			try {
				const o = toObservation(message);
				if (!o) continue;
				await ensureStored(root, o);
				const sends = sendsAfter[i] ?? 0;
				if (sends < FULL_SENDS) continue;

				const placeholder = placeholderFor(o);
				projected[i] = { ...message, content: [{ type: "text", text: placeholder }] };
				changed = true;
				stats.replaced.add(o.id);
				const saved = Math.max(0, o.tokens - estimateTokens(placeholder));
				stats.tokensSaved += saved;
				if (sends === FULL_SENDS) flash(ctx, `obspack: −${formatTokens(saved)} tokens (${o.id})`);
			} catch (error) {
				// fail-open: результат уходит как есть
				console.error(`[obspack] fail-open: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return changed ? { messages: projected } : undefined;
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Recall archived result",
		description:
			"Read part of a large tool result that obspack archived (its placeholder in context carries the id). " +
			"Without grep: returns `lines` lines starting at 1-based `line`. With grep: returns every line matching the " +
			"case-insensitive regex, prefixed with its line number. Page or search instead of re-running the original tool.",
		promptSnippet: "Page or grep a large tool result that was replaced by an [obspack] placeholder",
		parameters: Type.Object({
			id: Type.String({ description: "Observation id from the placeholder, e.g. obs_0123456789abcdef" }),
			line: Type.Optional(Type.Integer({ minimum: 1, description: "1-based first line to return (default 1)" })),
			lines: Type.Optional(
				Type.Integer({ minimum: 1, maximum: RECALL_MAX_LINES, description: `Lines to return (default ${RECALL_DEFAULT_LINES}, max ${RECALL_MAX_LINES})` }),
			),
			grep: Type.Optional(Type.String({ description: "Regex: return matching lines with numbers instead of a page" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ID_PATTERN.test(params.id)) throw new Error(`Bad observation id: ${params.id}`);
			let text: string;
			try {
				text = await readFile(objectPath(archiveRoot(ctx), params.id), "utf8");
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "ENOENT") {
					throw new Error(`Unknown observation id ${params.id}: not archived in this session`);
				}
				throw error;
			}
			stats.recalls += 1;
			const all = text.split("\n");
			if (text.endsWith("\n")) all.pop();

			if (params.grep !== undefined) {
				const g = grepLines(all, params.grep);
				const header = `[${params.id} grep /${params.grep}/i: ${g.matches} of ${all.length} lines${g.capped ? `, showing first ${GREP_MAX_MATCHES}` : ""}]`;
				return {
					content: [{ type: "text", text: g.matches === 0 ? header : `${header}\n${g.text}` }],
					details: { id: params.id, mode: "grep", matches: g.matches },
				};
			}

			const page = pageLines(all, params.line ?? 1, params.lines ?? RECALL_DEFAULT_LINES);
			if (page.from > page.total) throw new Error(`Line ${page.from} is past the end (${page.total} lines)`);
			const next = page.to < page.total ? ` next: {"id":"${params.id}","line":${page.to + 1}}` : " (end)";
			const header = `[${params.id} lines ${page.from}-${page.to} of ${page.total}${page.truncated ? ", cut at byte limit" : ""}]${next}`;
			return {
				content: [{ type: "text", text: `${header}\n${page.text}` }],
				details: { id: params.id, mode: "page", from: page.from, to: page.to, total: page.total },
			};
		},
		renderCall(params, theme) {
			const what = params.grep !== undefined ? `grep /${params.grep}/` : `lines from ${params.line ?? 1}`;
			return new Text(theme.fg("dim", `obs_recall ${params.id} ${what}`), 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			const d = result.details as { mode?: string; matches?: number; from?: number; to?: number; total?: number } | undefined;
			const line = isPartial
				? "recalling…"
				: d?.mode === "grep"
					? `${d.matches ?? 0} matches`
					: `lines ${d?.from ?? "?"}-${d?.to ?? "?"} of ${d?.total ?? "?"}`;
			return new Text(theme.fg("dim", line), 0, 0);
		},
	});

	pi.registerCommand("obspack", {
		description: "Архив больших результатов инструментов: on | off | status",
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
				ctx.ui.notify("Usage: /obspack [on|off|status]", "error");
				return;
			}
			ctx.ui.setStatus(STATUS_KEY, enabled ? undefined : ctx.ui.theme.fg("warning", "obspack off"));
			ctx.ui.notify(
				`Obspack: ${enabled ? "on" : "off"}. Архивировано ${stats.archived}, подменено ${stats.replaced.size}, ` +
					`сэкономлено ~${formatTokens(stats.tokensSaved)} токенов, recall ×${stats.recalls}`,
				"info",
			);
		},
	});
}

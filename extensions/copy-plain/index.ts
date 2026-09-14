/**
 * copy-plain — копировать последний ответ модели в буфер без markdown.
 *
 * Встроенный ctrl+x (app.message.copy) копирует «сырой» markdown.
 * ctrl+shift+x (это расширение) копирует тот же ответ простым текстом:
 * без оградителей у кодовых блоков, ссылки как «текст (url)», без звёздочек
 * и решёток — чтобы вставлять в чаты, тикеты и документы.
 *
 * /copy-plain — то же самое командой.
 *
 * Механика: последний assistant-месседж с текстом на текущей ветке сессии
 * (ctx.sessionManager.getBranch()), strip markdown, запись в буфер той же
 * стратегией, что и у самого pi (dist/utils/clipboard.js): wl-copy на Wayland,
 * xclip/xsel на X11, OSC 52 как фолбэк (SSH без локального дисплея).
 *
 * Любая ошибка = notify, сессия и буфер не трогаются.
 */

import { execSync, spawn } from "node:child_process";
import { platform } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Запись ветки сессии — только нужные поля, не тянем union SessionEntry целиком. */
type BranchEntry = {
	type: string;
	message?: {
		role: string;
		content?: string | Array<{ type: string; text?: string }>;
	};
};

/**
 * Текст последнего assistant-месседжа с текстовыми блоками.
 * Сообщения без текста (только tool-вызовы/размышления) пропускаем.
 */
export function lastAssistantText(entries: BranchEntry[]): string | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		if (typeof content === "string") {
			const text = content.trim();
			if (text) return text;
			continue;
		}
		const text = (content ?? [])
			.filter((block) => block.type === "text")
			.map((block) => (block.text ?? "").trim())
			.filter((part) => part.length > 0)
			.join("\n\n");
		if (text) return text;
	}
	return null;
}

/**
 * Markdown → читаемый plain text.
 * Скан с учётом оградителей: содержимое кодовых блоков не трогаем (в YAML-комментариях
 * и конфиге живые #, >, --- — их резать нельзя). Инлайновый код бережём
 * плейсхолдерами, чтобы snake_case не сожрали курсивом.
 */
export function stripMarkdown(markdown: string): string {
	const lines = markdown.split("\n");
	const out: string[] = [];
	let fence: string | null = null;

	for (const line of lines) {
		const trimmed = line.trim();
		if (fence) {
			// Закрытие: строка целиком из тех же оградителей (не короче открывающего).
			if (trimmed.startsWith(fence) && trimmed.replace(/[`~]/g, "") === "") fence = null;
			else out.push(line);
			continue;
		}
		const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
		if (fenceMatch) {
			fence = fenceMatch[1].slice(0, 3);
			continue;
		}
		if (/^\s{0,3}#{1,6}\s/.test(line)) {
			out.push(line.replace(/^\s{0,3}#{1,6}\s+/, ""));
		} else if (/^\s{0,3}>(?:\s|$)/.test(line)) {
			out.push(line.replace(/^\s{0,3}>\s?/, ""));
		} else if (/^\s{0,3}\|[\s:|-]*-[\s:|-]*\|\s*$/.test(line)) {
			continue; // разделитель таблицы: | --- | :---: |
		} else if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
			continue; // горизонтальная линия
		} else {
			out.push(line);
		}
	}

	let text = out.join("\n");

	// Инлайновый код — до остальных правил, чтобы snake_case и _x_ внутри не пострадали.
	const codeSpans: string[] = [];
	text = text.replace(/`([^`\n]+)`/g, (_, code: string) => {
		codeSpans.push(code);
		return `\u0000${codeSpans.length - 1}\u0000`;
	});

	// Инлайн-разметка: до фиксированной точки, чтобы ловить вложенность **bold *italic***.
	for (let i = 0; i < 3; i++) {
		const before = text;
		text = text
			.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // картинка → alt
			.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, "$1 ($2)") // ссылка → «текст (url)»
			.replace(/\*\*(.+?)\*\*/g, "$1") // **жирный** (нежадно: вложенный *курсив* внутри)
			.replace(/__([^_]+)__/g, "$1") // __жирный__
			.replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, "$1$2") // *курсив* (не внутри слов)
			.replace(/(^|[^\w_])_([^_\n]+)_(?![\w_])/g, "$1$2") // _курсив_
			.replace(/~~([^~]+)~~/g, "$1"); // ~~зачёркнутый~~
		if (text === before) break;
	}

	// Оставшиеся HTML-теги (например, <br>).
	text = text.replace(/<\/?[a-zA-Z][^>]*>/g, "");
	text = text.replace(/\u0000(\d+)\u0000/g, (_, idx: string) => codeSpans[Number(idx)]);
	return text
		.split("\n")
		.map((line) => line.replace(/\s+$/, ""))
		.join("\n")
		.trim();
}

/** Синхронный execSync с input через options — как в pi. */
function run(cmd: string, input: string): boolean {
	try {
		execSync(cmd, { input, timeout: 5000, stdio: ["pipe", "ignore", "ignore"] });
		return true;
	} catch {
		return false;
	}
}

/** wl-copy: у pi задокументирован ханг execSync на нём, поэтому spawn + stdin. */
function wlCopy(input: string): Promise<boolean> {
	return new Promise((resolve) => {
		const proc = spawn("wl-copy", [], { stdio: ["pipe", "ignore", "ignore"] });
		let done = false;
		const finish = (ok: boolean) => {
			if (!done) {
				done = true;
				resolve(ok);
			}
		};
		proc.on("error", () => finish(false));
		proc.on("close", (code) => finish(code === 0));
		proc.stdin?.end(input);
	});
}

/** OSC 52: терминал сам пишет в буфер. Фолбэк для SSH без локального дисплея. */
function osc52(text: string): boolean {
	const encoded = Buffer.from(text, "utf8").toString("base64");
	if (encoded.length > 100_000) return false;
	try {
		process.stdout.write(`\x1b]52;c;${encoded}\x07`);
		return true;
	} catch {
		return false;
	}
}

/** Копирование в системный буфер — стратегия как у copyToClipboard самого pi. */
async function copyToClipboard(text: string): Promise<boolean> {
	const p = platform();
	if (p === "darwin" && run("pbcopy", text)) return true;
	if (p === "win32" && run("clip", text)) return true;
	if (p === "linux" || p === "freebsd") {
		if (process.env.WAYLAND_DISPLAY) {
			try {
				execSync("which wl-copy", { stdio: "ignore" });
				if (await wlCopy(text)) return true;
			} catch {
				// wl-copy нет — дальше по X11/OSC 52
			}
		}
		if (process.env.DISPLAY) {
			if (run("xclip -selection clipboard", text)) return true;
			if (run("xsel --clipboard --input", text)) return true;
		}
	}
	return osc52(text);
}

export default function copyPlain(pi: ExtensionAPI) {
	const copy = async (ctx: ExtensionContext) => {
		const text = lastAssistantText(ctx.sessionManager.getBranch() as BranchEntry[]);
		if (!text) {
			ctx.ui.notify("Копировать нечего: ответов модели ещё нет", "info");
			return;
		}
		const ok = await copyToClipboard(stripMarkdown(text));
		ctx.ui.notify(
			ok ? "Скопировано: последний ответ простым текстом" : "Не удалось скопировать в буфер",
			ok ? "info" : "error",
		);
	};

	pi.registerShortcut("ctrl+shift+x", {
		description: "Скопировать последний ответ простым текстом",
		handler: (ctx) => copy(ctx),
	});

	pi.registerCommand("copy-plain", {
		description: "Скопировать последний ответ модели в буфер без markdown",
		handler: (_args, ctx) => copy(ctx),
	});
}

/**
 * Statusline — собственный футер pi: хост, cwd, ветка, модель,
 * уровень размышления, контекст и часы — одной строкой слева.
 *
 * Реализовано через ctx.ui.setFooter(): footerData отдаёт ветку git и
 * подписку на её изменения, поэтому shell-вызовы из UI-потока не нужны.
 * Требует Nerd Font в терминале (иконки из PUA-диапазона).
 */

import { hostname, homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const I_HOST = "\u{f233}"; //  fa-server
const I_MODEL = "\u{f2db}"; //  fa-microchip
const I_DIR = "\u{f07b}"; //  fa-folder-open
const I_GIT = "\u{e0a0}"; //  pl-branch
const I_CTX = "\u{f0eb}"; //  fa-lightbulb-o
const I_TIME = "\u{f017}"; //  fa-clock-o
const SEP = "\u{e0b1}"; //  thin separator

/** Часы тикают сами по себе, всё остальное перерисовывается по событиям. */
const CLOCK_INTERVAL_MS = 30_000;

const HOST = hostname().split(".")[0] ?? "?";

function shortenCwd(cwd: string | undefined): string {
	const home = homedir();
	const dir = cwd || process.cwd();
	return dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir;
}

function clock(): string {
	const now = new Date();
	return `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`;
}

function formatContext(usage: ReturnType<ExtensionContext["getContextUsage"]>): string | null {
	if (!usage || usage.tokens === null || usage.percent === null) return null;
	const max =
		usage.contextWindow >= 1000 ? `${Math.round(usage.contextWindow / 1000)}k` : String(usage.contextWindow);
	return `${usage.percent.toFixed(1)}%/${max}`;
}

export default function (pi: ExtensionAPI) {
	let requestRender: (() => void) | undefined;

	function install(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();

			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
			const timer = setInterval(() => tui.requestRender(), CLOCK_INTERVAL_MS);
			timer.unref?.();

			return {
				invalidate() {},
				dispose() {
					clearInterval(timer);
					unsubscribe?.();
					requestRender = undefined;
				},
				render(width: number): string[] {
					const model = ctx.model;
					const usage = ctx.getContextUsage();
					const ctxStr = formatContext(usage);
					const branch = footerData.getGitBranch();
					const thinking = ctx.thinkingLevel;

					const segments = [
						theme.fg("accent", `${I_HOST} ${HOST}`),
						theme.fg("text", `${I_DIR} ${shortenCwd(ctx.cwd)}`),
					];
					if (branch) segments.push(theme.fg("warning", `${I_GIT} ${branch}`));
					segments.push(theme.fg("success", `${I_MODEL} ${model?.id ?? model?.name ?? "—"}`));
					if (thinking && thinking !== "off") segments.push(theme.fg("muted", thinking));
					if (ctxStr) {
						const percent = usage?.percent ?? 0;
						const color = percent > 80 ? "error" : percent > 50 ? "warning" : "muted";
						segments.push(theme.fg(color, `${I_CTX} ${ctxStr}`));
					}
					segments.push(theme.fg("dim", `${I_TIME} ${clock()}`));

					const sep = theme.fg("dim", ` ${SEP} `);
					return [truncateToWidth(segments.join(sep), width)];
				},
			};
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		install(ctx);
	});

	// Перерисовка по событиям, меняющим содержимое футера. Развёрнуто в отдельные
	// вызовы, а не цикл по массиву: pi.on перегружена по литералу события, и union
	// из цикла не подходит ни под одну перегрузку.
	const rerender = async () => {
		requestRender?.();
	};
	pi.on("after_provider_response", rerender);
	pi.on("agent_end", rerender);
	pi.on("model_select", rerender);
	pi.on("thinking_level_select", rerender);

	pi.on("session_shutdown", async () => {
		requestRender = undefined;
	});
}

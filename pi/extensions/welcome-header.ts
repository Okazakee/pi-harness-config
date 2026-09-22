/**
 * Custom startup header, styled after oh-my-pi's welcome banner.
 *
 *   ╭─── pi v0.87.1 ─────────────────────── FREEDOM // PRIVACY ───╮
 *   │        Welcome back!        │ Tips                           │
 *   │           <logo>            │ #  prompt actions              │
 *   │      DeepSeek V4.1 Flash    │ ...                            │
 *   │          opencode-go        │ ────────────────────────────── │
 *   │                             │ Recent sessions                │
 *   │                             │ › some task (9/22/2026)        │
 *   ╰─────────────────────────────┴────────────────────────────────╯
 *
 * Logo resolution (first match wins), under <cwd>/.pi then ~/.pi/agent:
 *
 *   1. logo.png   raster image, drawn *inside* the box's left column with the
 *                 Kitty graphics protocol
 *   2. logo.txt   ASCII/ANSI art, drawn inside the box's left column
 *   3. built-in pi mascot
 *
 * The raster path writes its own Kitty sequence (rather than pi-tui's Image
 * component) for two reasons: Kitty images are placed at the cursor column, so
 * indenting the sequence puts the logo inside the left column; and pi-tui only
 * rewrites lines for images it registered itself, so a self-encoded line keeps
 * its surrounding box borders. A cursor-forward skips the image cells on the
 * rows the image spans so the right column text does not overwrite it.
 *
 * Kitty only decodes PNG (pi-tui hardcodes `f=100`), so non-PNG files fall back
 * to text/mascot. Terminals without an image protocol (tmux, screen, unknown)
 * also fall back.
 *
 * Recent sessions come from SessionManager.list(cwd); the list is loaded
 * asynchronously and the header re-renders when it arrives.
 */

import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

import {
	type ExtensionAPI,
	getAgentDir,
	type SessionInfo,
	SessionManager,
	type Theme,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import {
	allocateImageId,
	deleteKittyImage,
	encodeKitty,
	getCapabilities,
	getCellDimensions,
	getImageDimensions,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

/** Below this terminal width the box is replaced by a single info line. */
const MIN_WIDTH = 64;
/** Minimum inner width of the left (welcome) column. */
const LEFT_W = 26;
/** How many recent sessions to list. */
const RECENT_SESSIONS = 3;
/** Bounds for the raster logo, in terminal cells. */
const LOGO_MAX_WIDTH = 26;
const LOGO_MAX_HEIGHT = 13;

type LogoSource = { kind: "text"; lines: string[] } | { kind: "image"; path: string };

interface RasterLogo {
	base64: string;
	widthPx: number;
	heightPx: number;
	imageId: number;
}

function padRight(text: string, width: number): string {
	const textWidth = visibleWidth(text);
	if (textWidth === width) return text;
	if (textWidth > width) return truncateToWidth(text, width, "…");
	return text + " ".repeat(width - textWidth);
}

function center(text: string, width: number): string {
	const textWidth = visibleWidth(text);
	if (textWidth >= width) return truncateToWidth(text, width, "");
	const left = Math.floor((width - textWidth) / 2);
	return " ".repeat(left) + text + " ".repeat(width - textWidth - left);
}

function formatDate(date: Date): string {
	return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
}

function mascot(theme: Theme): string[] {
	const block = (count: number) => theme.fg("accent", "█".repeat(count));
	const eye = theme.fg("text", "█") + theme.fg("dim", "▌");
	return [
		`     ${eye}  ${eye}`,
		`  ${block(14)}`,
		`     ${block(2)}    ${block(2)}`,
		`     ${block(2)}    ${block(2)}`,
		`     ${block(2)}    ${block(2)}`,
		`     ${block(2)}    ${block(2)}`,
	];
}

// ── Logo resolution ────────────────────────────────────────────────────────

function readTextLogo(path: string): string[] | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const text = readFileSync(path, "utf8").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
		if (text.trim().length === 0) return undefined;
		return text.split("\n");
	} catch {
		return undefined;
	}
}

function findImageLogo(dir: string): string | undefined {
	const candidate = join(dir, "logo.png");
	return existsSync(candidate) ? candidate : undefined;
}

function resolveLogo(cwd: string): LogoSource | undefined {
	const directories = [join(cwd, ".pi"), getAgentDir()];

	for (const directory of directories) {
		const image = findImageLogo(directory);
		if (image) return { kind: "image", path: image };
	}
	for (const directory of directories) {
		const lines = readTextLogo(join(directory, "logo.txt"));
		if (lines) return { kind: "text", lines };
	}
	return undefined;
}

/**
 * Columns/rows that keep the image's aspect ratio at the current font metrics.
 * pi-tui learns the real cell size asynchronously (CSI 16 t); using the 9x18
 * fallback would make Kitty stretch the image, so this is recomputed whenever
 * the reported cell size changes.
 */
function rasterCellSize(widthPx: number, heightPx: number): { columns: number; rows: number } {
	const cell = getCellDimensions();
	const rowsPerColumn = (heightPx / widthPx) * (cell.widthPx / cell.heightPx);
	let columns = LOGO_MAX_WIDTH;
	let rows = Math.max(1, Math.round(columns * rowsPerColumn));
	if (rows > LOGO_MAX_HEIGHT) {
		rows = LOGO_MAX_HEIGHT;
		columns = Math.max(1, Math.round(rows / rowsPerColumn));
	}
	return {
		columns: Math.max(1, Math.min(columns, LOGO_MAX_WIDTH)),
		rows: Math.max(1, Math.min(rows, LOGO_MAX_HEIGHT)),
	};
}

/**
 * Read the raster logo and remember its pixels. The Kitty sequence is built
 * lazily (see currentRaster) once the terminal's cell size is known. Only PNG
 * is valid here: pi-tui/Kitty transmit with `f=100`.
 */
function createRasterLogo(source: LogoSource & { kind: "image" }): RasterLogo | undefined {
	if (getCapabilities().images !== "kitty") return undefined;
	if (extname(source.path).toLowerCase() !== ".png") return undefined;
	try {
		const base64 = readFileSync(source.path).toString("base64");
		const dimensions = getImageDimensions(base64, "image/png");
		if (!dimensions) return undefined;
		return { base64, widthPx: dimensions.widthPx, heightPx: dimensions.heightPx, imageId: allocateImageId() };
	} catch {
		return undefined;
	}
}

function sessionRow(theme: Theme, info: SessionInfo, rightWidth: number): string {
	const raw = (info.name || info.firstMessage || "(empty)").replace(/\s+/g, " ").trim();
	const dateText = `(${formatDate(info.modified)})`;
	const prefix = "› ";
	const titleWidth = Math.max(4, rightWidth - 1 - visibleWidth(prefix) - 1 - visibleWidth(dateText));
	const title = truncateToWidth(raw, titleWidth, "…");
	return `${theme.fg("muted", prefix)}${title} ${theme.fg("dim", dateText)}`;
}

// ── Extension ──────────────────────────────────────────────────────────────

export default function welcomeHeader(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		let sessions: SessionInfo[] = [];
		let sessionsLoaded = false;
		const logo = resolveLogo(ctx.cwd);

		ctx.ui.setHeader((tui, theme) => {
			void SessionManager.list(ctx.cwd)
				.then((list) => {
					const current = ctx.sessionManager.getSessionFile();
					sessions = list
						.filter((session) => session.messageCount > 0 && session.path !== current)
						.sort((a, b) => b.modified.getTime() - a.modified.getTime())
						.slice(0, RECENT_SESSIONS);
				})
				.catch(() => {
					sessions = [];
				})
				.finally(() => {
					sessionsLoaded = true;
					tui.requestRender();
				});

			const raster = logo?.kind === "image" ? createRasterLogo(logo) : undefined;

			const border = (text: string) => theme.fg("border", text);
			const accent = (text: string) => theme.fg("accent", text);
			const muted = (text: string) => theme.fg("muted", text);
			const dim = (text: string) => theme.fg("dim", text);

			// The Kitty sequence depends on the terminal's cell size, which pi-tui
			// reports asynchronously. Rebuild it whenever those metrics change so the
			// image is never stretched.
			let rasterFrame: { key: string; sequence: string; columns: number; rows: number } | undefined;
			const currentRaster = (): { sequence: string; columns: number; rows: number } | undefined => {
				if (!raster) return undefined;
				const cell = getCellDimensions();
				const key = `${cell.widthPx}x${cell.heightPx}`;
				if (!rasterFrame || rasterFrame.key !== key) {
					const { columns, rows } = rasterCellSize(raster.widthPx, raster.heightPx);
					rasterFrame = {
						key,
						columns,
						rows,
						sequence: encodeKitty(raster.base64, {
							columns,
							rows,
							imageId: raster.imageId,
							moveCursor: false,
						}),
					};
				}
				return rasterFrame;
			};

			const buildBox = (width: number): string[] => {
				const model = ctx.model;
				const modelName = model?.name || model?.id || "no model";
				const provider = model?.provider ?? "";
				const frame = currentRaster();

				// The left column holds the ASCII art only when no raster logo is used.
				const art = frame ? undefined : logo?.kind === "text" ? logo.lines : mascot(theme);
				const artWidth = art ? art.reduce((max, line) => Math.max(max, visibleWidth(line)), 0) : 0;
				const desiredLeft = frame ? frame.columns + 4 : artWidth + 2;
				const leftWidth = Math.max(
					LEFT_W,
					Math.min(desiredLeft, Math.floor(width / 2), width - 27),
				);
				const rightWidth = width - leftWidth - 3;

				const left: string[] = ["", accent("Welcome back!")];
				let imageTop = -1;
				if (frame) {
					imageTop = left.length;
					for (let index = 0; index < frame.rows; index++) left.push("");
				} else if (art) {
					left.push("", ...art);
				}
				left.push("", accent(modelName), muted(provider), "");

				const right: (string | null)[] = [
					accent("Tips"),
					muted("#  prompt actions"),
					muted("/  commands"),
					muted("!  run bash"),
					muted("$  run python"),
					null,
					accent("Recent sessions"),
				];
				if (!sessionsLoaded) {
					right.push(dim("loading…"));
				} else if (sessions.length === 0) {
					right.push(dim("No recent sessions"));
				} else {
					for (const session of sessions) right.push(sessionRow(theme, session, rightWidth));
				}

				const height = Math.max(left.length, right.length);
				const lines: string[] = [];

				const title = ` pi v${VERSION} `;
				const badge = " FREEDOM // PRIVACY ";
				const head = "───" + title;
				const fill = Math.max(1, width - 2 - visibleWidth(head) - visibleWidth(badge));
				lines.push(
					border("╭───") +
						accent(title) +
						border("─".repeat(fill)) +
						accent(badge) +
						border("╮"),
				);

				const padLeft = frame ? Math.floor((leftWidth - frame.columns) / 2) : 0;
				const padRightImage = frame ? leftWidth - frame.columns - padLeft : 0;

				for (let index = 0; index < height; index++) {
					const rightCell = right[index];
					const isImageRow = frame !== undefined && index >= imageTop && index < imageTop + frame.rows;

					let leftPart: string;
					if (frame && isImageRow) {
						const top = index === imageTop;
						leftPart =
							border("│") +
							" ".repeat(Math.max(0, padLeft)) +
							(top ? frame.sequence : "") +
							`\x1b[${frame.columns}C` +
							" ".repeat(Math.max(0, padRightImage)) +
							border("│");
					} else {
						leftPart = border("│") + center(left[index] ?? "", leftWidth) + border("│");
					}

					let rightPart: string;
					if (rightCell === null) {
						rightPart = border(" ") + border("─".repeat(Math.max(0, rightWidth - 2))) + border(" ") + border("│");
					} else {
						rightPart = border(" ") + padRight(rightCell ?? "", rightWidth - 1) + border("│");
					}

					lines.push(leftPart + rightPart);
				}

				lines.push(border(`╰${"─".repeat(leftWidth)}┴${"─".repeat(rightWidth)}╯`));
				return lines;
			};

			return {
				dispose() {
					if (raster) process.stdout.write(deleteKittyImage(raster.imageId));
				},
				invalidate() {
					rasterFrame = undefined;
				},
				render(width: number): string[] {
					const model = ctx.model;
					const modelName = model?.name || model?.id || "no model";
					const provider = model?.provider ?? "";

					if (width < MIN_WIDTH) {
						const parts = [accent(`pi v${VERSION}`), modelName, provider].filter(Boolean);
						return [truncateToWidth(parts.join(dim(" · ")), width, "…")];
					}
					return buildBox(width);
				},
			};
		});
	});

	pi.registerCommand("builtin-header", {
		description: "Restore the built-in startup header",
		handler: async (_args, ctx) => {
			ctx.ui.setHeader(undefined);
			ctx.ui.notify("Built-in header restored", "info");
		},
	});
}

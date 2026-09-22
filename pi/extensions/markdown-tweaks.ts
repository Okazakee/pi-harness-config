import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

/**
 * Display-only Markdown tweaks for Pi's TUI.
 *
 * Pi's renderer keeps the literal "### " prefix for heading levels >= 3 (only
 * h1/h2 strip it). This demotes h3-h6 to h2 so headings render cleanly with no
 * visible "#" prefix. Fenced code blocks are skipped so their content is never
 * rewritten.
 *
 * Display-only: the session and model context keep the original text.
 */
export default function markdownTweaks(pi: ExtensionAPI): void {
	const fenceRe = /^\s{0,3}(`{3,}|~{3,})/

	pi.registerMarkdownTransformer((markdown) => {
		if (!markdown.includes("#") && !markdown.includes("`") && !markdown.includes("~")) {
			return markdown
		}

		const lines = markdown.split("\n")
		let openFence: string | undefined

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]
			const fence = fenceRe.exec(line)

			if (fence) {
				const marker = fence[1][0]
				if (openFence === undefined) openFence = marker
				else if (marker === openFence) openFence = undefined
				continue
			}

			if (openFence !== undefined) continue

			lines[i] = line.replace(/^#{3,6}(\s)/, "##$1")
		}

		return lines.join("\n")
	})
}

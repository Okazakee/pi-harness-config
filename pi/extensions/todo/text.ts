// ---------------------------------------------------------------- text helpers

/** Collapse all whitespace to single spaces and trim. */
export function normalizeLabel(text: string): string {
	return text.replace(/\s+/g, " ").trim()
}

/** Case-insensitive identity key for tasks and phases. */
export function labelKey(text: string): string {
	return normalizeLabel(text).toLowerCase()
}

/** Truncate on code-point boundaries, appending a single ellipsis. */
export function truncateLabel(text: string, maxChars: number): string {
	if (maxChars <= 0) return ""
	const chars = [...text]
	if (chars.length <= maxChars) return text
	if (maxChars === 1) return chars[0]
	return `${chars.slice(0, maxChars - 1).join("")}…`
}

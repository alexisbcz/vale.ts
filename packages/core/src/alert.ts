/**
 * What a rule reports, and how reports are ordered.
 */

/** The levels an alert can carry, from least to most severe. */
export const ALERT_LEVELS = ["suggestion", "warning", "error"] as const;

export type AlertLevel = (typeof ALERT_LEVELS)[number];

/** Levels as numbers, so `MinAlertLevel` can compare them. */
export const LEVEL_TO_INT: Record<string, number> = {
	suggestion: 0,
	warning: 1,
	error: 2,
};

export function isAlertLevel(s: string): s is AlertLevel {
	return (ALERT_LEVELS as readonly string[]).includes(s);
}

/** A possible fix for an alert. */
export interface Action {
	/** `replace`, `remove`, `edit`, `suggest`, or "" for no action. */
	name: string;
	/** The action's arguments. */
	params: string[];
}

export function emptyAction(): Action {
	return { name: "", params: [] };
}

/** A span within a line, as a 1-based inclusive `[begin, end]` pair. */
export type Span = [number, number];

/** One finding in a document. */
export interface Alert {
	/** A possible fix. */
	action: Action;
	/** What `action` resolves to, when that is known at lint time. */
	suggestions: string[];
	/** The matched token's capture groups, when it had any. */
	groups?: string[];
	/** The `[begin, end]` columns within `line`, 1-based and inclusive. */
	span: number[];
	/** Tokens to skip past when locating this match. */
	offset?: string[];
	/** The rule that reported it. */
	check: string;
	/** Why the message matters. */
	description: string;
	/** Reference material. */
	link: string;
	/** What to show the user. */
	message: string;
	/** `suggestion`, `warning` or `error`. */
	severity: string;
	/** The text that matched. */
	match: string;
	/** The 1-based source line. */
	line: number;
	/** How many times this rule may report; 0 means no limit. */
	limit?: number;
	/** Whether to keep the alert out of the output. */
	hide?: boolean;
	/** Whether `span` holds offsets into the raw document rather than columns. */
	hasByteOffsets?: boolean;
	/**
	 * How many acceptable occurrences of `match` precede this one within its
	 * block, so a search for it can skip exactly that many.
	 */
	skipOcc?: number;
}

/** A blank alert, for a caller that fills the fields it cares about. */
export function newAlert(partial: Partial<Alert> = {}): Alert {
	return {
		action: emptyAction(),
		suggestions: [],
		span: [0, 0],
		check: "",
		description: "",
		link: "",
		message: "",
		severity: "",
		match: "",
		line: 0,
		...partial,
	};
}

/** Fills in the fields every alert is required to have. */
export function formatAlert(
	a: Alert,
	limit: number,
	level: string,
	name: string,
): void {
	if (a.severity === "") a.severity = level;
	if (a.check === "") a.check = name;
	a.limit = limit;
	a.message = whitespaceToSpace(a.message);
	if (!a.suggestions) a.suggestions = [];
}

/** Collapses the newlines in a message into spaces. */
export function whitespaceToSpace(msg: string): string {
	return msg.replaceAll("\n", " ");
}

/**
 * Sorts alerts by line and then column.
 *
 * The sort is stable, which keeps rule order for the alerts that share a
 * position -- two measurements of the same block, say.
 */
export function sortAlerts(alerts: Alert[]): Alert[] {
	return alerts.sort((a, b) =>
		a.line !== b.line ? a.line - b.line : (a.span[0] ?? 0) - (b.span[0] ?? 0),
	);
}

/**
 * The slice of semantic versioning `vale sync` needs.
 *
 * A package declares the Vale it needs as a constraint -- `>=3.20.0` -- and
 * `sync` compares this build against it. Go uses `Masterminds/semver`; what
 * `pkgver.go` asks of it is parsing a version, ordering two of them, and
 * checking a comma- or `||`-separated constraint, which is what is here.
 */

/** A parsed version. */
export interface Version {
	major: number;
	minor: number;
	patch: number;
	/** The dot-separated identifiers after a `-`, or an empty list. */
	prerelease: string[];
	/** The original text, so a caller can print what it was given. */
	original: string;
}

const VERSION_RE =
	/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

/** Parses a version, or returns `null` when the text is not one. */
export function parseVersion(text: string): Version | null {
	const m = VERSION_RE.exec(text.trim());
	if (m === null) return null;

	return {
		major: Number(m[1]),
		minor: m[2] === undefined ? 0 : Number(m[2]),
		patch: m[3] === undefined ? 0 : Number(m[3]),
		prerelease: m[4] === undefined || m[4] === "" ? [] : m[4].split("."),
		original: text,
	};
}

/** Orders two prerelease identifier lists, as the specification does. */
function comparePrerelease(a: readonly string[], b: readonly string[]): number {
	// A version without a prerelease outranks one with it.
	if (a.length === 0 && b.length === 0) return 0;
	if (a.length === 0) return 1;
	if (b.length === 0) return -1;

	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const x = a[i];
		const y = b[i];
		if (x === undefined) return -1;
		if (y === undefined) return 1;

		const nx = /^\d+$/.test(x) ? Number(x) : null;
		const ny = /^\d+$/.test(y) ? Number(y) : null;

		if (nx !== null && ny !== null) {
			if (nx !== ny) return nx < ny ? -1 : 1;
			continue;
		}
		// Numeric identifiers sort below alphanumeric ones.
		if (nx !== null) return -1;
		if (ny !== null) return 1;
		if (x !== y) return x < y ? -1 : 1;
	}

	return 0;
}

/** Orders two versions: negative when `a` is the older. */
export function compareVersions(a: Version, b: Version): number {
	if (a.major !== b.major) return a.major < b.major ? -1 : 1;
	if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
	if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
	return comparePrerelease(a.prerelease, b.prerelease);
}

/** One comparison a constraint is made of. */
interface Comparator {
	op: string;
	version: Version;
	/** Whether the constraint named a minor and a patch, for `~` and `^`. */
	hadMinor: boolean;
	hadPatch: boolean;
}

const CONSTRAINT_RE = /^(=|==|!=|>=|=>|<=|=<|>|<|~>|~|\^)?\s*(.+)$/;

/** Parses one comparator, or returns `null` when it is not one. */
function parseComparator(text: string): Comparator | null {
	const m = CONSTRAINT_RE.exec(text.trim());
	if (m === null) return null;

	const op = m[1] ?? "=";
	const body = (m[2] ?? "").trim();

	// A wildcard matches anything, which is `>=0.0.0`.
	if (body === "" || body === "*" || body === "x" || body === "X") {
		return {
			op: ">=",
			version: { major: 0, minor: 0, patch: 0, prerelease: [], original: body },
			hadMinor: true,
			hadPatch: true,
		};
	}

	const version = parseVersion(body);
	if (version === null) return null;

	const parts = body.replace(/^v/, "").split("-")[0]?.split(".") ?? [];
	return {
		op,
		version,
		hadMinor: parts.length > 1,
		hadPatch: parts.length > 2,
	};
}

/** Whether `v` satisfies one comparator. */
function satisfiesOne(v: Version, c: Comparator): boolean {
	const cmp = compareVersions(v, c.version);

	switch (c.op) {
		case "=":
		case "==":
			return cmp === 0;
		case "!=":
			return cmp !== 0;
		case ">":
			return cmp > 0;
		case "<":
			return cmp < 0;
		case ">=":
		case "=>":
			return cmp >= 0;
		case "<=":
		case "=<":
			return cmp <= 0;
		case "~":
		case "~>": {
			// `~1.2.3` allows patch changes; `~1.2` allows minor ones.
			if (cmp < 0) return false;
			if (v.major !== c.version.major) return false;
			if (c.hadMinor && v.minor !== c.version.minor) return false;
			return true;
		}
		case "^": {
			// `^1.2.3` allows anything below 2.0.0; below 1.0.0 the first
			// nonzero part is the one that is pinned.
			if (cmp < 0) return false;
			if (c.version.major > 0) return v.major === c.version.major;
			if (c.version.minor > 0 || c.hadMinor) {
				return v.major === 0 && v.minor === c.version.minor;
			}
			return v.major === 0;
		}
		default:
			return false;
	}
}

/** A parsed constraint: any one of its groups satisfying is enough. */
export interface Constraint {
	groups: Comparator[][];
}

/**
 * Parses a constraint, or returns `null` when it cannot be read.
 *
 * `||` separates alternatives and a comma or a space separates the parts of
 * one, so `>=1.2.0, <2.0.0 || >=3.0.0` reads as two groups.
 */
export function parseConstraint(text: string): Constraint | null {
	const groups: Comparator[][] = [];

	for (const alternative of text.split("||")) {
		const parts = alternative
			.split(",")
			.flatMap((p) => p.trim().split(/\s+(?=[<>=!~^])/))
			.map((p) => p.trim())
			.filter((p) => p !== "");

		if (parts.length === 0) return null;

		const group: Comparator[] = [];
		for (const part of parts) {
			const comparator = parseComparator(part);
			if (comparator === null) return null;
			group.push(comparator);
		}
		groups.push(group);
	}

	return groups.length === 0 ? null : { groups };
}

/** Whether `version` satisfies `constraint`. */
export function satisfies(constraint: Constraint, version: Version): boolean {
	return constraint.groups.some((group) =>
		group.every((c) => satisfiesOne(version, c)),
	);
}

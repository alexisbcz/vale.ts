/**
 * Turning a dictionary's two files into the text the reader expects.
 *
 * The `.aff` says how the pair is encoded with SET. Hunspell's default is
 * ISO8859-1, but a file without SET that is valid UTF-8 is read as UTF-8, as
 * this checker always has.
 */

import { fields, lines } from "./text.ts";

/** The byte order mark some dictionaries start with. */
const UTF8_BOM = [0xef, 0xbb, 0xbf];

/** A dictionary pair as text. */
export interface DecodedDictionary {
	aff: string;
	dic: string;
}

const encoder = new TextEncoder();

/** Encodes text as the UTF-8 bytes a file of it would hold. */
export function toBytes(s: string): Uint8Array {
	return encoder.encode(s);
}

/**
 * Converts a dictionary's files to text, reading them in the encoding the
 * `.aff` declares.
 *
 * Both files are needed at once because only the `.aff` says what either one
 * is; `dic` may be empty when a caller wants the affixes alone.
 */
export function decodeDictionary(
	aff: Uint8Array,
	dic: Uint8Array,
): DecodedDictionary {
	const affBytes = trimBOM(aff);
	const dicBytes = trimBOM(dic);

	const charset = declaredCharset(affBytes);
	if (charset === "") {
		const utf8 = decodeUTF8Strict(affBytes, dicBytes);
		if (utf8 !== null) return utf8;
		return decodeWith("ISO8859-1", affBytes, dicBytes);
	}
	const upper = charset.toUpperCase();
	if (upper === "UTF-8" || upper === "UTF8") {
		return {
			aff: new TextDecoder("utf-8").decode(affBytes),
			dic: new TextDecoder("utf-8").decode(dicBytes),
		};
	}
	return decodeWith(charset, affBytes, dicBytes);
}

/** `decodeDictionary` over text a caller already holds, rather than files. */
export function decodeDictionaryText(aff: string, dic: string): DecodedDictionary {
	return decodeDictionary(toBytes(aff), toBytes(dic));
}

function trimBOM(b: Uint8Array): Uint8Array {
	for (let i = 0; i < UTF8_BOM.length; i++) {
		if (b[i] !== UTF8_BOM[i]) return b;
	}
	return b.subarray(UTF8_BOM.length);
}

/**
 * The SET value of a `.aff`, or "".
 *
 * The bytes are read as Latin-1 to find it, which cannot fail and leaves
 * every ASCII directive name intact whatever the file's real encoding is.
 */
function declaredCharset(aff: Uint8Array): string {
	for (const line of lines(latin1(aff))) {
		const parts = fields(line);
		if (parts.length >= 2 && parts[0] === "SET") return parts[1] as string;
	}
	return "";
}

function decodeUTF8Strict(
	aff: Uint8Array,
	dic: Uint8Array,
): DecodedDictionary | null {
	try {
		const strict = new TextDecoder("utf-8", { fatal: true });
		return { aff: strict.decode(aff), dic: strict.decode(dic) };
	} catch {
		return null;
	}
}

/** One byte to one code point, which is what ISO-8859-1 means. */
function latin1(b: Uint8Array): string {
	let out = "";
	// Chunked so a large dictionary does not overflow the argument list.
	const chunk = 0x8000;
	for (let i = 0; i < b.length; i += chunk) {
		out += String.fromCharCode(...b.subarray(i, i + chunk));
	}
	return out;
}

/**
 * Decodes both files in the named charset.
 *
 * Hunspell writes `ISO8859-1` where the registry spells it `ISO-8859-1`, so
 * the name is normalized before it is looked up. ISO-8859-1 is decoded
 * directly rather than through `TextDecoder`, which maps that label to
 * windows-1252 and so would read the bytes 0x80 to 0x9f as punctuation
 * instead of as control characters.
 */
function decodeWith(
	name: string,
	aff: Uint8Array,
	dic: Uint8Array,
): DecodedDictionary {
	const label = name.toUpperCase().replace("ISO8859-", "ISO-8859-");
	if (label === "ISO-8859-1" || label === "LATIN1" || label === "LATIN-1") {
		return { aff: latin1(aff), dic: latin1(dic) };
	}

	let decoder: TextDecoder;
	try {
		// The label comes from the file, so it is a string rather than one of
		// the encodings the host's types enumerate; an unknown one throws.
		decoder = new TextDecoder(label as never);
	} catch {
		throw new Error(`SET ${name}: unsupported encoding`);
	}
	return { aff: decoder.decode(aff), dic: decoder.decode(dic) };
}

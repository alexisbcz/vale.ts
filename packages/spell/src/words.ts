/**
 * The shapes a token may have that are not dictionary words: numbers, hex and
 * binary literals, hashes, and a number with a unit attached.
 *
 * These are heavily English-oriented, and were in the checker before this
 * port; they are kept as they were.
 */

import { isDigit, isLetter, runes } from "./text.ts";

/** A number, which may hold dots, commas and dashes. */
const NUMBER = /^([0-9]+[.,-]?)+$/;

/** A number with a unit, such as `123ms`, `12in` or `1ft`. */
const NUMBER_UNITS = /^[0-9]+[a-zA-Z]+$/;

/** `0x12FF`, `0x1B` or `x12FF`; nobody seems to write `0XFF`. */
const NUMBER_HEX = /^0?[x][0-9A-Fa-f]+$/;

const NUMBER_BINARY = /^0[b][01]+$/;

const SHA_HASH = /^[0-9a-z]{40}$/;

/**
 * Splits text into words.
 *
 * Every character given to the constructor counts as a word character, as
 * does any Unicode letter; anything else is a word boundary. This is likely
 * to change, so it stays wrapped.
 */
export class Splitter {
	private readonly chars: string;

	/** `chars` is the dictionary's WORDCHARS. */
	constructor(chars: string) {
		this.chars = chars;
	}

	/** Reports whether `ch` ends a word. */
	isBoundary(ch: string): boolean {
		return !isLetter(ch) && !this.chars.includes(ch);
	}

	/** The words of `text`, with every empty run between them dropped. */
	split(text: string): string[] {
		const out: string[] = [];
		let word = "";
		for (const ch of text) {
			if (this.isBoundary(ch)) {
				if (word !== "") out.push(word);
				word = "";
				continue;
			}
			word += ch;
		}
		if (word !== "") out.push(word);
		return out;
	}
}

export function isNumber(s: string): boolean {
	if (NUMBER.test(s)) return true;
	// Digits in any script: ۱۲۳.
	if (s === "") return false;
	for (const ch of s) {
		if (!isDigit(ch)) return false;
	}
	return true;
}

export function isNumberBinary(s: string): boolean {
	return NUMBER_BINARY.test(s);
}

/**
 * The unit of a "number with units" such as `101ms`, `3ft` or `5GB`, or ""
 * when `s` is not one.
 */
export function isNumberUnits(s: string): string {
	if (!NUMBER_UNITS.test(s)) return "";
	let at = 0;
	for (const ch of runes(s)) {
		if (ch >= "0" && ch <= "9") {
			at += ch.length;
			continue;
		}
		return s.slice(at);
	}
	throw new Error("assertion failed");
}

export function isNumberHex(s: string): boolean {
	return NUMBER_HEX.test(s);
}

export function isHash(s: string): boolean {
	return SHA_HASH.test(s);
}

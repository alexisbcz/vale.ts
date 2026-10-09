/**
 * The reader for prose's flat averaged-perceptron model (magic `PROSETAG`).
 *
 * # Layout
 *
 * The weights are sparse (mean 3.59 classes per feature, median 2), so they
 * are stored compressed-sparse-row: one offsets array indexing into parallel
 * class-ID and weight arrays. All little-endian.
 *
 *     magic     [8]byte  "PROSETAG"
 *     version   uint32
 *     nClasses  uint32   then per class: uint16 len + bytes
 *     nFeatures uint32
 *     nPairs    uint32
 *     blobLen   uint32   then blobLen bytes  (feature strings, concatenated,
 *                                             sorted bytewise)
 *     featOff   (nFeatures+1) x uint32       (slices into the blob)
 *     pairOff   (nFeatures+1) x uint32       (slices into classIDs/weights)
 *     classIDs  nPairs x uint8
 *     weights   nPairs x float32
 *     nTagMap   uint32   then per entry: uint16 len + bytes, uint8 classID
 *
 * # Why the lookups take bytes
 *
 * The feature blob is sorted *bytewise* over UTF-8, which is not the order
 * JavaScript compares strings in: UTF-16 puts the astral planes before
 * U+E000..U+FFFF, UTF-8 does not. So the binary search compares `Uint8Array`s
 * and the caller hands it a UTF-8 key. `tagger.ts` has to assemble keys in
 * bytes anyway, because the features themselves are byte-oriented, so nothing
 * is decoded on the hot path.
 */

const MAGIC = "PROSETAG";
const VERSION = 1;

/** The ceiling implied by storing class IDs as `uint8`. */
const MAX_CLASSES = 256;

/** A decoded flat averaged-perceptron model, ready for scoring. */
export class Model {
	/** Class ID -> name. */
	readonly classes: readonly string[];

	/** All feature strings, concatenated, sorted bytewise. */
	private readonly blob: Uint8Array;
	private readonly featOff: Uint32Array;
	private readonly pairOff: Uint32Array;
	private readonly classIDs: Uint8Array;
	private readonly weights: Float32Array;

	/** Unambiguous word -> class assignments, bypassing scoring. */
	private readonly tagMap: Map<string, number>;

	constructor(
		classes: string[],
		blob: Uint8Array,
		featOff: Uint32Array,
		pairOff: Uint32Array,
		classIDs: Uint8Array,
		weights: Float32Array,
		tagMap: Map<string, number>,
	) {
		this.classes = classes;
		this.blob = blob;
		this.featOff = featOff;
		this.pairOff = pairOff;
		this.classIDs = classIDs;
		this.weights = weights;
		this.tagMap = tagMap;
	}

	/** How many distinct features the model knows. */
	numFeatures(): number {
		return this.featOff.length - 1;
	}

	/** How many feature-class weights the model holds. */
	numPairs(): number {
		return this.weights.length;
	}

	/** The pre-assigned tag for an unambiguous word, or undefined. */
	tagFor(word: string): string | undefined {
		const id = this.tagMap.get(word);
		if (id === undefined) return undefined;
		return this.classes[id];
	}

	/**
	 * The index of `feat`, or -1. Binary search over the blob.
	 *
	 * `feat` is UTF-8, compared byte for byte; see the note at the top of the
	 * file about why.
	 */
	feature(feat: Uint8Array, featLen: number = feat.length): number {
		const n = this.featOff.length - 1;
		// sort.Search: the smallest i whose feature is >= feat.
		let lo = 0;
		let hi = n;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (
				compare(
					this.blob,
					this.featOff[mid]!,
					this.featOff[mid + 1]!,
					feat,
					featLen,
				) >= 0
			) {
				hi = mid;
			} else {
				lo = mid + 1;
			}
		}
		if (
			lo < n &&
			compare(
				this.blob,
				this.featOff[lo]!,
				this.featOff[lo + 1]!,
				feat,
				featLen,
			) === 0
		) {
			return lo;
		}
		return -1;
	}

	/**
	 * Adds the weights of `feat`, scaled by `value`, into `scores`, reporting
	 * whether the feature was known.
	 *
	 * `scores` is a `Float32Array` so that each accumulation rounds the way
	 * Go's `float32` arithmetic does; a `number[]` would keep double precision
	 * and could break a tie the other way.
	 */
	accumulateInto(
		feat: Uint8Array,
		value: number,
		scores: Float32Array,
		featLen: number = feat.length,
	): boolean {
		const i = this.feature(feat, featLen);
		if (i < 0) return false;
		const lo = this.pairOff[i]!;
		const hi = this.pairOff[i + 1]!;
		for (let j = lo; j < hi; j++) {
			scores[this.classIDs[j]!] += Math.fround(value * this.weights[j]!);
		}
		return true;
	}

	/**
	 * The highest-scoring class name.
	 *
	 * Ties break toward the lowest class ID, so the result is deterministic.
	 */
	best(scores: Float32Array): string {
		let best = Number.NEGATIVE_INFINITY;
		let bestID = -1;
		for (let id = 0; id < this.classes.length; id++) {
			if (scores[id]! > best) {
				best = scores[id]!;
				bestID = id;
			}
		}
		if (bestID < 0) return "";
		return this.classes[bestID]!;
	}
}

/** Lexicographic byte comparison of `blob[lo:hi]` against `feat[:featLen]`. */
function compare(
	blob: Uint8Array,
	lo: number,
	hi: number,
	feat: Uint8Array,
	featLen: number,
): number {
	const n = hi - lo;
	const m = n < featLen ? n : featLen;
	for (let i = 0; i < m; i++) {
		const d = blob[lo + i]! - feat[i]!;
		if (d !== 0) return d;
	}
	return n - featLen;
}

/** Lexicographic byte comparison of two ranges of the same blob. */
function compareRanges(
	blob: Uint8Array,
	aLo: number,
	aHi: number,
	bLo: number,
	bHi: number,
): number {
	const n = aHi - aLo;
	const m = bHi - bLo;
	const k = n < m ? n : m;
	for (let i = 0; i < k; i++) {
		const d = blob[aLo + i]! - blob[bLo + i]!;
		if (d !== 0) return d;
	}
	return n - m;
}

/** A sequential reader over the model's bytes. */
class Reader {
	private pos = 0;
	private readonly view: DataView;

	constructor(private readonly b: Uint8Array) {
		this.view = new DataView(b.buffer, b.byteOffset, b.byteLength);
	}

	bytes(n: number): Uint8Array {
		if (n < 0 || this.pos + n > this.b.length) {
			throw new Error(
				`truncated model: wanted ${n} bytes at offset ${this.pos}, have ${this.b.length - this.pos}`,
			);
		}
		const out = this.b.subarray(this.pos, this.pos + n);
		this.pos += n;
		return out;
	}

	u32(): number {
		const v = this.view.getUint32(this.pos, true);
		this.pos += 4;
		return v;
	}

	u16(): number {
		const v = this.view.getUint16(this.pos, true);
		this.pos += 2;
		return v;
	}

	u8(): number {
		const v = this.view.getUint8(this.pos);
		this.pos += 1;
		return v;
	}

	str16(): string {
		return decoder.decode(this.bytes(this.u16()));
	}

	/**
	 * `n` little-endian `uint32`s, copied.
	 *
	 * The copy is deliberate: the backing buffer need not be four-byte aligned,
	 * and a `Uint32Array` view onto an unaligned offset throws.
	 */
	u32s(n: number): Uint32Array {
		const out = new Uint32Array(n);
		for (let i = 0; i < n; i++) out[i] = this.u32();
		return out;
	}

	f32s(n: number): Float32Array {
		const out = new Float32Array(n);
		const b = this.bytes(n * 4);
		const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
		for (let i = 0; i < n; i++) out[i] = view.getFloat32(i * 4, true);
		return out;
	}
}

const decoder = new TextDecoder("utf-8");

/** Decodes a flat model, throwing on anything it does not recognize. */
export function unmarshal(data: Uint8Array): Model {
	const r = new Reader(data);

	if (decoder.decode(r.bytes(MAGIC.length)) !== MAGIC) {
		throw new Error("not a prose flat tagger model");
	}
	const version = r.u32();
	if (version !== VERSION) {
		throw new Error(`unsupported model version ${version} (want ${VERSION})`);
	}

	const nClasses = r.u32();
	if (nClasses > MAX_CLASSES) {
		throw new Error(`model has ${nClasses} classes, format allows ${MAX_CLASSES}`);
	}
	const classes: string[] = new Array(nClasses);
	for (let i = 0; i < nClasses; i++) classes[i] = r.str16();

	const nFeatures = r.u32();
	const nPairs = r.u32();
	const blobLen = r.u32();

	const blob = r.bytes(blobLen);
	const featOff = r.u32s(nFeatures + 1);
	const pairOff = r.u32s(nFeatures + 1);

	const classIDs = new Uint8Array(r.bytes(nPairs));
	const weights = r.f32s(nPairs);

	const nTagMap = r.u32();
	const tagMap = new Map<string, number>();
	for (let i = 0; i < nTagMap; i++) {
		const w = r.str16();
		const id = r.u8();
		if (id >= nClasses) {
			throw new Error(
				`tagMap entry ${JSON.stringify(w)} has class ID ${id}, only ${nClasses} classes`,
			);
		}
		tagMap.set(w, id);
	}

	validate(blob, featOff, pairOff, classIDs, weights, classes);
	return new Model(classes, blob, featOff, pairOff, classIDs, weights, tagMap);
}

/**
 * Checks the invariants the scoring path relies on, so a corrupt model fails
 * at load with a clear message instead of mis-tagging quietly.
 */
function validate(
	blob: Uint8Array,
	featOff: Uint32Array,
	pairOff: Uint32Array,
	classIDs: Uint8Array,
	weights: Float32Array,
	classes: readonly string[],
): void {
	const n = featOff.length - 1;
	if (pairOff.length !== n + 1) {
		throw new Error(
			`offset arrays disagree: ${n} features vs ${pairOff.length - 1} pair offsets`,
		);
	}
	if (classIDs.length !== weights.length) {
		throw new Error(
			`classIDs (${classIDs.length}) and weights (${weights.length}) differ in length`,
		);
	}
	if (n > 0) {
		if (featOff[n] !== blob.length) {
			throw new Error(
				`feature offsets end at ${featOff[n]}, blob is ${blob.length} bytes`,
			);
		}
		if (pairOff[n] !== weights.length) {
			throw new Error(
				`pair offsets end at ${pairOff[n]}, weights has ${weights.length} entries`,
			);
		}
	}
	for (const id of classIDs) {
		if (id >= classes.length) {
			throw new Error(`class ID ${id} out of range (${classes.length} classes)`);
		}
	}
	// The binary search in `feature` is only correct on sorted input.
	for (let i = 1; i < n; i++) {
		if (
			compareRanges(
				blob,
				featOff[i - 1]!,
				featOff[i]!,
				featOff[i]!,
				featOff[i + 1]!,
			) >= 0
		) {
			throw new Error(`features not sorted at index ${i}`);
		}
	}
}

import { convertIndexedToRgb, decode as decodePng, encode as encodePng } from "fast-png";
import jpeg from "jpeg-js";

/** Tightly packed 8-bit RGB. */
export interface RGB {
	width: number;
	height: number;
	data: Uint8Array;
}

export function decodeImage(bytes: Uint8Array): RGB {
	const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
	if (!isPng) {
		const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: false, maxMemoryUsageInMB: 256 });
		return { width: img.width, height: img.height, data: img.data };
	}

	const png = decodePng(bytes);
	let src: ArrayLike<number> = png.data;
	let channels = png.channels;
	if (png.palette) {
		src = convertIndexedToRgb(png);
		channels = png.transparency ? 4 : 3;
	}
	const shift = png.depth === 16 ? 8 : 0;
	const n = png.width * png.height;
	const out = new Uint8Array(n * 3);
	for (let i = 0; i < n; i++) {
		for (let c = 0; c < 3; c++) {
			// grayscale (1-2 channels) repeats the luma value into every channel
			const srcChannel = channels < 3 ? 0 : c;
			out[i * 3 + c] = src[i * channels + srcChannel] >> shift;
		}
	}
	return { width: png.width, height: png.height, data: out };
}

export function encodeRgbPng(img: RGB): Uint8Array {
	return encodePng({ width: img.width, height: img.height, data: img.data, channels: 3, depth: 8 });
}

/** Center-crop to a square, then average each block down to grid x grid pixels. */
export function boxDownscale(img: RGB, grid: number): RGB {
	const side = Math.min(img.width, img.height);
	const ox = Math.floor((img.width - side) / 2);
	const oy = Math.floor((img.height - side) / 2);
	const scale = side / grid;
	const out = new Uint8Array(grid * grid * 3);
	for (let gy = 0; gy < grid; gy++) {
		const y0 = oy + Math.floor(gy * scale);
		const y1 = Math.max(y0 + 1, oy + Math.floor((gy + 1) * scale));
		for (let gx = 0; gx < grid; gx++) {
			const x0 = ox + Math.floor(gx * scale);
			const x1 = Math.max(x0 + 1, ox + Math.floor((gx + 1) * scale));
			let r = 0, g = 0, b = 0;
			for (let y = y0; y < y1; y++) {
				for (let x = x0; x < x1; x++) {
					const i = (y * img.width + x) * 3;
					r += img.data[i];
					g += img.data[i + 1];
					b += img.data[i + 2];
				}
			}
			const count = (y1 - y0) * (x1 - x0);
			const o = (gy * grid + gx) * 3;
			out[o] = r / count;
			out[o + 1] = g / count;
			out[o + 2] = b / count;
		}
	}
	return { width: grid, height: grid, data: out };
}

/** Median-cut quantization, no dithering: every pixel takes its box's mean color. */
export function quantize(img: RGB, colors: number): RGB {
	const n = img.width * img.height;
	const d = img.data;
	let boxes: number[][] = [Array.from({ length: n }, (_, i) => i)];

	const widestChannel = (box: number[]): [number, number] => {
		let best = 0, bestRange = -1;
		for (let c = 0; c < 3; c++) {
			let lo = 255, hi = 0;
			for (const p of box) {
				const v = d[p * 3 + c];
				if (v < lo) lo = v;
				if (v > hi) hi = v;
			}
			if (hi - lo > bestRange) {
				bestRange = hi - lo;
				best = c;
			}
		}
		return [best, bestRange];
	};

	while (boxes.length < colors) {
		let target = -1, targetChannel = 0, targetRange = 0;
		boxes.forEach((box, i) => {
			if (box.length < 2) return;
			const [channel, range] = widestChannel(box);
			if (range > targetRange) {
				target = i;
				targetChannel = channel;
				targetRange = range;
			}
		});
		if (target < 0) break; // every box is a single color already
		const box = boxes[target].sort((a, b) => d[a * 3 + targetChannel] - d[b * 3 + targetChannel]);
		const mid = box.length >> 1;
		boxes = [...boxes.slice(0, target), box.slice(0, mid), box.slice(mid), ...boxes.slice(target + 1)];
	}

	const out = new Uint8Array(n * 3);
	for (const box of boxes) {
		let r = 0, g = 0, b = 0;
		for (const p of box) {
			r += d[p * 3];
			g += d[p * 3 + 1];
			b += d[p * 3 + 2];
		}
		const mr = Math.round(r / box.length), mg = Math.round(g / box.length), mb = Math.round(b / box.length);
		for (const p of box) {
			out[p * 3] = mr;
			out[p * 3 + 1] = mg;
			out[p * 3 + 2] = mb;
		}
	}
	return { width: img.width, height: img.height, data: out };
}

export function upscaleNearest(img: RGB, factor: number): RGB {
	const w = img.width * factor, h = img.height * factor;
	const out = new Uint8Array(w * h * 3);
	for (let y = 0; y < h; y++) {
		const sy = Math.floor(y / factor);
		for (let x = 0; x < w; x++) {
			const s = (sy * img.width + Math.floor(x / factor)) * 3;
			const o = (y * w + x) * 3;
			out[o] = img.data[s];
			out[o + 1] = img.data[s + 1];
			out[o + 2] = img.data[s + 2];
		}
	}
	return { width: w, height: h, data: out };
}

export const GRID = 128; // pixel-art resolution
export const OUT_SCALE = 8; // 128 * 8 = 1024px final PNG

/** AI image bytes -> crisp pixel-art grid (not upscaled). */
export function pixelGrid(bytes: Uint8Array, colors: number, grid = GRID): RGB {
	return quantize(boxDownscale(decodeImage(bytes), grid), colors);
}

/** 8-bit RGBA; alpha is 0 or 255. */
export interface RGBA {
	width: number;
	height: number;
	data: Uint8Array;
}

/**
 * A hobby item painted on a flat key colour -> the item alone on transparency, cropped and sat on the bottom edge
 * of a `size` square so every item stands on the same shelf line. The key is the most common border colour; pixels
 * near it that touch the border (and any pixel very near it anywhere, e.g. inside a guitar's handle) go clear.
 */
export function cutOut(img: RGB, size: number): RGBA {
	const { width: w, height: h, data } = img;
	const at = (x: number, y: number) => (y * w + x) * 3;
	const counts = new Map<number, number>();
	for (let x = 0; x < w; x++) for (const y of [0, h - 1]) bump(x, y);
	for (let y = 0; y < h; y++) for (const x of [0, w - 1]) bump(x, y);
	function bump(x: number, y: number) {
		const i = at(x, y);
		const k = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
		counts.set(k, (counts.get(k) ?? 0) + 1);
	}
	const key = [...counts].sort((a, b) => b[1] - a[1])[0][0];
	const kr = key >> 16, kg = (key >> 8) & 255, kb = key & 255;
	const dist = (i: number) => Math.hypot(data[i] - kr, data[i + 1] - kg, data[i + 2] - kb);
	const clear = new Uint8Array(w * h);
	const stack: number[] = [];
	for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
	for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
	while (stack.length) {
		const p = stack.pop()!;
		if (clear[p] || dist(p * 3) > 90) continue;
		clear[p] = 1;
		const x = p % w, y = (p - x) / w;
		if (x > 0) stack.push(p - 1);
		if (x < w - 1) stack.push(p + 1);
		if (y > 0) stack.push(p - w);
		if (y < h - 1) stack.push(p + w);
	}
	for (let p = 0; p < w * h; p++) if (dist(p * 3) < 45) clear[p] = 1;
	// Anti-aliasing leaves a pink rim where the object met the magenta: clear magenta-ish pixels on the edge, twice.
	const pinkish = (i: number) => data[i] > 120 && data[i + 2] > 90 && data[i + 1] < Math.min(data[i], data[i + 2]) * 0.72;
	for (let pass = 0; pass < 2; pass++) {
		const edge: number[] = [];
		for (let p = 0; p < w * h; p++) {
			if (clear[p] || !pinkish(p * 3)) continue;
			const x = p % w;
			if ((x > 0 && clear[p - 1]) || (x < w - 1 && clear[p + 1]) || (p >= w && clear[p - w]) || (p < w * (h - 1) && clear[p + w])) edge.push(p);
		}
		for (const p of edge) clear[p] = 1;
	}
	// Drop specks: keep only pieces at least 3% the size of the biggest one.
	const label = new Int32Array(w * h).fill(-1);
	const sizes: number[] = [];
	for (let p = 0; p < w * h; p++) {
		if (clear[p] || label[p] >= 0) continue;
		const n = sizes.length;
		let size = 0;
		const todo = [p];
		label[p] = n;
		while (todo.length) {
			const q = todo.pop()!;
			size++;
			const x = q % w;
			for (const r of [x > 0 ? q - 1 : -1, x < w - 1 ? q + 1 : -1, q - w, q + w]) {
				if (r >= 0 && r < w * h && !clear[r] && label[r] < 0) {
					label[r] = n;
					todo.push(r);
				}
			}
		}
		sizes.push(size);
	}
	const biggest = Math.max(0, ...sizes);
	for (let p = 0; p < w * h; p++) if (!clear[p] && sizes[label[p]] < biggest * 0.03) clear[p] = 1;
	let x0 = w, y0 = h, x1 = -1, y1 = -1;
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!clear[y * w + x]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
	const out = new Uint8Array(size * size * 4);
	if (x1 < 0) return { width: size, height: size, data: out };
	const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
	const f = Math.min(1, (size - 2) / Math.max(bw, bh)); // shrink only; never blur a pixel up
	const ow = Math.round(bw * f), oh = Math.round(bh * f);
	const ox = Math.floor((size - ow) / 2), oy = size - 1 - oh;
	for (let y = 0; y < oh; y++) {
		for (let x = 0; x < ow; x++) {
			const sx = x0 + Math.floor(x / f), sy = y0 + Math.floor(y / f);
			if (clear[sy * w + sx]) continue;
			const s = at(sx, sy), o = ((oy + y) * size + ox + x) * 4;
			out[o] = data[s]; out[o + 1] = data[s + 1]; out[o + 2] = data[s + 2]; out[o + 3] = 255;
		}
	}
	return { width: size, height: size, data: out };
}

export function upscaleNearestRgba(img: RGBA, factor: number): RGBA {
	const w = img.width * factor, h = img.height * factor;
	const out = new Uint8Array(w * h * 4);
	for (let y = 0; y < h; y++) {
		const sy = Math.floor(y / factor);
		for (let x = 0; x < w; x++) out.set(img.data.subarray((sy * img.width + Math.floor(x / factor)) * 4, (sy * img.width + Math.floor(x / factor)) * 4 + 4), (y * w + x) * 4);
	}
	return { width: w, height: h, data: out };
}

export function encodeRgbaPng(img: RGBA): Uint8Array {
	return encodePng({ width: img.width, height: img.height, data: img.data, channels: 4, depth: 8 });
}

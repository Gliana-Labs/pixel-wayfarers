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
export function pixelGrid(bytes: Uint8Array, colors: number): RGB {
	return quantize(boxDownscale(decodeImage(bytes), GRID), colors);
}

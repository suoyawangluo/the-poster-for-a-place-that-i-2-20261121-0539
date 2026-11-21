// VELMARA — a travel poster for a place that does not exist.
// Pure TypeScript, Node 22, no dependencies, no network, fully deterministic.
// Writes /output/entry.png (1024x1024, PNG, under 1 MiB).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const W = 1024;
const H = 1024;
const OUT = "/output/entry.png";

// ---------- CRC32 (PNG) ----------
const CRC_TABLE: number[] = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePNG(rgb: Uint8Array, w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // filter: none
    raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// ---------- Pixel buffer ----------
const px = new Uint8Array(W * H * 3);
type RGB = [number, number, number];
function setPx(x: number, y: number, c: RGB): void {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2];
}
function blendPx(x: number, y: number, c: RGB, a: number): void {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = Math.round(px[i] * (1 - a) + c[0] * a);
  px[i + 1] = Math.round(px[i + 1] * (1 - a) + c[1] * a);
  px[i + 2] = Math.round(px[i + 2] * (1 - a) + c[2] * a);
}
function fillRect(x0: number, y0: number, x1: number, y1: number, c: RGB): void {
  for (let y = Math.max(0, y0); y < Math.min(H, y1); y++)
    for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) setPx(x, y, c);
}
function lerp(a: RGB, b: RGB, t: number): RGB {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
}
function vGrad(y0: number, y1: number, stops: [number, RGB][]): void {
  for (let y = y0; y < y1; y++) {
    const t = (y - y0) / (y1 - y0);
    let c: RGB = stops[stops.length - 1][1];
    for (let s = 0; s < stops.length - 1; s++) {
      if (t >= stops[s][0] && t <= stops[s + 1][0]) {
        const lt = (t - stops[s][0]) / (stops[s + 1][0] - stops[s][0]);
        c = lerp(stops[s][1], stops[s + 1][1], lt);
        break;
      }
    }
    for (let x = 0; x < W; x++) setPx(x, y, c);
  }
}
function disc(cx: number, cy: number, r: number, c: RGB): void {
  for (let y = cy - r; y <= cy + r; y++)
    for (let x = cx - r; x <= cx + r; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r * r) setPx(x, y, c);
    }
}
function ellipse(cx: number, cy: number, rx: number, ry: number, c: RGB, a = 1): void {
  for (let y = cy - ry; y <= cy + ry; y++)
    for (let x = cx - rx; x <= cx + rx; x++) {
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) { if (a >= 1) setPx(x, y, c); else blendPx(x, y, c, a); }
    }
}
// Filled polygon (scanline).
function poly(pts: [number, number][], c: RGB, alpha = 1): void {
  let minY = H, maxY = 0;
  for (const [, y] of pts) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  for (let y = Math.max(0, minY); y < Math.min(H, maxY); y++) {
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % pts.length];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        xs.push(Math.round(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1)));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2)
      for (let x = Math.max(0, xs[k]); x < Math.min(W, xs[k + 1]); x++) {
        if (alpha >= 1) setPx(x, y, c); else blendPx(x, y, c, alpha);
      }
  }
}

// ---------- 5x7 bitmap font (A-Z, space, hyphen, period) ----------
const FONT: Record<string, string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "-": ["00000", "00000", "00000", "01110", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
};
function textWidth(s: string, scale: number): number {
  return s.length * 6 * scale - scale;
}
function drawText(s: string, cx: number, y: number, scale: number, c: RGB): void {
  const w = textWidth(s, scale);
  let x = cx - Math.floor(w / 2);
  for (const ch of s) {
    const g = FONT[ch] ?? FONT[" "];
    for (let r = 0; r < 7; r++)
      for (let col = 0; col < 5; col++)
        if (g[r][col] === "1") fillRect(x + col * scale, y + r * scale, x + (col + 1) * scale, y + (r + 1) * scale, c);
    x += 6 * scale;
  }
}
function drawTextOutlined(s: string, cx: number, y: number, scale: number, c: RGB, o: RGB): void {
  const d = Math.max(1, Math.floor(scale / 6));
  drawText(s, cx - d, y, scale, o); drawText(s, cx + d, y, scale, o);
  drawText(s, cx, y - d, scale, o); drawText(s, cx, y + d, scale, o);
  drawText(s, cx - d, y - d, scale, o); drawText(s, cx + d, y + d, scale, o);
  drawText(s, cx, y, scale, c);
}

// ---------- Poster: VELMARA, Isle of Glass Tides ----------
const CREAM: RGB = [246, 231, 193];
const INK: RGB = [24, 38, 63];
const GOLD: RGB = [255, 233, 163];

fillRect(0, 0, W, H, CREAM);
// Sky inside the frame.
vGrad(36, 620, [
  [0, [34, 56, 107]],
  [0.42, [78, 127, 168]],
  [0.72, [233, 160, 92]],
  [1, [247, 200, 115]],
]);
// Sun + halo (smaller, clear of the tagline).
disc(748, 306, 104, [255, 214, 130]);
disc(748, 306, 84, GOLD);
disc(748, 306, 70, [255, 240, 190]);
// Clouds (kept clear of the title).
ellipse(170, 330, 95, 20, [255, 238, 205], 0.8);
ellipse(880, 420, 110, 22, [255, 226, 180], 0.8);
// Birds.
for (const [bx, by, s] of [[300, 300, 14], [360, 280, 11], [830, 180, 12]] as const) {
  poly([[bx - s, by], [bx, by + 7], [bx - s / 2, by + 2]], INK);
  poly([[bx + s, by], [bx, by + 7], [bx + s / 2, by + 2]], INK);
}
// Far mountains (left + right, framing the sun path).
poly([[36, 620], [36, 520], [180, 470], [300, 540], [430, 500], [470, 620]], [58, 74, 122]);
poly([[988, 620], [988, 500], [860, 452], [740, 530], [640, 492], [600, 620]], [48, 64, 110]);
// Near green headlands.
poly([[36, 620], [36, 580], [200, 556], [360, 596], [420, 620]], [46, 107, 94]);
poly([[988, 620], [988, 572], [820, 548], [660, 592], [620, 620]], [38, 96, 86]);
// Sea.
vGrad(620, 880, [[0, [47, 138, 150]], [0.55, [28, 96, 116]], [1, [18, 62, 82]]]);
// Sun path on the water: sparse, tapering dashes.
for (let i = 0; i < 15; i++) {
  const y = 630 + i * 15;
  const wHalf = 18 + ((i * 53) % 46);
  const a = 0.42 - i * 0.022;
  if (a <= 0.05) break;
  for (let x = 748 - wHalf; x < 748 + wHalf; x++) blendPx(x, y, [255, 220, 150], a);
  for (let x = 748 - wHalf; x < 748 + wHalf; x++) blendPx(x, y + 1, [255, 220, 150], a * 0.6);
}
// Wave lines.
for (const [wy, x0, x1] of [[668, 80, 420], [700, 620, 950], [742, 120, 380], [790, 640, 940], [836, 90, 330]] as const) {
  for (let x = x0; x < x1; x += 3) setPx(x, wy, [190, 230, 225]);
}
// Central island with the Glass Lighthouse (the landmark).
ellipse(512, 716, 150, 26, [30, 84, 72]);
ellipse(512, 706, 120, 18, [46, 110, 88]);
// Lighthouse tower: tapered glass tower.
poly([[486, 706], [498, 540], [526, 540], [538, 706]], [191, 239, 242]);
poly([[492, 706], [500, 560], [512, 560], [512, 706]], [225, 247, 248]);
poly([[486, 640], [538, 640], [536, 622], [488, 622]], [120, 190, 205]);
poly([[486, 590], [538, 590], [536, 576], [488, 576]], [120, 190, 205]);
// Lantern room + dome.
fillRect(496, 512, 528, 540, [255, 214, 130]);
poly([[492, 512], [532, 512], [512, 486]], [255, 190, 90]);
disc(512, 526, 6, [255, 246, 200]);
// Light beams from the lantern (narrow, faint).
poly([[512, 526], [260, 498], [260, 548]], [255, 233, 160], 0.16);
poly([[512, 526], [770, 498], [770, 548]], [255, 233, 160], 0.16);
// Island reflection.
ellipse(512, 742, 110, 12, [191, 239, 242], 0.35);
ellipse(512, 768, 70, 8, [191, 239, 242], 0.25);
// Lantern boats.
function boat(bx: number, by: number, s: number, flip: boolean): void {
  const dir = flip ? -1 : 1;
  poly([[bx - 34 * s, by], [bx + 34 * s, by], [bx + 22 * s, by + 12 * s], [bx - 22 * s, by + 12 * s]], [24, 38, 63]);
  poly([[bx, by - 2], [bx, by - 44 * s], [bx + 26 * s * dir, by - 2]], [246, 231, 193]);
  disc(bx + 30 * s * dir, by - 8, 5, [255, 190, 90]);
  disc(bx + 30 * s * dir, by - 8, 3, [255, 240, 190]);
}
boat(230, 760, 1, false);
boat(800, 800, 1, true);
// Title + tagline (set into the sky, above the horizon).
drawTextOutlined("VELMARA", 512, 78, 13, [255, 243, 214], INK);
drawTextOutlined("ISLE OF GLASS TIDES", 512, 200, 4, [255, 243, 214], INK);
// Decorative rule under the tagline.
fillRect(340, 242, 684, 246, [255, 243, 214]);
// Bottom band: the promise of a stay.
fillRect(36, 880, 988, 988, INK);
fillRect(36, 880, 988, 884, [255, 214, 130]);
drawText("LANTERN BOATS LEAVE AT DUSK", 512, 912, 4, CREAM);
drawText("STAY FOR THE GLASS TIDE", 512, 948, 3, [255, 214, 130]);
// Inner frame line.
for (let x = 36; x < 988; x++) { setPx(x, 40, INK); setPx(x, 984, INK); }
for (let y = 36; y < 988; y++) { setPx(40, y, INK); setPx(984, y, INK); }

mkdirSync("/output", { recursive: true });
const png = encodePNG(px, W, H);
writeFileSync(OUT, png);
// Output check: read the file back and verify PNG signature, size and dimensions.
const back = readFileSync(OUT);
const sigOk = back[0] === 137 && back[1] === 80 && back[2] === 78 && back[3] === 71;
const wOk = back.readUInt32BE(16) === W;
const hOk = back.readUInt32BE(20) === H;
const sizeOk = back.length <= 1048576;
if (!sigOk || !wOk || !hOk || !sizeOk) {
  throw new Error(`output check failed: sig=${sigOk} ${W}x${H} ok=${wOk}/${hOk} bytes=${back.length} sizeOk=${sizeOk}`);
}
console.log(`wrote ${OUT} ${png.length} bytes ${W}x${H} (verified: PNG sig ok, ${back.length} bytes)`);

import type { Scene, SceneText } from '../render/geometry.ts';
import { KIND } from '../render/geometry.ts';
import type { SnapIndex } from '../measure/snap.ts';
import type { Highlight } from '../render/overlay.ts';
import { plainText } from '../render/textlayer.ts';
import type { LoadedInfo } from '../jww/worker.ts';
import { hex1, layerStateName, lineTypeName } from '../jww/names.ts';
import { formatLength } from '../measure/measure.ts';

/** 図形の種類の呼び名 */
const KIND_LABEL: Record<number, string> = {
  [KIND.line]: '線',
  [KIND.arc]: '円弧',
  [KIND.circle]: '円',
  [KIND.text]: '文字',
  [KIND.solid]: 'ソリッド',
  [KIND.point]: '点',
  [KIND.dim]: '寸法線',
  [KIND.dimText]: '寸法値',
  [KIND.dimAux]: '寸法補助線',
};

/** 線種に意味がある図形 */
const HAS_LINE_TYPE = new Set<number>([KIND.line, KIND.arc, KIND.circle, KIND.dim, KIND.dimAux]);

/** 文字の矩形（回転を考慮）に点が入っているか。pad だけ外側に甘く取る */
export function textContains(t: SceneText, x: number, y: number, pad: number): boolean {
  const a = (t.angle * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const dx = x - t.x;
  const dy = y - t.y;
  const u = dx * cos + dy * sin;
  const v = -dx * sin + dy * cos;
  return u >= -pad && u <= t.width + pad && v >= -pad && v <= t.height + pad;
}

/** 文字の四隅 [x0,y0, x1,y1, x2,y2, x3,y3] */
export function textCorners(t: SceneText): number[] {
  const a = (t.angle * Math.PI) / 180;
  const ux = Math.cos(a), uy = Math.sin(a);
  const vx = -uy, vy = ux;
  return [
    t.x, t.y,
    t.x + ux * t.width, t.y + uy * t.width,
    t.x + ux * t.width + vx * t.height, t.y + uy * t.width + vy * t.height,
    t.x + vx * t.height, t.y + vy * t.height,
  ];
}

function inTriangle(
  px: number, py: number,
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number,
): boolean {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/**
 * タップした位置にある図形を拾う。見えていない色・レイヤの図形は拾わない。
 * 線のすぐ近くなら線、文字の上なら文字、そうでなければ少し離れた線・点、最後に塗りの中、の順。
 * 塗りを最後にするのは、柱のように塗りの上に線や文字が載っているのが普通だから。
 */
export function pickEntity(
  scene: Scene,
  index: SnapIndex,
  x: number, y: number, radius: number,
  visible: (color: number, layer: number) => boolean,
): number {
  const near = index.nearestLine(x, y, radius);
  if (near.index >= 0 && near.dist <= radius * 0.35) return scene.lineEntity[near.index];

  // 文字は小さいものを優先する（大きな表題が手前の細かい文字を覆い隠さないように）
  let textHit = -1;
  let textArea = Infinity;
  const pad = radius * 0.15;
  for (let i = 0; i < scene.texts.length; i++) {
    const t = scene.texts[i];
    if (!visible(t.color, t.layer)) continue;
    if (!textContains(t, x, y, pad)) continue;
    const area = t.width * t.height;
    if (area < textArea) {
      textArea = area;
      textHit = i;
    }
  }
  if (textHit >= 0) return scene.texts[textHit].entity;

  if (near.index >= 0) return scene.lineEntity[near.index];

  const pt = index.nearestPoint(x, y, radius * 0.6);
  if (pt >= 0) return scene.snapPointEntity[pt];

  const tri = scene.triPos;
  for (let i = tri.length / 6 - 1; i >= 0; i--) {
    // 後から描かれた塗りほど手前にあるので、後ろから見る
    if (!visible(scene.triColor[i * 3], scene.triLayer[i * 3])) continue;
    if (inTriangle(x, y, tri[i * 6], tri[i * 6 + 1], tri[i * 6 + 2], tri[i * 6 + 3], tri[i * 6 + 4], tri[i * 6 + 5])) {
      return scene.triEntity[i];
    }
  }
  return -1;
}

export function entityShape(scene: Scene, i: number): Highlight {
  const e = scene.entities;
  const ls = e.lineStart[i], lc = e.lineCount[i];
  const ts = e.triStart[i], tc = e.triCount[i];
  const ti = e.text[i];
  let point: [number, number] | null = null;
  if (e.kind[i] === KIND.point) {
    for (let k = 0; k < scene.snapPointEntity.length; k++) {
      if (scene.snapPointEntity[k] === i) {
        point = [scene.snapPoint[k * 2], scene.snapPoint[k * 2 + 1]];
        break;
      }
    }
  }
  return {
    lines: scene.linePos.subarray(ls * 4, (ls + lc) * 4),
    tris: scene.triPos.subarray(ts * 6, (ts + tc) * 6),
    box: ti >= 0 && scene.texts[ti] ? textCorners(scene.texts[ti]) : null,
    point,
  };
}

export interface EntityRow {
  label: string;
  /** そのまま HTML として差し込む（呼び出し側で値はエスケープ済み） */
  html: string;
}

export interface EntityDescription {
  kind: string;
  layer: number;
  rows: EntityRow[];
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

function formatScale(scale: number): string {
  if (!Number.isFinite(scale) || scale <= 0) return '1';
  return Number.isInteger(scale) ? String(scale) : scale.toFixed(3).replace(/0+$/, '');
}

/** 楕円（縦横の半径が違う円・円弧）か */
function isEllipse(e: Scene['entities'], i: number): boolean {
  const a = e.size[i];
  const b = e.size2[i];
  return a > 0 && Math.abs(a - b) > a * 1e-6;
}

/** 図形の種類の呼び名。楕円は円と分けて呼ぶ */
export function kindLabel(scene: Scene, i: number): string {
  const e = scene.entities;
  const kind = e.kind[i];
  if (kind === KIND.circle && isEllipse(e, i)) return '楕円';
  if (kind === KIND.arc && isEllipse(e, i)) return '楕円弧';
  return KIND_LABEL[kind] ?? '図形';
}

/**
 * 図形の属性を、画面に並べる行の形で返す。
 * 長さや半径は、その図形の縮尺（寸法は寸法そのもののレイヤグループ）を掛けた実寸で出す。
 * swatch は色番号から見本の style（--ink と --paper）を返す（いまの背景に合わせた色）。
 */
export function describeEntity(
  scene: Scene,
  info: LoadedInfo,
  i: number,
  swatch: (color: number) => string,
): EntityDescription {
  const e = scene.entities;
  const kind = e.kind[i];
  const layer = e.layer[i];
  const g = layer >> 4;
  const l = layer & 15;
  const group = info.groups[g];
  const scale = scene.scales[e.group[i]] || 1;
  const rows: EntityRow[] = [];

  // レイヤ
  const gName = group?.name?.trim() || `グループ ${hex1(g)}`;
  const lInfo = group?.layers[l];
  const lName = lInfo?.name?.trim() || `レイヤ ${hex1(l)}`;
  const jw = lInfo && lInfo.state === 0 ? `<span class="lflag">Jw で${layerStateName(0)}</span>` : '';
  rows.push({
    label: 'レイヤ',
    html: `<span class="lno">${hex1(g)}</span>${escapeHtml(gName)}`
      + `<span class="sep">›</span><span class="lno">${hex1(l)}</span>${escapeHtml(lName)}${jw}`,
  });

  // 線色と線種
  const color = e.color[i];
  const groupIndex = scene.colorGroup[color];
  const colorName = scene.groups[groupIndex]?.label ?? `線色${e.pen[i]}`;
  const rgb = e.rgb[i];
  const custom = rgb >= 0
    ? ` <span class="sub">(${rgb & 255}, ${(rgb >> 8) & 255}, ${(rgb >> 16) & 255})</span>`
    : '';
  let penHtml = `<span class="dot" style="${swatch(color)}"></span>${escapeHtml(colorName)}${custom}`;
  if (HAS_LINE_TYPE.has(kind)) {
    penHtml += `<span class="sep">／</span>${escapeHtml(lineTypeName(e.style[i], info.sxfLineTypeNames))}`;
  }
  rows.push({ label: kind === KIND.text || kind === KIND.dimText ? '文字色' : '線色', html: penHtml });

  // 寸法
  const real = (v: number): string => formatLength(v * scale);
  const scaleNote = `<span class="sub">1/${formatScale(scale)}</span>`;
  const size = e.size[i];
  switch (kind) {
    case KIND.line:
      rows.push({ label: '長さ', html: `${real(size)} ${scaleNote}` });
      break;
    case KIND.arc:
    case KIND.circle:
      if (isEllipse(e, i)) {
        rows.push({ label: '長径', html: `${real(size * 2)}<span class="sep">／</span>短径 ${real(e.size2[i] * 2)} ${scaleNote}` });
      } else if (kind === KIND.circle) {
        rows.push({ label: '半径', html: `${real(size)}<span class="sep">／</span>直径 ${real(size * 2)} ${scaleNote}` });
      } else {
        rows.push({ label: '半径', html: `${real(size)} ${scaleNote}` });
      }
      if (kind === KIND.arc) rows.push({ label: '円弧の長さ', html: real(e.length[i]) });
      break;
    case KIND.solid:
      if (size > 0) rows.push({ label: '半径', html: `${real(size)} ${scaleNote}` });
      break;
    case KIND.text: {
      const t = scene.texts[e.text[i]];
      if (t) rows.push({ label: '文字', html: escapeHtml(plainText(t.text)) });
      rows.push({ label: '文字の高さ', html: `${size.toFixed(2)} mm <span class="sub">図面上</span>` });
      break;
    }
    case KIND.dim:
    case KIND.dimText: {
      const t = scene.texts[e.text[i]];
      if (t) rows.push({ label: '寸法値', html: escapeHtml(plainText(t.text)) });
      rows.push({ label: '寸法線の長さ', html: `${real(size)} ${scaleNote}` });
      break;
    }
    case KIND.dimAux: {
      const t = scene.texts[e.text[i]];
      if (t) rows.push({ label: '寸法値', html: escapeHtml(plainText(t.text)) });
      rows.push({ label: '長さ', html: `${real(size)} ${scaleNote}` });
      break;
    }
    default:
      break;
  }

  // 部品
  const block = e.block[i];
  if (block >= 0) rows.push({ label: '部品', html: escapeHtml(scene.blockNames[block] ?? '') });

  return { kind: kindLabel(scene, i), layer, rows };
}

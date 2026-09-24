import { Reader } from './reader.ts';
import { parseHeader } from './header.ts';
import type {
  JwwArc, JwwBlockDef, JwwBlockRef, JwwCommon, JwwDim, JwwDocument,
  JwwEntities, JwwLine, JwwPoint, JwwSolid, JwwText,
} from './types.ts';
import { emptyEntities } from './types.ts';

/**
 * CArchive のオブジェクトマップ。
 * MFC は新規クラスと新規オブジェクトの双方でマップ番号を消費するため、
 * クラス参照タグの番号は「そのクラスが最初に現れた時点の番号」で固定される。
 */
interface Ctx {
  version: number;
  classes: Map<number, string>;
  mapCount: number;
  warnings: string[];
}

const NULL_CLASS = '';

/** オブジェクトの先頭タグを読み、クラス名を返す */
function readClassTag(r: Reader, ctx: Ctx): string {
  const wTag = r.u16();
  if (wTag === 0x0000) return NULL_CLASS;

  if (wTag === 0xffff) {
    // 新クラス: スキーマ番号 + 名前長 + 名前
    r.u16(); // schema
    const len = r.u16();
    const name = r.ascii(len);
    ctx.classes.set(ctx.mapCount, name);
    ctx.mapCount += 2; // クラス登録 + 直後のオブジェクト登録
    return name;
  }

  let index: number;
  if (wTag === 0x7fff) {
    // ビッグタグ: 続く DWORD が本体
    const dw = r.u32();
    if (!(dw & 0x80000000)) {
      throw new Error(`未対応: オブジェクト参照タグ 0x${dw.toString(16)} @${r.pos}`);
    }
    index = dw & 0x7fffffff;
  } else if (wTag & 0x8000) {
    index = wTag & 0x7fff;
  } else {
    throw new Error(`未対応: オブジェクト参照タグ 0x${wTag.toString(16)} @${r.pos}`);
  }

  const name = ctx.classes.get(index);
  if (name === undefined) {
    throw new Error(`未知のクラス番号 ${index} @${r.pos}`);
  }
  ctx.mapCount += 1; // オブジェクト登録
  return name;
}

/** CData（全図形共通部） */
function readCommon(r: Reader, ctx: Ctx): JwwCommon {
  const group = r.u32();
  const penStyle = r.u8();
  const penColor = r.u16();
  const penWidth = ctx.version >= 351 ? r.u16() : 1;
  const layer = r.u16();
  const glayer = r.u16();
  const flag = r.u16();
  return { group, penStyle, penColor, penWidth, layer, glayer, flag };
}

function readLine(r: Reader, ctx: Ctx): JwwLine {
  const c = readCommon(r, ctx);
  return { ...c, x1: r.f64(), y1: r.f64(), x2: r.f64(), y2: r.f64() };
}

function readArc(r: Reader, ctx: Ctx): JwwArc {
  const c = readCommon(r, ctx);
  return {
    ...c,
    cx: r.f64(), cy: r.f64(),
    radius: r.f64(),
    startAngle: r.f64(),
    arcAngle: r.f64(),
    tilt: r.f64(),
    flatness: r.f64(),
    isCircle: r.u32() !== 0,
  };
}

function readPoint(r: Reader, ctx: Ctx): JwwPoint {
  const c = readCommon(r, ctx);
  const p: JwwPoint = { ...c, x: r.f64(), y: r.f64(), temporary: r.u32() !== 0 };
  if (c.penStyle === 100) {
    p.code = r.u32();
    p.angle = r.f64();
    p.scale = r.f64();
  }
  return p;
}

function readText(r: Reader, ctx: Ctx): JwwText {
  const c = readCommon(r, ctx);
  return {
    ...c,
    x1: r.f64(), y1: r.f64(), x2: r.f64(), y2: r.f64(),
    fontType: r.u32(),
    sizeX: r.f64(), sizeY: r.f64(),
    spacing: r.f64(),
    angle: r.f64(),
    fontName: r.str(),
    text: r.str(),
  };
}

function readSolid(r: Reader, ctx: Ctx): JwwSolid {
  const c = readCommon(r, ctx);
  // 格納順は 第1点 -> 第4点 -> 第2点 -> 第3点
  const x1 = r.f64(), y1 = r.f64();
  const x4 = r.f64(), y4 = r.f64();
  const x2 = r.f64(), y2 = r.f64();
  const x3 = r.f64(), y3 = r.f64();
  const s: JwwSolid = { ...c, x1, y1, x2, y2, x3, y3, x4, y4 };
  if (c.penColor === 10) s.rgb = r.u32();
  return s;
}

function readDim(r: Reader, ctx: Ctx): JwwDim {
  const c = readCommon(r, ctx);
  const line = readLine(r, ctx);
  const text = readText(r, ctx);
  const dim: JwwDim = { ...c, line, text, sxfMode: 0 };
  if (ctx.version >= 420) {
    dim.sxfMode = r.u16();
    dim.extras = {
      aux1: readLine(r, ctx),
      aux2: readLine(r, ctx),
      arrow1: readPoint(r, ctx),
      arrow2: readPoint(r, ctx),
      base1: readPoint(r, ctx),
      base2: readPoint(r, ctx),
    };
  }
  return dim;
}

function readBlockRef(r: Reader, ctx: Ctx): JwwBlockRef {
  const c = readCommon(r, ctx);
  return {
    ...c,
    x: r.f64(), y: r.f64(),
    scaleX: r.f64(), scaleY: r.f64(),
    angle: r.f64(),
    defNo: r.u32(),
  };
}

/**
 * ブロック定義（CDataList）のヘッダ部。
 * 実体のリストは呼び出し側が続けて読む。
 */
function readBlockDefHead(r: Reader, ctx: Ctx): Omit<JwwBlockDef, 'entities'> {
  readCommon(r, ctx);
  const no = r.u32();
  const referred = r.u32() !== 0;
  const time = r.u32(); // CTime。VC6 系の 32bit time_t
  const name = r.str();
  return { no, referred, time, name };
}

/** 1 オブジェクトを読み、entities に追加する */
function readEntity(r: Reader, ctx: Ctx, out: JwwEntities, className: string): void {
  switch (className) {
    case 'CDataSen': out.lines.push(readLine(r, ctx)); break;
    case 'CDataEnko': out.arcs.push(readArc(r, ctx)); break;
    case 'CDataTen': out.points.push(readPoint(r, ctx)); break;
    case 'CDataMoji': out.texts.push(readText(r, ctx)); break;
    case 'CDataSolid': out.solids.push(readSolid(r, ctx)); break;
    case 'CDataSunpou': out.dims.push(readDim(r, ctx)); break;
    case 'CDataBlock': out.blocks.push(readBlockRef(r, ctx)); break;
    default:
      throw new Error(`未対応のクラス "${className}" @${r.pos}`);
  }
}

export function parseJww(buffer: ArrayBuffer): JwwDocument {
  const r = new Reader(buffer);
  const header = parseHeader(r);
  const ctx: Ctx = {
    version: header.version,
    classes: new Map(),
    mapCount: 1,
    warnings: [],
  };

  const entities = emptyEntities();
  const blockDefs = new Map<number, JwwBlockDef>();

  // 図形データリスト
  const count = r.count();
  for (let i = 0; i < count; i++) {
    const cls = readClassTag(r, ctx);
    if (cls === NULL_CLASS) continue;
    readEntity(r, ctx, entities, cls);
  }

  // ブロックデータ定義部のリスト
  if (r.rest > 0) {
    const defCount = r.count();
    for (let i = 0; i < defCount; i++) {
      const cls = readClassTag(r, ctx);
      if (cls === NULL_CLASS) continue;
      if (cls !== 'CDataList') {
        throw new Error(`ブロック定義リストに "${cls}" が現れました @${r.pos}`);
      }
      const head = readBlockDefHead(r, ctx);
      const inner = emptyEntities();
      const n = r.count();
      for (let k = 0; k < n; k++) {
        const c2 = readClassTag(r, ctx);
        if (c2 === NULL_CLASS) continue;
        readEntity(r, ctx, inner, c2);
      }
      blockDefs.set(head.no, { ...head, entities: inner });
    }
  }

  // Jw_cad は最後に 4 バイトの 0 を書く。それ以外が残っていたら読み損ねている。
  if (r.rest === 4 && r.u32() === 0) {
    // 正常な終端
  } else if (r.pos !== r.length) {
    ctx.warnings.push(`末尾に未読の ${r.length - r.pos} バイトが残りました`);
  }

  return { header, entities, blockDefs, warnings: ctx.warnings };
}

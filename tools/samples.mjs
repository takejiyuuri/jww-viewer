// 検証に使う図面を決める。samples/ は公開リポジトリに入れない実務の図面なので、
// 図面の名前はコードに書かず、引数・環境変数 JWW_SAMPLE・samples/ の中身から選ぶ。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const samplesDir = path.join(root, 'samples');

/** フォルダの中で、名前が re に合うものを名前順に返す（フォルダがなければ空） */
function listDir(dir, re) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((f) => re.test(f)).sort().map((f) => path.join(dir, f));
}

/** samples/ にある .jww を名前順に返す */
export function listSamples() {
  return listDir(samplesDir, /\.jww$/i);
}

/** e2e が既定で開く図面。環境変数 JWW_SAMPLE、なければ samples/ の名前順で最初の .jww */
export function defaultSample() {
  if (process.env.JWW_SAMPLE) return path.resolve(process.env.JWW_SAMPLE);
  const first = listSamples()[0];
  if (!first) {
    console.error('図面がありません。samples/ に .jww を置くか、引数か環境変数 JWW_SAMPLE で図面のパスを渡してください');
    process.exit(1);
  }
  return first;
}

/** 名前の * と ? を展開する。Windows の npm はスクリプトを cmd.exe で動かし、samples/*.jww を展開しないため */
function expand(arg) {
  const name = path.basename(arg);
  if (!/[*?]/.test(name)) return [arg];
  const pattern = name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return listDir(path.dirname(arg), new RegExp(`^${pattern}$`, 'i'));
}

/**
 * 検証スクリプトが読む図面。引数があればそれ（* を含む名前は展開する）、なければ samples/ の .jww すべて。
 * 1 つもなければ、何も確かめないまま合格にしないよう、ここで止める。
 */
export function sampleFiles(args = process.argv.slice(2)) {
  const files = args.length ? args.flatMap(expand) : listSamples();
  if (files.length === 0) {
    console.error(args.length
      ? `図面が見つかりません: ${args.join(' ')}`
      : '図面がありません。samples/ に .jww を置くか、図面のパスを引数で渡してください');
    process.exit(1);
  }
  return files;
}

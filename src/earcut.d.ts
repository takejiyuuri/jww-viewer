// earcut（ISC）の型。穴のある多角形を三角形に分ける
declare module 'earcut' {
  /** data は [x, y, ...]、holeIndices は穴の始まりの頂点番号。戻り値は三角形の頂点番号の並び */
  export default function earcut(data: ArrayLike<number>, holeIndices?: ArrayLike<number> | null, dim?: number): number[];
}

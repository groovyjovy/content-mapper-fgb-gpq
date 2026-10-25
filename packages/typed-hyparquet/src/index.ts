// hyparquet の薄いラッパー。読み方（列・行の条件・row group）から、戻り値の型を計算する。
//
// 型の材料は geoparquet-content-mapper が Parquet のフッタから作る 2 つ:
//   Row       … 列の型（スキーマから）
//   RowGroups … row group ごとの統計（null があるか、全行が同じ値か）
//
//   RowCounts … row group ごとの行数
//
//   import type { Row, RowGroups, RowCounts } from "./data/facilities.parquet";
//   const read = readParquet<Row, RowGroups, RowCounts>();
//   const rows = await read(file, { columns: ["name"], filter: { ward: "南区" }, rowGroups: [5] });
//
// 戻り値の型は「row group ごとに狭めた行の型」の union。row group を選ぶ・条件で絞るたびに
// union のメンバーが減ったり、各列の型が狭まったりする。
//
// 値の形は hyparquet の既定（geoparquet: true, utf8: true）に合わせてあるので、
// それを変えるオプション（geoparquet, utf8, rowFormat など）は受け付けない。
import { parquetMetadataAsync, parquetReadObjects } from "hyparquet";
import type { AsyncBuffer, Compressors, FileMetaData, ParquetQueryFilter } from "hyparquet";

// --- 型のユーティリティ ----------------------------------------------------------

/** ホバーで中身が展開されて見えるようにする */
type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** union の各メンバーに Pick する（ふつうの Pick は union をまとめてしまう） */
type DistributivePick<T, K extends PropertyKey> = T extends unknown ? Simplify<Pick<T, K & keyof T>> : never;

/** どれかの列が never になった行は「ありえない行」なので消す */
type DropImpossible<T> = T extends unknown ? ({ [K in keyof T]: [T[K]] extends [never] ? K : never }[keyof T] extends never ? T : never) : never;

// --- row group の統計で狭める -------------------------------------------------------

/** mapper が書き出す、1 つの row group の統計（列名 → 統計） */
export type RowGroupStats = { [column: string]: { nulls?: "none" | "all"; value?: unknown } };

/**
 * 1 つの列を統計で狭める
 * - nulls: "none" → null を除く
 * - nulls: "all"  → null だけ
 * - value: V      → V だけ（全行が同じ値）
 */
type NarrowByStats<T, S> =
  S extends { nulls: "all" } ? Extract<T, null>
  : (S extends { value: infer V } ? V | Extract<T, null> : T) extends infer U
    ? S extends { nulls: "none" } ? Exclude<U, null> : U
  : never;

/** 1 つの row group の行の型 */
export type RowOfGroup<Row, G> = Simplify<{ [K in keyof Row]: K extends keyof G ? NarrowByStats<Row[K], G[K]> : Row[K] }>;

/** row group 番号の union。RowGroups がタプルでなければ（統計なし）number */
export type GroupIndex<RGs extends readonly unknown[]> = number extends RGs["length"]
  ? number
  : { [I in keyof RGs]: I extends `${infer N extends number}` ? N : never }[number];

/** 選んだ row group の行の型の union。同じ統計の row group は同じ型になり、union の中で 1 つにまとまる */
type RowsOfGroups<Row, RGs extends readonly unknown[], I extends number> = I extends unknown ? RowOfGroup<Row, RGs[I]> : never;

// --- 行の条件（filter） ---------------------------------------------------------------
// hyparquet の matchFilter と同じ規則で狭める:
//   値そのもの / $eq / $in … その値だけ（列の候補にない値なら、その行はありえない）
//   $gt / $gte / $lt / $lte … null の行は外れる
//   $ne: null              … null の行は外れる
//   $and … 順に適用、$or … それぞれ適用した結果の union、$nor … 狭めない
// 入れ子の struct の列は "bbox.xmin" のようにドットでつないで指定できる（狭めるのは最上位の列だけ）。

type Scalar = string | number | bigint | boolean | Date | null;

type Operators<T> = {
  $eq?: T;
  $ne?: T;
  $in?: readonly T[];
  $nin?: readonly T[];
  $gt?: NonNullable<T>;
  $gte?: NonNullable<T>;
  $lt?: NonNullable<T>;
  $lte?: NonNullable<T>;
  $not?: Operators<T>;
};

type Condition<T> = [T] extends [Scalar] ? T | Operators<T> : never;

/** struct なら中身の型、それ以外（list / map / Date / ジオメトリなど）は never */
type StructOf<T> =
  Exclude<T, null | undefined> extends infer S
    ? S extends readonly unknown[] | Date | Uint8Array ? never
    : S extends { type: string; coordinates: unknown } | { type: "GeometryCollection" } ? never
    : S extends object ? (string extends keyof S ? never : S)
    : never
  : never;

/** [ドット区切りの列名, 値の型] の union（struct は 3 段まで） */
type PathEntries<T, P extends string = "", D extends unknown[] = []> = D["length"] extends 3
  ? never
  : {
      [K in keyof T & string]:
        | [`${P}${K}`, Exclude<T[K], undefined>]
        | ([StructOf<T[K]>] extends [never] ? never : PathEntries<StructOf<T[K]>, `${P}${K}.`, [...D, 1]>);
    }[keyof T & string];

type ColumnFilter<Row> = { [E in PathEntries<Row> as E[0]]?: Condition<E[1]> };

/** 列名と値の型をチェックする filter の型 */
export type Filter<Row> =
  | ColumnFilter<Row>
  | { $and: readonly Filter<Row>[] }
  | { $or: readonly Filter<Row>[] }
  | { $nor: readonly Filter<Row>[] };

/** 候補 V のうち、列の型 T に入りうるものだけ残す（T が string でも V が "駅" なら "駅"） */
type Candidates<T, V> = V extends T ? V : never;

type NarrowByCondition<T, C> =
  C extends { $eq: infer V } ? Candidates<T, V>
  : C extends { $in: readonly (infer V)[] } ? Candidates<T, V>
  : C extends { $gt: unknown } | { $gte: unknown } | { $lt: unknown } | { $lte: unknown } ? Exclude<T, null>
  : C extends { $ne: null } ? Exclude<T, null>
  : C extends Scalar ? Candidates<T, C>
  : T;

type ApplyColumns<Rows, F> = DropImpossible<
  Rows extends unknown ? Simplify<{ [K in keyof Rows]: K extends keyof F ? NarrowByCondition<Rows[K], F[K]> : Rows[K] }> : never
>;

type ApplyAll<Rows, Fs> = Fs extends readonly [infer F, ...infer Rest] ? ApplyAll<ApplyFilter<Rows, F>, Rest> : Rows;
type ApplyAny<Rows, Fs> = { [I in keyof Fs]: ApplyFilter<Rows, Fs[I]> }[number & keyof Fs];

type ApplyFilter<Rows, F> =
  F extends { $and: infer Fs } ? ApplyAll<Rows, Fs>
  : F extends { $or: infer Fs } ? ApplyAny<Rows, Fs>
  : F extends { $nor: unknown } ? Rows
  : ApplyColumns<Rows, F>;

// --- 行数（型の上での足し算） -------------------------------------------------------------
// 10 進数の文字列として 1 桁ずつ足す（タプルの長さで足すと 1 万程度で上限に当たるため）。

type DigitValue = { "0": 0; "1": 1; "2": 2; "3": 3; "4": 4; "5": 5; "6": 6; "7": 7; "8": 8; "9": 9 };
type Digit = keyof DigitValue;
type Tuple<N extends number, T extends 0[] = []> = T["length"] extends N ? T : Tuple<N, [...T, 0]>;
type Reverse<S extends string> = S extends `${infer H}${infer R}` ? `${Reverse<R>}${H}` : "";
type HeadDigit<S extends string> = S extends `${infer H extends Digit}${string}` ? DigitValue[H] : 0;
type Tail<S extends string> = S extends `${Digit}${infer R}` ? R : "";

/** 下の桁から並べた（逆順の）10 進数どうしを足す */
type AddReversed<A extends string, B extends string, Carry extends 0 | 1 = 0> = [A, B] extends ["", ""]
  ? Carry extends 1 ? "1" : ""
  : `${[...Tuple<HeadDigit<A>>, ...Tuple<HeadDigit<B>>, ...Tuple<Carry>]["length"] & number}` extends `1${infer D extends Digit}`
    ? `${D}${AddReversed<Tail<A>, Tail<B>, 1>}`
    : `${[...Tuple<HeadDigit<A>>, ...Tuple<HeadDigit<B>>, ...Tuple<Carry>]["length"] & number}${AddReversed<Tail<A>, Tail<B>, 0>}`;

export type Add<A extends number, B extends number> =
  Reverse<AddReversed<Reverse<`${A}`>, Reverse<`${B}`>>> extends `${infer N extends number}` ? N : never;

/** Counts のうち、添字 Is の行数を足す */
type SumOf<Counts extends readonly number[], Is extends readonly number[], Acc extends number = 0> =
  Is extends readonly [infer I extends number, ...infer Rest extends readonly number[]] ? SumOf<Counts, Rest, Add<Acc, Counts[I]>> : Acc;

type AllIndices<Counts extends readonly number[]> = { [K in keyof Counts]: K extends `${infer N extends number}` ? N : never };

/**
 * 戻り値の行数。フッタからわかるのは「条件で絞らないとき」だけ:
 * - filter / bbox あり → 不明（N 行以下とは言えるが、TS には範囲の型がない）
 * - rowGroups あり     → 選んだ row group の行数の合計
 * - どちらもなし       → ファイル全体の行数
 */
type LengthOf<Counts extends readonly number[], O> =
  number extends Counts["length"] ? {}
  : O extends { filter: unknown } | { bbox: unknown } ? {}
  : O extends { rowGroups: infer Is extends readonly number[] } ? { length: SumOf<Counts, Is> }
  : { length: SumOf<Counts, AllIndices<Counts>> };

// --- 読み方 → 戻り値の型 ---------------------------------------------------------------

export interface ReadOptions<Row, RGs extends readonly unknown[]> {
  /** 読む列（省略すると全部） */
  columns?: readonly (keyof Row & string)[];
  /** 行の条件 */
  filter?: Filter<Row>;
  /** 読む row group の番号 */
  rowGroups?: readonly GroupIndex<RGs>[];
  /**
   * 範囲 [xmin, ymin, xmax, ymax]（ファイルの CRS の座標）。GeoParquet の covering（各行の bbox 列）で絞る。
   * 範囲に重ならない row group は、統計を見て読まずに飛ばす。型は狭めない。
   */
  bbox?: readonly [number, number, number, number];
  /** 圧縮形式の展開（ZSTD などは hyparquet-compressors を渡す） */
  compressors?: Compressors;
  /** 読み込み済みのフッタ。省略すると読む（同じ AsyncBuffer には 1 回だけ） */
  metadata?: FileMetaData;
}

/** 読み方 O から、戻り値の 1 行の型を計算する */
export type ResultRow<Row, RGs extends readonly unknown[], O> = DistributivePick<
  ApplyFilter<
    RowsOfGroups<Row, RGs, O extends { rowGroups: readonly (infer I extends number)[] } ? I : GroupIndex<RGs>>,
    O extends { filter: infer F } ? F : {}
  >,
  O extends { columns: readonly (infer K)[] } ? K & PropertyKey : keyof Row
>;

// --- 実行時 ---------------------------------------------------------------------------

const metadataCache = new WeakMap<AsyncBuffer, Promise<FileMetaData>>();

/** フッタを読む。同じ AsyncBuffer なら 2 回目以降は読まない */
export function readMetadata(file: AsyncBuffer): Promise<FileMetaData> {
  let metadata = metadataCache.get(file);
  if (!metadata) {
    metadata = parquetMetadataAsync(file);
    metadataCache.set(file, metadata);
  }
  return metadata;
}

/** GeoParquet の covering（主ジオメトリ列の bbox 列）から、範囲に重なる行の条件を作る */
function bboxFilter(metadata: FileMetaData, [xmin, ymin, xmax, ymax]: readonly number[]): ParquetQueryFilter {
  const geo = metadata.key_value_metadata?.find((kv) => kv.key === "geo")?.value;
  const parsed = geo ? JSON.parse(geo) : undefined;
  const covering = parsed?.columns?.[parsed?.primary_column]?.covering?.bbox as Record<"xmin" | "ymin" | "xmax" | "ymax", string[]> | undefined;
  if (!covering) throw new Error("bbox で絞るには、GeoParquet の covering（各行の bbox 列）が必要です");
  const path = (k: keyof typeof covering) => covering[k].join(".");
  return {
    [path("xmin")]: { $lte: xmax },
    [path("xmax")]: { $gte: xmin },
    [path("ymin")]: { $lte: ymax },
    [path("ymax")]: { $gte: ymin },
  };
}

/**
 * 型付きで読む関数を作る。Row / RowGroups / RowCounts は import type でしか持ち込めないので、
 * 型引数だけ先に渡す 2 段階の呼び出しにしている。
 */
export function readParquet<Row, RGs extends readonly unknown[] = RowGroupStats[], Counts extends readonly number[] = number[]>() {
  return async <const O extends ReadOptions<Row, RGs> = {}>(
    file: AsyncBuffer,
    options?: O,
  ): Promise<ResultRow<Row, RGs, O>[] & LengthOf<Counts, O>> => {
    const { columns, filter, rowGroups, bbox, compressors } = (options ?? {}) as ReadOptions<Row, RGs>;
    const metadata = options?.metadata ?? (await readMetadata(file));

    let where = filter as ParquetQueryFilter | undefined;
    if (bbox) {
      const inBbox = bboxFilter(metadata, bbox);
      where = where ? { $and: [where, inBbox] } : inBbox;
    }
    const base = { file, metadata, compressors, columns: columns as string[] | undefined, filter: where };

    // row group の行範囲は、型ではなく実際のフッタから求める
    const ranges = (rowGroups ?? [undefined]).map((i) => {
      if (i === undefined) return {};
      const group = metadata.row_groups[i];
      if (!group) throw new Error(`row group ${i} はありません（0〜${metadata.row_groups.length - 1}）`);
      const rowStart = metadata.row_groups.slice(0, i).reduce((n, g) => n + Number(g.num_rows), 0);
      return { rowStart, rowEnd: rowStart + Number(group.num_rows) };
    });
    const results = await Promise.all(ranges.map((range) => parquetReadObjects({ ...base, ...range })));
    // ResultRow を汎用の O のまま計算させると型チェックが循環するので、never で返す（呼び出し側の型は戻り値の注釈で決まる）
    return results.flat() as never;
  };
}

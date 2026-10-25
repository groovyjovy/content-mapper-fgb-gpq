// 読み方を絞るたびに、型（値の候補）が狭まっていく様子を見る
// 実行: node src/typed-read.ts（example ディレクトリで）
//
// データ: facilities.parquet（札幌市の架空の施設 1000 件。10 区 × 100 件、row group は 1 区 = 100 行）
// 型の材料: Row（列の型）と RowGroups（row group ごとの統計）。どちらも content mapper がフッタから作る。
// 各段階の「型はこうなる」は、Assert<Equal<...>> で型チェック時に確かめている。
import { fileURLToPath } from "node:url";
import { asyncBufferFromFile } from "hyparquet";
import type { Point } from "geo-crs-types";
import type { Row, RowCounts, RowGroups } from "../data/facilities.parquet";
import { readParquet } from "typed-hyparquet";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type Item<T> = T extends readonly (infer U)[] ? U : never;

const path = fileURLToPath(new URL("../data/facilities.parquet", import.meta.url));
const file = await asyncBufferFromFile(path);
const read = readParquet<Row, RowGroups, RowCounts>();

/** 実行結果の要約: 件数、ward の値、opened に null があるか、先頭の行 */
function summary(label: string, rows: readonly Record<string, unknown>[]) {
  const wards = rows[0] && !("ward" in rows[0]) ? "（読んでいない）" : JSON.stringify([...new Set(rows.map((r) => r.ward))]);
  const nulls = rows.filter((r) => r.opened === null).length;
  console.log(`${label}\n  件数=${rows.length} ward=${wards} opened の null=${nulls}`);
  const head = rows[0];
  if (head) {
    const keys = ["name", "ward", "category", "opened"].filter((k) => k in head);
    console.log(`  先頭: ${keys.map((k) => `${k}=${String(head[k])}`).join(" ")}${Object.keys(head).length > keys.length ? " …" : ""}`);
  }
}

// =============================================================================
// 段階 0: 何も絞らない
// =============================================================================
// Row だけ見ると ward は string | null。でも row group の統計（ward の最小 = 最大）から、
// 「中央区の行 | 北区の行 | …」の 10 通りの union になる。

const all = await read(file);
summary("## 段階 0: 全部", all);

type All = Item<typeof all>;
type _0a = Assert<Equal<All["ward"], "中央区" | "北区" | "東区" | "白石区" | "豊平区" | "南区" | "西区" | "厚別区" | "手稲区" | "清田区">>;
type _0b = Assert<Equal<All["opened"], number | null>>; // 南区と手稲区には null がある
type _0c = Assert<Equal<All["name"], string>>; // どの row group にも null がない → null が消える
type _0d = Assert<Equal<All["id"], bigint>>;
type _0e = Assert<Equal<All["geometry"], Point<"EPSG:6680">>>; // ジオメトリも null の数 0
type _0f = Assert<Equal<All["category"], string>>; // 最小「コンビニ」≠ 最大「駅」なので string のまま
type _0n = Assert<Equal<typeof all.length, 1000>>; // 行数もフッタからわかる

// ward で分岐すると、opened の型も変わる（ward が union を見分ける目印になる）
for (const f of all) {
  if (f.ward === "中央区") {
    type _ = Assert<Equal<typeof f.opened, number>>; // 中央区には null がない
  } else if (f.ward === "南区") {
    type _ = Assert<Equal<typeof f.opened, number | null>>;
  }
}

// =============================================================================
// 段階 1: 列で絞る
// =============================================================================

const cols = await read(file, { columns: ["ward", "opened"] });
summary("\n## 段階 1: columns: [ward, opened]", cols);

type Cols = Item<typeof cols>;
type _1a = Assert<Equal<keyof Cols, "ward" | "opened">>;
type _1n = Assert<Equal<typeof cols.length, 1000>>; // 列を絞っても行数は変わらない
// @ts-expect-error 読んでいない列は型から消えている（実行時も undefined）
cols[0]?.name;
// @ts-expect-error 存在しない列名は指定できない
void read(file, { columns: ["nmae"] }).catch(() => {});

// =============================================================================
// 段階 2: 行の条件で絞る
// =============================================================================

// 2-1. category = "駅" → category の候補が "駅" だけになる
const stations = await read(file, { filter: { category: "駅" } });
summary("\n## 段階 2-1: filter category = 駅", stations);
type _2a = Assert<Equal<Item<typeof stations>["category"], "駅">>;
type _2n = Assert<Equal<typeof stations.length, number>>; // 条件で絞ると行数は読むまでわからない

// 2-2. opened >= 2000 → 比較で null の行は外れるので、opened から null が消える
const recent = await read(file, { filter: { opened: { $gte: 2000 } } });
summary("\n## 段階 2-2: filter opened >= 2000", recent);
type _2b = Assert<Equal<Item<typeof recent>["opened"], number>>;

// 2-3. ward = "南区" → 10 通りのうち南区の行だけが残る（ほかの row group はありえない）
const minami = await read(file, { filter: { ward: "南区" } });
summary("\n## 段階 2-3: filter ward = 南区", minami);
type _2c = Assert<Equal<Item<typeof minami>["ward"], "南区">>;
type _2d = Assert<Equal<Item<typeof minami>["opened"], number | null>>; // 南区には null がある

// 2-4. ward = "新宿区" → どの row group の候補にもない。型の上で「0 件」とわかる
const shinjuku = await read(file, { filter: { ward: "新宿区" } });
summary("\n## 段階 2-4: filter ward = 新宿区", shinjuku);
type _2e = Assert<Equal<typeof shinjuku, never[]>>;

// @ts-expect-error 列の型に合わない値（category は文字列）
void read(file, { filter: { category: 123 } }).catch(() => {});

// =============================================================================
// 段階 3: row group で絞る
// =============================================================================

// 3-1. row group 0 だけ → 中央区の統計がそのまま型になる
const rg0 = await read(file, { rowGroups: [0] });
summary("\n## 段階 3-1: rowGroups [0]", rg0);
type _3a = Assert<Equal<Item<typeof rg0>["ward"], "中央区">>;
type _3b = Assert<Equal<Item<typeof rg0>["opened"], number>>;
type _3n = Assert<Equal<typeof rg0.length, 100>>;

// 3-2. row group 5 と 8 → 南区と手稲区。どちらも opened に null がある
const rg58 = await read(file, { rowGroups: [5, 8] });
summary("\n## 段階 3-2: rowGroups [5, 8]", rg58);
type _3c = Assert<Equal<Item<typeof rg58>["ward"], "南区" | "手稲区">>;
type _3d = Assert<Equal<Item<typeof rg58>["opened"], number | null>>;
type _3m = Assert<Equal<typeof rg58.length, 200>>; // 100 + 100 を型の上で足している

// 3-3. row group 0（中央区）なのに ward = "南区" → ありえない
const contradiction = await read(file, { rowGroups: [0], filter: { ward: "南区" } });
summary("\n## 段階 3-3: rowGroups [0] + filter ward = 南区", contradiction);
type _3e = Assert<Equal<typeof contradiction, never[]>>;

// @ts-expect-error row group は 0〜9 しかない
void read(file, { rowGroups: [10] }).catch(() => {});

// =============================================================================
// 全部入り: row group 5（南区）× opened >= 2000 × 2 列
// =============================================================================

const combined = await read(file, { rowGroups: [5], filter: { opened: { $gte: 2000 } }, columns: ["name", "opened"] });
summary("\n## 全部入り: rowGroups [5] + opened >= 2000 + columns [name, opened]", combined);
type _all = Assert<Equal<Item<typeof combined>, { name: string; opened: number }>>;

// =============================================================================
// そのほかの書き方
// =============================================================================

// $or → それぞれで狭めた結果の union
const either = await read(file, { filter: { $or: [{ ward: "中央区" }, { ward: "南区" }] }, columns: ["ward", "opened"] });
summary("\n## $or: ward = 中央区 または 南区", either);
type _or = Assert<Equal<Item<typeof either>, { ward: "中央区"; opened: number } | { ward: "南区"; opened: number | null }>>;

// $and → 順に適用
const both = await read(file, { filter: { $and: [{ ward: "南区" }, { opened: { $gte: 2000 } }] }, columns: ["ward", "opened"] });
summary("\n## $and: ward = 南区 かつ opened >= 2000", both);
type _and = Assert<Equal<Item<typeof both>, { ward: "南区"; opened: number }>>;

// 入れ子の struct の列はドットでつなぐ（列名と値の型はチェックされる。型は狭めない）
const east = await read(file, { filter: { "geometry_bbox.xmin": { $gte: -72000 } }, columns: ["name", "ward"] });
summary("\n## 入れ子の列: geometry_bbox.xmin >= -72000", east);
// @ts-expect-error 入れ子の列でも、存在しない名前は指定できない
void read(file, { filter: { "geometry_bbox.xmn": { $gte: 0 } } }).catch(() => {});

// bbox: GeoParquet の covering（geometry_bbox 列）で範囲に重なる行だけ読む。座標はファイルの CRS（EPSG:6680）
const nearOdori = await read(file, { bbox: [-75000, -106000, -72000, -103000], columns: ["name", "ward"] });
summary("\n## bbox: 大通付近 [-75000, -106000, -72000, -103000]", nearOdori);

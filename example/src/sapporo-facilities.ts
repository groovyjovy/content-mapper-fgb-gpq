// 札幌市の施設データ（facilities.parquet）を読む。読み方を変えるたびに、型が絞り込まれていく
// 実行: node src/sapporo-facilities.ts（example ディレクトリで）
//
// データ: 架空の施設 1,000 件（10 区 × 100 件）。列は name, ward（区）, category, opened（開業年）など
import { asyncBufferFromFile } from "hyparquet";
import { readParquet } from "typed-hyparquet";
import type { Row, RowCounts, RowGroups } from "../data/facilities.parquet";

const file = await asyncBufferFromFile("data/facilities.parquet");
const read = readParquet<Row, RowGroups, RowCounts>();

// 1. 全部読む
const all = await read(file);
all[0].ward; //   "中央区" | "北区" | "東区" | ... | "清田区"（10 区）
all[0].opened; // number | null
all.length; //    1000
console.log("1. 全部:", all.length, "件");

// 2. 南区だけ
const minami = await read(file, { filter: { ward: "南区" } });
minami[0].ward; // "南区"
console.log("2. 南区:", minami.length, "件");

// 3. 開業年が不明な施設
const unknown = await read(file, { filter: { opened: null } });
unknown[0].ward; // "南区" | "手稲区"  ← 開業年が不明な施設があるのはこの 2 区だけ（読む前にわかる）
console.log("3. 開業年が不明:", unknown.length, "件", [...new Set(unknown.map((f) => f.ward))]);

// 4. 中央区の名前と開業年だけ
const chuo = await read(file, { filter: { ward: "中央区" }, columns: ["name", "opened"] });
chuo[0].opened; // number  ← 中央区には開業年が不明な施設がないので、null チェックがいらない
console.log("4. 中央区:", chuo.slice(0, 3));

// 5. 間違えるとエラー
try {
  // @ts-expect-error 存在しない列（name の打ち間違い）
  await read(file, { columns: ["nmae"] });
  // @ts-expect-error 読んでいない列
  chuo[0].ward;
} catch {}

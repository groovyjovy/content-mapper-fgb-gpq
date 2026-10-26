// 実データ: Overture Maps の places（日本を含む part-00015、約 733MB、row group 256）から札幌の POI を読む
// 実行: node src/overture.ts（example ディレクトリで）
//
// 型は places.parquet.ref のフッタ（約 1.5MB）から mapper が作る。実行時は HTTP Range で必要な部分だけ取る。
import { readFileSync } from "node:fs";
import { asyncBufferFromUrl, cachedAsyncBuffer } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import type { Point } from "geo-crs-types";
import { readMetadata, readParquet } from "typed-hyparquet";
import type { Row, RowCounts, RowGroups } from "../data/places.parquet.ref";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type Item<T> = T extends readonly (infer U)[] ? U : never;

// しおりファイルの URL（.parquet.ref の url は型の上にしかないので、実行時はファイルから読む）
const { url } = JSON.parse(readFileSync(new URL("../data/places.parquet.ref", import.meta.url), "utf8")) as { url: string };

// 実際に取得したバイト数を数える
let requests = 0;
let bytes = 0;
const countingFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  if (res.status === 206) {
    requests++;
    bytes += Number(res.headers.get("content-length") ?? 0);
  }
  return res;
};
function report(label: string, started: number) {
  console.log(`  取得: ${requests} リクエスト / ${(bytes / 1e6).toFixed(2)} MB / ${((performance.now() - started) / 1000).toFixed(1)} 秒（${label}）`);
  requests = 0;
  bytes = 0;
}

const file = cachedAsyncBuffer(await asyncBufferFromUrl({ url, fetch: countingFetch }));
const read = readParquet<Row, RowGroups, RowCounts>();

let t = performance.now();
const metadata = await readMetadata(file);
console.log(`## フッタ: ${(file.byteLength / 1e6).toFixed(0)} MB のファイル、${metadata.num_rows.toLocaleString()} 行、row group ${metadata.row_groups.length}`);
report("フッタ", t);

// --- 札幌市中心部の範囲で、確度の高い POI を読む ------------------------------------------
// （operating_status で絞ることもできるが、このリリースではほとんど null。範囲内 14,861 件中 "open" は 14 件だけ）

t = performance.now();
const sapporo = await read(file, {
  bbox: [141.33, 43.05, 141.37, 43.07], // 経度・緯度（OGC:CRS84）
  filter: { confidence: { $gte: 0.8 } },
  columns: ["id", "names", "basic_category", "confidence", "geometry"],
  compressors,
  metadata,
});
console.log(`\n## 札幌市中心部（bbox）× confidence >= 0.8: ${sapporo.length} 件`);
report("bbox + filter", t);

type Place = Item<typeof sapporo>;
type _1 = Assert<Equal<Place["confidence"], number>>;
type _2 = Assert<Equal<Place["id"], string>>; // どの row group にも null がない
type _3 = Assert<Equal<Place["geometry"], Point<"OGC:CRS84">>>;
type _4 = Assert<Equal<keyof Place, "id" | "names" | "basic_category" | "confidence" | "geometry">>;

const counts = new Map<string, number>();
for (const p of sapporo) counts.set(p.basic_category ?? "(なし)", (counts.get(p.basic_category ?? "(なし)") ?? 0) + 1);
console.log("  カテゴリ上位:", [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} ${n}`).join(", "));
for (const p of sapporo.slice(0, 5)) {
  const [lon, lat] = p.geometry.coordinates;
  console.log(`  ${p.names?.primary} (${p.basic_category}) [${lon?.toFixed(4)}, ${lat?.toFixed(4)}] confidence=${p.confidence?.toFixed(2)}`);
}

// 何も絞らなければファイル全体の行数。256 個の row group の行数を型の上で足している
type AllPlaces = Awaited<ReturnType<typeof read<{}>>>;
type _6 = Assert<Equal<AllPlaces["length"], 5528489>>;

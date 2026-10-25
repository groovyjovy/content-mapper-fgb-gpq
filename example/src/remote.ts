// リモートの GeoParquet を HTTP Range で必要な部分だけ読む
// 実行: node src/remote.ts（example ディレクトリで）
//
// データ: GitHub に置いた facilities.parquet（コミットハッシュ付きの URL。中身が変わらないので型と食い違わない）
// 型は facilities.parquet.ref のフッタから mapper が作る。手元の facilities.parquet と同じ型になる。
import { readFileSync } from "node:fs";
import { asyncBufferFromUrl, cachedAsyncBuffer, parquetMetadataAsync } from "hyparquet";
import { readParquet } from "typed-hyparquet";
import type { Row, RowCounts, RowGroups } from "../data/facilities.parquet.ref";
import type * as Local from "../data/facilities.parquet";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type Item<T> = T extends readonly (infer U)[] ? U : never;

// リモートでも手元でも、同じファイルなら同じ型
type _same = Assert<Equal<[Row, RowGroups, RowCounts], [Local.Row, Local.RowGroups, Local.RowCounts]>>;

// .parquet.ref の url は型の上にしかないので、実行時はファイルから読む
const { url } = JSON.parse(readFileSync(new URL("../data/facilities.parquet.ref", import.meta.url), "utf8")) as { url: string };

// 実際に送った Range リクエストを記録する
const log: string[] = [];
const loggingFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  const range = new Headers(init?.headers).get("Range");
  if (range) log.push(`${range.padEnd(20)} → ${res.status} ${res.headers.get("content-length")} B`);
  return res;
};
function report(label: string) {
  console.log(`\n## ${label}`);
  for (const line of log) console.log(`  ${line}`);
  log.length = 0;
}

// cachedAsyncBuffer は 512KB 未満のファイルを最初に丸ごと読む。Range の様子を見るため minSize: 0 にしている
const file = cachedAsyncBuffer(await asyncBufferFromUrl({ url, fetch: loggingFetch }), { minSize: 0 });
console.log(`${url}\nファイル全体: ${file.byteLength.toLocaleString()} B`);

// 1. フッタだけ（mapper が型を作るときと同じ: 末尾 8 バイトでフッタの長さを知り、フッタを読む）
// hyparquet は既定で末尾 512KB をまとめて読む。この例では 8 バイトにして mapper と同じ読み方にしている
const metadata = await parquetMetadataAsync(file, { initialFetchSize: 8 });
report(`フッタ: ${metadata.num_rows} 行、row group ${metadata.row_groups.length}`);

// 2. row group 0（中央区）の 2 列だけ
const read = readParquet<Row, RowGroups, RowCounts>();
const chuo = await read(file, { rowGroups: [0], columns: ["name", "visitors"], metadata });
type _chuo = Assert<Equal<Item<typeof chuo>, { name: string; visitors: number }>>;
type _len = Assert<Equal<typeof chuo.length, 100>>;
report(`row group 0 の name / visitors: ${chuo.length} 件（先頭: ${chuo[0]?.name}）`);

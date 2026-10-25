// parcels.parquet を実際に読んで、中身と値の形を確かめる
// 実行: node src/read-parcels.ts（example ディレクトリで）
import { fileURLToPath } from "node:url";
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects, parquetSchema } from "hyparquet";
import type { Row as Parcel } from "../data/parcels.parquet";

const path = fileURLToPath(new URL("../data/parcels.parquet", import.meta.url));
const file = await asyncBufferFromFile(path);

// --- 1. フッタのメタデータ（mapper が型を作るときに読んでいるもの） ---------------

const metadata = await parquetMetadataAsync(file);
console.log("## ファイル");
console.log({ bytes: file.byteLength, rows: metadata.num_rows, rowGroups: metadata.row_groups.length });

// 項目（type / logical_type / repetition_type）は Parquet の仕様どおり。
// ただし hyparquet は既定（geoparquet: true）で geo メタデータを見て、ジオメトリ列に
// logical_type: { type: "GEOMETRY", crs } を書き足す。ファイル上はただの BYTE_ARRAY。
console.log("\n## スキーマ（Parquet の物理型 / 論理型）");
for (const child of parquetSchema(metadata).children) {
  const e = child.element;
  console.log(`  ${e.name}: ${e.type ?? "(group)"} ${JSON.stringify(e.logical_type ?? e.converted_type ?? "")} ${e.repetition_type}`);
}

// console.log("\n## key_value_metadata の geo（GeoParquet の本体）");
// const geo = metadata.key_value_metadata?.find((kv) => kv.key === "geo")?.value;
// console.dir(geo && JSON.parse(geo), { depth: null });

// // --- 2. 行として読む（既定: geo メタデータを見てジオメトリを GeoJSON に変換） ---------

const rows = (await parquetReadObjects({ file })) as Parcel[];
console.log("\n## parquetReadObjects の結果（既定）");
console.dir(rows, { depth: null });

// 型どおりに使える
for (const p of rows) {
  const g = p.geometry;
  console.log(`  ${p.name}: area=${p.area}, type=${g?.type}, 頂点数=${g?.coordinates[0]?.length}`);
}

// // --- 3. geoparquet: false で読むと、ジオメトリは変換されない -------------------------
// // 生成された Parcel 型は既定の挙動に合わせているので、この結果には当てはまらない

// // BYTE_ARRAY は既定で UTF-8 の文字列として読まれるので、WKB が文字化けした string になる
// const asString = await parquetReadObjects({ file, geoparquet: false, columns: ["geometry"] });
// console.log("\n## geoparquet: false の geometry");
// console.log("  ", typeof asString[0]?.geometry, JSON.stringify(asString[0]?.geometry).slice(0, 40), "...");

// // utf8: false も付けると WKB のバイト列（Uint8Array）になる
// const asBytes = await parquetReadObjects({ file, geoparquet: false, utf8: false, columns: ["name", "geometry"] });
// console.log("\n## geoparquet: false, utf8: false の geometry（WKB）");
// for (const r of asBytes) {
//   const wkb: Uint8Array = r.geometry;
//   const view = new DataView(wkb.buffer, wkb.byteOffset, wkb.byteLength);
//   const le = wkb[0] === 1;
//   // WKB の先頭: バイト順 (1) | ジオメトリ種別 (uint32, 3 = Polygon) | リング数 (uint32) | 頂点数 (uint32) | 座標 (float64 × 2 × 頂点数)
//   console.log(`  ${r.name}: ${wkb.byteLength} bytes`, {
//     byteOrder: le ? "little endian" : "big endian",
//     geometryType: view.getUint32(1, le),
//     rings: view.getUint32(5, le),
//     points: view.getUint32(9, le),
//     firstPoint: [view.getFloat64(13, le), view.getFloat64(21, le)],
//   });
// }
// // name は論理型が STRING なので utf8: false でも string のまま（utf8 が効くのは論理型のない BYTE_ARRAY）

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type FileMetaData, parquetMetadata, parquetSchema, type SchemaTree } from "hyparquet";
import { runContentMapper, type TransformResult } from "ts-content-mapper";

const FOOTER_TAIL_LEN = 8; // metadata length (uint32 LE) | "PAR1"
const FOOTER_MAX_SIZE = 64 * 1024 * 1024;
const debug = process.env.GEOPARQUET_MAPPER_DEBUG ? (msg: string) => process.stderr.write(`[geoparquet-mapper] ${msg}\n`) : () => {};

// --- フッタの読み込み ---------------------------------------------------------------

/** ファイル末尾から length バイトを読む関数。ローカルファイルとリモート（HTTP Range）で差し替える */
type ReadTail = (length: number) => Promise<Uint8Array>;

/**
 * Parquet のメタデータ（フッタ）だけを読む。データ本体（row group）は読み込まない。
 * レイアウト: ... | metadata (Thrift) | metadata length (uint32 LE) | "PAR1"
 * 戻り値は末尾の metadata + length + "PAR1"（そのまま parquetMetadata に渡せ、キャッシュにも保存できる）。
 */
async function readFooterBytes(readTail: ReadTail): Promise<Uint8Array> {
  const tail = await readTail(FOOTER_TAIL_LEN);
  if (tail.length < FOOTER_TAIL_LEN || new TextDecoder().decode(tail.subarray(4)) !== "PAR1") {
    throw new Error("Not a Parquet file (footer magic mismatch)");
  }
  const metadataLength = new DataView(tail.buffer, tail.byteOffset).getUint32(0, true);
  if (metadataLength > FOOTER_MAX_SIZE) throw new Error(`Footer too large (${metadataLength} bytes)`);
  const footer = await readTail(metadataLength + FOOTER_TAIL_LEN);
  if (footer.length < metadataLength + FOOTER_TAIL_LEN) throw new Error("Unexpected end of file while reading the footer");
  return footer;
}

function localReader(fileName: string): ReadTail {
  return async (length) => {
    const file = await open(fileName, "r");
    try {
      const { size } = await file.stat();
      const buf = new Uint8Array(Math.min(length, size));
      await file.read(buf, 0, buf.length, size - buf.length);
      return buf;
    } finally {
      await file.close();
    }
  };
}

function remoteReader(url: string): ReadTail {
  return async (length) => {
    // 末尾からの範囲指定（suffix range）。ファイルサイズを知らなくてよい
    const res = await fetch(url, { headers: { Range: `bytes=-${length}` } });
    // 206 でなければサーバーが Range を無視して全体を返そうとしている。全体のダウンロードはしない
    if (res.status !== 206) throw new Error(`Server did not honor the Range request (HTTP ${res.status}): ${url}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    debug(`GET ${url} bytes=-${length} -> ${buf.length} bytes`);
    return buf;
  };
}

/** ref ファイルから見て最寄りの node_modules/.cache に置く。見つからなければキャッシュしない */
function cachePath(refFileName: string, url: string): string | undefined {
  for (let dir = dirname(refFileName); dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, "node_modules"))) {
      const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
      return join(dir, "node_modules", ".cache", "geoparquet-content-mapper", `${hash}.footer`);
    }
  }
  return undefined;
}

/** リモートの Parquet のフッタを取る。最初の 1 回だけ通信し、以降はキャッシュを使う */
async function readRemoteFooterBytes(refFileName: string, url: string): Promise<Uint8Array> {
  const cache = cachePath(refFileName, url);
  if (cache && existsSync(cache) && !process.env.GEOPARQUET_MAPPER_REFRESH) {
    debug(`cache hit ${cache}`);
    return new Uint8Array(readFileSync(cache));
  }
  const bytes = await readFooterBytes(remoteReader(url));
  if (cache) {
    mkdirSync(dirname(cache), { recursive: true });
    writeFileSync(cache, bytes);
  }
  return bytes;
}

/** `.parquet.ref` の中身: { "url": "https://..." } */
function parseRef(content: string): string {
  const ref = JSON.parse(content) as { url?: unknown };
  if (typeof ref.url !== "string" || !/^https?:\/\//.test(ref.url)) throw new Error('Expected { "url": "https://..." }');
  return ref.url;
}

// --- GeoParquet の geo メタデータ ------------------------------------------------------

interface GeoColumn {
  encoding?: string;
  geometry_types?: string[];
  crs?: { id?: { authority: string; code: string | number } } | null;
  bbox?: number[];
}

interface GeoMetadata {
  primary_column?: string;
  columns?: Record<string, GeoColumn>;
}

const GEOMETRY_TYPES = ["Point", "LineString", "Polygon", "MultiPoint", "MultiLineString", "MultiPolygon", "GeometryCollection"];

/** GeoParquet 仕様: crs が省略されたら OGC:CRS84、null なら不明 */
function crsOf(column: GeoColumn): string | undefined {
  if (column.crs === undefined) return "OGC:CRS84";
  const id = column.crs?.id;
  return id ? `${id.authority}:${id.code}` : undefined;
}

function geometryTsType(column: GeoColumn): string {
  const crs = crsOf(column);
  const c = crs ? JSON.stringify(crs) : "string";
  // "Point Z" のような次元の付いた名前は、型の上では次元を区別しない
  const types = [...new Set((column.geometry_types ?? []).map((t) => t.replace(/ Z$/, "")))].filter((t) => GEOMETRY_TYPES.includes(t));
  return types.length ? types.map((t) => `${t}<${c}>`).join(" | ") : `Geometry<${c}>`;
}

function geometryImports(geo: GeoMetadata): string[] {
  const names = new Set<string>();
  for (const column of Object.values(geo.columns ?? {})) {
    const t = geometryTsType(column);
    for (const name of [...GEOMETRY_TYPES, "Geometry"]) if (new RegExp(`\\b${name}<`).test(t)) names.add(name);
  }
  return [...names].sort();
}

// --- Parquet のスキーマ → TS の型 -------------------------------------------------------
// 型は hyparquet（parquetReadObjects）で読んだときの値の形に合わせる。
// - 任意（OPTIONAL）の単純な列は欠けると null、struct / list / map は undefined
// - INT64 は bigint、DATE / TIMESTAMP は Date

function isList(node: SchemaTree): boolean {
  const child = node.children[0];
  return node.element.converted_type === "LIST" && node.children.length === 1 && child?.element.repetition_type === "REPEATED" && child.children.length <= 1;
}

function isMap(node: SchemaTree): boolean {
  const child = node.children[0];
  return node.element.converted_type === "MAP" && node.children.length === 1 && child?.element.repetition_type === "REPEATED" && child.children.length === 2;
}

function leafType(node: SchemaTree): string {
  const { type, converted_type: ctype, logical_type: ltype } = node.element;
  if (ltype?.type === "STRING" || ltype?.type === "UUID" || ctype === "UTF8" || ctype === "ENUM") return "string";
  if (ctype === "JSON" || ctype === "BSON" || ctype === "INTERVAL" || ltype?.type === "VARIANT") return "unknown";
  if (ctype === "DATE" || ctype === "TIMESTAMP_MILLIS" || ctype === "TIMESTAMP_MICROS" || ltype?.type === "TIMESTAMP" || type === "INT96") return "Date";
  if (ctype === "DECIMAL") return "number";
  switch (type) {
    case "BOOLEAN":
      return "boolean";
    case "INT64":
      return "bigint";
    case "INT32":
    case "FLOAT":
    case "DOUBLE":
      return "number";
    case "BYTE_ARRAY":
      return "string"; // hyparquet は既定（utf8: true）で文字列にする
    default:
      return "Uint8Array";
  }
}

function tsType(node: SchemaTree, indent: string): string {
  const optional = node.element.repetition_type === "OPTIONAL";
  let t: string;
  let group = true;
  if (isList(node)) {
    const element = node.children[0]!.children[0] ?? node.children[0]!;
    t = `(${tsType(element, indent)})[]`;
  } else if (isMap(node)) {
    const value = node.children[0]!.children.find((c) => c.element.name === "value") ?? node.children[0]!.children[1]!;
    t = `Record<string, ${tsType(value, indent)}>`;
  } else if (node.children.length) {
    t = objectType(node.children, indent);
  } else {
    t = leafType(node);
    group = false;
  }
  if (node.element.repetition_type === "REPEATED") return `${t}[]`;
  return optional ? `${t} | ${group ? "undefined" : "null"}` : t;
}

function objectType(fields: SchemaTree[], indent: string, overrides: Map<string, string> = new Map()): string {
  const inner = `${indent}  `;
  const lines = fields.map((f) => `${inner}${JSON.stringify(f.element.name)}: ${overrides.get(f.element.name) ?? tsType(f, inner)};`);
  return `{\n${lines.join("\n")}\n${indent}}`;
}

// --- row group ごとの統計 → 型 ----------------------------------------------------------
// 最上位の単純な列（struct / list / map の中ではない列）について、row group ごとに
// 「null があるか」と「全行が同じ値か」を型で書き出す。利用側はこれで「この row group の行」の型を狭められる。
//   nulls: "none" | "all"  … null が 1 つもない / 全部 null（"some" のときは何も狭まらないので書かない）
//   value: リテラル         … 最小 = 最大 のとき、その値
// 同じ内容の row group は 1 つの型を共有する（union のメンバーが row group の数だけ増えないように）。

const MAX_ROW_GROUPS = 5_000; // これを超えたら書き出さない

/** 統計の値を TS のリテラル型にする。リテラルにできない値（Date、バイト列など）は undefined */
function literalType(value: unknown): string | undefined {
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? String(value) : undefined;
    case "bigint":
      return `${value}n`;
    case "boolean":
      return String(value);
    default:
      return undefined;
  }
}

interface RowGroupsType {
  /** 共有する型の宣言（type RowGroupN = {...}） */
  declarations: string[];
  /** export type RowGroups = [...] の右辺 */
  tuple: string;
  /** export type RowCounts = [...] の右辺（row group ごとの行数） */
  counts: string;
}

function rowGroupsType(metadata: FileMetaData, root: SchemaTree, geoColumns: Map<string, GeoColumn>): RowGroupsType | undefined {
  if (metadata.row_groups.length > MAX_ROW_GROUPS) return undefined;
  const columns = new Set(root.children.filter((c) => c.children.length === 0).map((c) => c.element.name));

  const aliases = new Map<string, string>(); // 中身 → 型の名前
  const declarations: string[] = [];
  const entries = metadata.row_groups.map((rg, i) => {
    const fields: string[] = [];
    for (const chunk of rg.columns) {
      const path = chunk.meta_data?.path_in_schema ?? [];
      const name = path[0];
      const s = chunk.meta_data?.statistics;
      if (path.length !== 1 || !name || !columns.has(name) || !s) continue;
      const parts: string[] = [];
      if (s.null_count === 0n) parts.push(`nulls: "none"`);
      else if (s.null_count !== undefined && s.null_count === rg.num_rows) parts.push(`nulls: "all"`);
      // ジオメトリ列は WKB のバイト列なので、最小・最大は使わない
      if (!geoColumns.has(name) && s.is_min_value_exact !== false && s.is_max_value_exact !== false) {
        const min = literalType(s.min_value ?? s.min);
        if (min !== undefined && min === literalType(s.max_value ?? s.max)) parts.push(`value: ${min}`);
      }
      if (parts.length) fields.push(`  ${JSON.stringify(name)}: { ${parts.join("; ")} };`);
    }
    const body = `{\n${fields.join("\n")}\n}`;
    let alias = aliases.get(body);
    if (!alias) {
      alias = `RowGroup${aliases.size}`;
      aliases.set(body, alias);
      declarations.push(`type ${alias} = ${body};`);
    }
    return `  /* ${i}: ${Number(rg.num_rows).toLocaleString("en-US")} 行 */ ${alias},`;
  });
  const counts = `[${metadata.row_groups.map((rg) => String(rg.num_rows)).join(", ")}]`;
  return { declarations, tuple: `[\n${entries.join("\n")}\n]`, counts };
}

function toIdentifier(fileName: string): string {
  const id = basename(fileName).replace(/\.parquet(\.ref)?$/, "").replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[0-9]/.test(id) ? `_${id}` : id || "data";
}

function generate(fileName: string, metadata: FileMetaData, url?: string): string {
  const geoValue = metadata.key_value_metadata?.find((kv) => kv.key === "geo")?.value;
  const geo: GeoMetadata = geoValue ? JSON.parse(geoValue) : {};
  const geoColumns = new Map(Object.entries(geo.columns ?? {}).filter(([, c]) => c.encoding === "WKB"));

  // ジオメトリ列は GeoJSON の型にする（hyparquet が WKB を GeoJSON に変換する）
  const root = parquetSchema(metadata);
  const overrides = new Map<string, string>();
  for (const field of root.children) {
    const column = geoColumns.get(field.element.name);
    if (column) overrides.set(field.element.name, `${geometryTsType(column)}${field.element.repetition_type === "OPTIONAL" ? " | null" : ""}`);
  }

  const primary = geo.primary_column && geoColumns.get(geo.primary_column);
  const crs = primary ? crsOf(primary) : undefined;
  const crsType = crs ? JSON.stringify(crs) : "string";
  const imports = geometryImports({ columns: Object.fromEntries(geoColumns) });
  const rowGroups = rowGroupsType(metadata, root, geoColumns);

  const doc = [
    url ?? basename(fileName),
    "",
    `- 行数: ${Number(metadata.num_rows).toLocaleString("en-US")}（row group ${metadata.row_groups.length}）`,
    ...[...geoColumns].map(([name, c]) => `- ジオメトリ列 \`${name}\`: ${(c.geometry_types ?? []).join(", ") || "任意"} / CRS \`${crsOf(c) ?? "不明"}\`${c.bbox ? ` / bbox [${c.bbox.join(", ")}]` : ""}`),
    geoColumns.size ? undefined : "- geo メタデータなし（GeoParquet ではない Parquet）",
    "",
    "型は hyparquet の parquetReadObjects で読んだときの値の形。",
  ].filter((l) => l !== undefined);

  return [
    imports.length ? `import type { ${imports.join(", ")} } from "geo-crs-types";\n` : "",
    `/**`,
    ...doc.map((l) => ` * ${l}`.trimEnd()),
    ` */`,
    `export interface Row ${objectType(root.children, "", overrides)}`,
    ``,
    `declare const ${toIdentifier(fileName)}: Row[];`,
    `export default ${toIdentifier(fileName)};`,
    ``,
    `/** 主ジオメトリ列（${geo.primary_column ?? "なし"}）の CRS */`,
    `export declare const crs: ${crsType};`,
    ...(rowGroups
      ? [
          ``,
          ...rowGroups.declarations,
          ``,
          `/**`,
          ` * row group ごとに、型を狭めるのに使える統計（フッタの column chunk の statistics から）。`,
          ` * 最上位の単純な列だけ。nulls: null が 1 つもない / 全部 null、value: 全行が同じ値（最小 = 最大）。`,
          ` * 同じ内容の row group は同じ型（RowGroupN）を共有する。`,
          ` */`,
          `export type RowGroups = ${rowGroups.tuple};`,
          ``,
          `/** row group ごとの行数 */`,
          `export type RowCounts = ${rowGroups.counts};`,
        ]
      : []),
    ...(url ? [``, `/** データの URL */`, `export declare const url: ${JSON.stringify(url)};`] : []),
    ``,
  ].join("\n");
}

runContentMapper({
  diagnosticSource: "geoparquet",
  async transform(params): Promise<TransformResult> {
    debug(`transform ${params.fileName} (content.length=${params.content.length})`);
    try {
      let footer: Uint8Array;
      let url: string | undefined;
      if (params.fileName.endsWith(".parquet.ref")) {
        // しおりファイル: 中の URL から、フッタだけを HTTP Range で取る
        url = parseRef(params.content);
        footer = await readRemoteFooterBytes(params.fileName, url);
      } else {
        // content は文字列で届くためバイナリは壊れている。ファイルから直接読む
        footer = await readFooterBytes(localReader(params.fileName));
      }
      debug(`footer ${footer.length} bytes`);
      const metadata = parquetMetadata(footer.buffer.slice(footer.byteOffset, footer.byteOffset + footer.byteLength) as ArrayBuffer, { geoparquet: false });
      const text = generate(params.fileName, metadata, url);
      debug(text);
      return { text, extension: ".ts" };
    } catch (e) {
      return {
        text: "declare const data: unknown;\nexport default data;\n",
        extension: ".ts",
        diagnostics: [{ messageText: `Failed to read Parquet footer: ${(e as Error).message}`, start: 0, length: 0, code: 1 }],
      };
    }
  },
});

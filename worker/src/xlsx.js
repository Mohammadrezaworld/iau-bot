// خوندن فایل Excel (xlsx) داخل Worker بدون کتابخونه: باز کردن zip با DecompressionStream و خوندن XML.
// فقط مقدار سلول‌ها خونده می‌شه؛ فرمول و ماکرو اجرا نمی‌شن.

const dec = new TextDecoder("utf-8");

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readZip(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  // پیدا کردن End of Central Directory
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("zip_invalid");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("zip_central_invalid");
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (dv.getUint32(localOff, true) !== 0x04034b50) throw new Error("zip_local_invalid");
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = u8.subarray(dataStart, dataStart + compSize);
    if (method === 0) files[name] = raw;
    else if (method === 8) files[name] = await inflateRaw(raw);
    else throw new Error("zip_method_unsupported");
  }
  return files;
}

const ENTITY = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function xmlText(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/g, (m, n) => ENTITY[n] ?? m);
}

const colIndex = (letters) => {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

function parseSheet(xml, sharedStrings) {
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const row = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(rm[1]))) {
      const attrs = cm[1];
      const body = cm[2] || "";
      const ref = /r="([A-Z]+)\d+"/.exec(attrs);
      if (!ref) continue;
      const idx = colIndex(ref[1]);
      const type = /t="([^"]+)"/.exec(attrs)?.[1] || "n";
      let value = null;
      if (type === "inlineStr") {
        const t = /<t[^>]*>([\s\S]*?)<\/t>/.exec(body);
        value = t ? xmlText(t[1]) : "";
      } else if (type === "s") {
        const v = /<v>(\d+)<\/v>/.exec(body);
        value = v ? sharedStrings[Number(v[1])] ?? "" : "";
      } else if (type === "str") {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        value = v ? xmlText(v[1]) : "";
      } else {
        const v = /<v>([^<]*)<\/v>/.exec(body);
        value = v ? Number(v[1]) : null;
      }
      while (row.length < idx) row.push(null);
      row[idx] = value;
    }
    rows.push(row);
  }
  return rows;
}

// خروجی: { sheets: [{ name, rows }] } با ترتیب تب‌ها
export async function parseXlsx(buf) {
  const files = await readZip(buf);
  const wb = dec.decode(files["xl/workbook.xml"] || new Uint8Array());
  const rels = dec.decode(files["xl/_rels/workbook.xml.rels"] || new Uint8Array());
  const sst = files["xl/sharedStrings.xml"]
    ? [...dec.decode(files["xl/sharedStrings.xml"]).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
        xmlText([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(""))
      )
    : [];
  const relMap = {};
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1];
    const target = /Target="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) relMap[id] = target.replace(/^\/?/, "").replace(/^(?!xl\/)/, "xl/");
  }
  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = xmlText(/name="([^"]*)"/.exec(m[0])?.[1] || "");
    const rid = /r:id="([^"]+)"/.exec(m[0])?.[1];
    const path = relMap[rid];
    const xml = path && files[path] ? dec.decode(files[path]) : "";
    sheets.push({ name, rows: parseSheet(xml, sst) });
  }
  return { sheets };
}

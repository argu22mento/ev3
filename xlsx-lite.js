/* xlsx-lite · escritor/lector mínimo de Excel (.xlsx) sin dependencias
   write(sheets) → Blob       sheets: [{ name, cols:[anchos], rows:[[celda,…],…] }]
   celda: string | number | null | { v, s }  con s = 'b' (negrita) | 'date' (v = 'YYYY-MM-DD') | 'money' | 'bmoney'
   read(arrayBuffer) → Promise<[{ name, rows:[[valor,…]] }]>  (números como number, texto como string) */
(function (root) {
  'use strict';
  const enc = new TextEncoder();
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).replace(/&amp;/g, '&');
  const colName = i => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
  const colIndex = ref => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

  // ---------- CRC32 + ZIP (sin compresión) ----------
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

  function zip(files) {
    const parts = [], central = []; let offset = 0;
    const d = new Date(), dt = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)), dd = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate());
    for (const f of files) {
      const name = enc.encode(f.name), data = typeof f.data === 'string' ? enc.encode(f.data) : f.data, crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, dt, true); lh.setUint16(12, dd, true); lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
      lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, dt, true); ch.setUint16(14, dd, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
      ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((a, p) => a + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  // ---------- Escritura ----------
  const STYLE = { b: 1, date: 2, money: 3, bmoney: 4 };
  const dateSerial = ymd => { const [y, m, d] = ymd.split('-').map(Number); return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 864e5); };

  function sheetXml(sh) {
    const cols = (sh.cols || []).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
    const rows = sh.rows.map((row, r) => `<row r="${r + 1}">` + row.map((cell, c) => {
      if (cell == null || cell === '') return '';
      const ref = colName(c) + (r + 1);
      let v = cell, s = 0;
      if (typeof cell === 'object') { v = cell.v; s = STYLE[cell.s] || 0; if (cell.s === 'date' && typeof v === 'string') v = dateSerial(v); }
      if (v == null || v === '') return '';
      if (typeof v === 'number' && isFinite(v)) return `<c r="${ref}"${s ? ` s="${s}"` : ''}><v>${v}</v></c>`;
      return `<c r="${ref}" t="inlineStr"${s ? ` s="${s}"` : ''}><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
    }).join('') + `</row>`).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols ? `<cols>${cols}</cols>` : ''}<sheetData>${rows}</sheetData></worksheet>`;
  }

  function write(sheets) {
    const ns = 'http://schemas.openxmlformats.org/';
    const files = [
      { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${ns}package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
      { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${ns}package/2006/relationships"><Relationship Id="rId1" Type="${ns}officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
      { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${ns}spreadsheetml/2006/main" xmlns:r="${ns}officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name).slice(0, 31)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
      { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${ns}package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${ns}officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="${ns}officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
      { name: 'xl/styles.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${ns}spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="4" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` },
      ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) }))
    ];
    return zip(files);
  }

  // ---------- Lectura ----------
  async function inflate(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('Este navegador no puede leer archivos comprimidos');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function unzip(buf) {
    const u8 = new Uint8Array(buf), dv = new DataView(buf), out = {};
    let e = u8.length - 22;
    while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error('No es un archivo .xlsx válido');
    const count = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true);
    const dec = new TextDecoder();
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      out[name] = { method, csize, lho };
      p += 46 + nlen + xlen + clen;
    }
    return async name => {
      const f = out[name]; if (!f) return null;
      const start = f.lho + 30 + dv.getUint16(f.lho + 26, true) + dv.getUint16(f.lho + 28, true);
      const data = u8.subarray(start, start + f.csize);
      return dec.decode(f.method === 0 ? data : await inflate(data));
    };
  }

  const textOf = xml => { let s = ''; xml.replace(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, (_, t) => { s += unesc(t); }); return s; };

  async function read(buf) {
    const get = await unzip(buf);
    const wb = await get('xl/workbook.xml') || '';
    const rels = await get('xl/_rels/workbook.xml.rels') || '';
    const relMap = {}; rels.replace(/<Relationship\b([^>]*)\/?>/g, (_, a) => { const id = /Id="([^"]+)"/.exec(a), t = /Target="([^"]+)"/.exec(a); if (id && t) relMap[id[1]] = t[1]; });
    const ssXml = await get('xl/sharedStrings.xml');
    const shared = []; if (ssXml) ssXml.replace(/<si>([\s\S]*?)<\/si>/g, (_, si) => { shared.push(textOf(si.replace(/<rPh[\s\S]*?<\/rPh>/g, ''))); });
    const sheets = [];
    const defs = []; wb.replace(/<sheet\b([^>]*)\/?>/g, (_, a) => { const n = /name="([^"]*)"/.exec(a), r = /r:id="([^"]+)"/.exec(a); defs.push({ name: n ? unesc(n[1]) : 'Hoja', rid: r && r[1] }); });
    if (!defs.length) defs.push({ name: 'Hoja1', path: 'xl/worksheets/sheet1.xml' });
    for (const d of defs) {
      let path = d.path || relMap[d.rid] || '';
      path = path.replace(/^\/?xl\//, '').replace(/^\//, ''); path = 'xl/' + path;
      const xml = await get(path); if (!xml) continue;
      const rows = [];
      xml.replace(/<row\b[^>]*>([\s\S]*?)<\/row>/g, (_, rx) => {
        const row = []; let auto = 0;
        rx.replace(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (__, attrs, inner = '') => {
          const r = /\br="([A-Z]+)\d+"/.exec(attrs), t = (/\bt="([^"]+)"/.exec(attrs) || [])[1];
          const ci = r ? colIndex(r[1]) : auto; auto = ci + 1;
          const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
          let v = null;
          if (t === 's') v = vm ? shared[+vm[1]] : null;
          else if (t === 'inlineStr') v = textOf(inner);
          else if (t === 'str' || t === 'e') v = vm ? unesc(vm[1]) : null;
          else if (t === 'b') v = vm ? vm[1] === '1' : null;
          else v = vm ? Number(vm[1]) : null;
          row[ci] = v;
        });
        rows.push(row);
      });
      sheets.push({ name: d.name, rows });
    }
    return sheets;
  }

  const serialToYMD = n => { const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 864e5); return d.toISOString().slice(0, 10); };
  root.XLSXLite = { write, read, serialToYMD };
})(typeof window !== 'undefined' ? window : globalThis);

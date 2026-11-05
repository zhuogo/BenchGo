import { read, utils } from 'xlsx';
let workbook;
self.onmessage = ({ data }) => {
  try {
    if (data.bytes) workbook = read(data.bytes, { type: 'array', dense: true, sheetRows: 10001, cellFormula: false, cellHTML: false, cellStyles: false, bookVBA: false });
    const names = workbook.SheetNames;
    const index = Math.max(0, Math.min(names.length - 1, data.index || 0));
    const sheet = workbook.Sheets[names[index]];
    if (!sheet || !sheet['!ref']) { self.postMessage({ names, index, rows: [], columns: [], truncated: false }); return; }
    const range = utils.decode_range(sheet['!ref']), full = utils.decode_range(sheet['!fullref'] || sheet['!ref']);
    range.e.r = Math.min(range.e.r, range.s.r + 9999); range.e.c = Math.min(range.e.c, range.s.c + 99);
    const rows = utils.sheet_to_json(sheet, { header: 1, range, raw: false, defval: '', blankrows: true });
    self.postMessage({ names, index, rows, columns: Array.from({ length: range.e.c - range.s.c + 1 }, (_, i) => utils.encode_col(i + range.s.c)), startRow: range.s.r + 1, truncated: full.e.r > range.e.r || full.e.c > range.e.c });
  } catch (error) { self.postMessage({ error: '表格解析失败：' + error.message }); }
};

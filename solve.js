// Faster drop-in for csv-reader 1.0.0 (make.fun's own reference program).
// run(input) returns exactly csv-reader 1.0.0's answer {columns, rows, errors}
// for every case input {text, header}.
//
// Same reading policy as the reference (vendor/csv-reader/index.js), single pass,
// left to right: U+FEFF at the very start dropped; a record ends at LF or CRLF;
// a line left with no characters is no record; outside quotes a CR not followed
// by LF is dropped (stray_cr); a field opening with a quote runs to the next
// quote that is not doubled, "" inside it one quote, each CRLF or lone CR inside
// it read as LF; what follows its closing quote, up to the next comma or line
// break, is appended as it stands (quote_junk, when the field ends); a quote
// that never closes is a literal character and the text after it is read again
// as unquoted (unterminated_quote); a quote inside an unquoted field is literal.
// Fields stay strings. columns is the first record when header is true, else
// null; rows holds the records after it, each padded (short_row) or cut
// (long_row) to the first record's width. Errors are {code, line, row} in the
// order met; line is the 1-based line its record starts on, row its record's
// index in rows (null for the header).
//
// Speed: fields are taken with String.slice over runs the scanner delimits, so
// the common unquoted field costs no per-character string building; quoted
// fields jump to the closing quote with indexOf and only rebuild when they
// hold doubled quotes or a CR inside. No regex, no split on the hot path.

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let i = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xFEFF) i = 1;

  // The line of the record being read and its index in rows (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // Count of '\n' in text[a..b).
  function countLF(a, b) {
    let c = 0;
    let p = a;
    while (true) {
      const k = text.indexOf('\n', p);
      if (k === -1 || k >= b) return c;
      c++;
      p = k + 1;
    }
  }

  // Quoted body text[a..b) known to hold a CR: rebuild it, "" to one quote and
  // each CRLF or lone CR to LF, counting the line breaks it holds.
  function slowQuoted(a, b) {
    let v = '';
    let p = a;
    let runStart = a;
    while (p < b) {
      const ch = text.charCodeAt(p);
      if (ch === 34) {
        // Doubled quote: every '"' before the closing quote is one.
        if (p > runStart) v += text.slice(runStart, p);
        v += '"';
        p += 2;
        runStart = p;
      } else if (ch === 13) {
        if (p > runStart) v += text.slice(runStart, p);
        v += '\n';
        line++;
        p += text.charCodeAt(p + 1) === 10 ? 2 : 1;
        runStart = p;
      } else if (ch === 10) {
        if (p > runStart) v += text.slice(runStart, p);
        v += '\n';
        line++;
        p++;
        runStart = p;
      } else {
        p++;
      }
    }
    if (p > runStart) v += text.slice(runStart, p);
    return v;
  }

  while (true) {
    // Lines with no characters are no records.
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 10) {
        i++;
        line++;
      } else if (c === 13 && text.charCodeAt(i + 1) === 10) {
        i += 2;
        line++;
      } else {
        break;
      }
    }
    if (i >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let lastQuoted = false;
    let recEnded = false;
    while (!recEnded) {
      // One field, starting at i.
      let value;
      let ended; // 0: comma (record goes on), 1: line break, 2: end of text
      lastQuoted = i < n && text.charCodeAt(i) === 34;
      // scanInit !== null: read the field (or its rest) as unquoted from i,
      // starting from this value; wantAdded counts the kept characters, for
      // quote_junk.
      // starting from this value; wantAdded counts the kept characters, for
      // quote_junk.
      let scanInit = null;
      let wantAdded = false;
      if (lastQuoted) {
        const open = i;
        const openLine = line;
        let segStart = i + 1;
        let segs = null; // [start, end) pairs of the segments between "" pairs
        let q = text.indexOf('"', segStart);
        while (q !== -1 && text.charCodeAt(q + 1) === 34) {
          if (segs === null) segs = [];
          segs.push(segStart, q);
          segStart = q + 2;
          q = text.indexOf('"', segStart);
        }
        if (q === -1) {
          // The quote never closes: it is a literal character, and the text
          // after it is read again as unquoted.
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          i = open + 1;
          line = openLine;
          scanInit = '"';
        } else {
          let content;
          const crAt = text.indexOf('\r', i + 1);
          if (crAt !== -1 && crAt < q) {
            content = slowQuoted(i + 1, q);
          } else {
            if (segs === null) {
              content = text.slice(segStart, q);
            } else {
              const parts = [];
              for (let s = 0; s < segs.length; s += 2) parts.push(text.slice(segs[s], segs[s + 1]));
              parts.push(text.slice(segStart, q));
              content = parts.join('"');
            }
            line += countLF(i + 1, q);
          }
          i = q + 1;
          if (i >= n) {
            value = content;
            ended = 2;
          } else {
            const c = text.charCodeAt(i);
            if (c === 44) {
              value = content;
              ended = 0;
              i++;
            } else if (c === 10) {
              value = content;
              ended = 1;
              i++;
              line++;
            } else if (c === 13 && text.charCodeAt(i + 1) === 10) {
              value = content;
              ended = 1;
              i += 2;
              line++;
            } else {
              // What follows the closing quote is appended as it stands.
              scanInit = content;
              wantAdded = true;
            }
          }
        }
      } else {
        scanInit = '';
      }
      if (scanInit !== null) {
        // Unquoted read from i, starting from scanInit: a CR not followed by
        // LF is dropped (stray_cr). Ends at a comma, a line break or the end.
        const scanStart0 = i;
        let scanStart = i;
        let scanParts = null; // [start, end) pairs kept around dropped CRs
        let dropped = 0;
        let j = i;
        while (j < n) {
          const c = text.charCodeAt(j);
          if (c === 44 || c === 10) break;
          if (c === 13) {
            if (text.charCodeAt(j + 1) === 10) break;
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            if (scanParts === null) scanParts = [];
            scanParts.push(scanStart, j);
            dropped++;
            j++;
            scanStart = j;
            continue;
          }
          j++;
        }
        const contentEnd = j;
        if (j >= n) {
          ended = 2;
        } else {
          const c = text.charCodeAt(j);
          if (c === 44) {
            ended = 0;
            j++;
          } else if (c === 10) {
            ended = 1;
            j++;
            line++;
          } else {
            ended = 1;
            j += 2;
            line++;
          }
        }
        i = j;
        if (scanParts === null) {
          value = scanInit === '' ? text.slice(scanStart0, contentEnd) : scanInit + text.slice(scanStart0, contentEnd);
        } else {
          const parts = [];
          for (let s = 0; s < scanParts.length; s += 2) parts.push(text.slice(scanParts[s], scanParts[s + 1]));
          parts.push(text.slice(scanStart, contentEnd));
          value = scanInit + parts.join('');
        }
        if (wantAdded && contentEnd - scanStart0 - dropped > 0) {
          errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        }
      }
      fields.push(value);
      if (ended !== 0) recEnded = true;
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

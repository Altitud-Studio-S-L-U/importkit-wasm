//! CSV parsing in the dialect of ImportKit's `csvReader()`. `docs/design.md` states the rules this
//! parser implements and the order in which it reports errors.
#![deny(unsafe_code)]

#[cfg(target_arch = "wasm32")]
mod abi;

/// Why parsing stopped. The JavaScript reader maps each kind to an ImportKit error.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    /// The input is not valid UTF-8.
    Utf8 = 1,
    /// A quote breaks rule 5 or 8 of the dialect.
    Syntax = 2,
    /// A record has a different number of fields than the header.
    FieldCount = 3,
    /// A record's serialized bytes exceed the limit.
    RecordSize = 4,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Error {
    pub kind: ErrorKind,
    /// Line of the record being read; absent for UTF-8 errors.
    pub line: Option<u64>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Newline {
    Unknown,
    Lf,
    CrLf,
    Cr,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    FieldStart,
    Unquoted,
    Quoted,
    /// A quote inside a quoted field: an escaped quote if another follows, otherwise the closing quote.
    QuoteInQuoted,
    /// A CR outside quotes whose meaning depends on the next byte. `from` is the state it interrupted.
    AfterCr {
        from: Interrupted,
    },
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Interrupted {
    FieldStart,
    Unquoted,
    ClosedQuote,
}

const BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

/// A streaming parser. Feed it pieces of input, read the completed records, then `consume()` them.
pub struct Parser {
    delimiter: u8,
    max_record_bytes: u64,
    newline: Newline,
    state: State,
    /// Bytes of a possible byte order mark seen so far, or `None` once decided.
    bom_seen: Option<usize>,
    utf8_need: u8,
    utf8_lower: u8,
    utf8_upper: u8,
    line_feeds: u64,
    record_bytes: u64,
    record_line: u64,
    fields_in_record: u32,
    expected_fields: Option<u32>,
    error: Option<Error>,
    /// Unescaped content of completed fields, then of the partial record.
    out: Vec<u8>,
    /// End of each field in UTF-16 code units from the start of `out`.
    ends: Vec<u32>,
    /// Field count and line of each completed record.
    counts: Vec<u32>,
    lines: Vec<f64>,
    units: u32,
    done_out: usize,
    done_ends: usize,
    done_units: u32,
}

impl Parser {
    /// `delimiter` must be an ASCII byte other than quote, CR, LF and NUL; the JavaScript reader checks it.
    pub fn new(delimiter: u8, max_record_bytes: u64) -> Self {
        Parser {
            delimiter,
            max_record_bytes,
            newline: Newline::Unknown,
            state: State::FieldStart,
            bom_seen: Some(0),
            utf8_need: 0,
            utf8_lower: 0x80,
            utf8_upper: 0xBF,
            line_feeds: 0,
            record_bytes: 0,
            record_line: 1,
            fields_in_record: 0,
            expected_fields: None,
            error: None,
            out: Vec::new(),
            ends: Vec::new(),
            counts: Vec::new(),
            lines: Vec::new(),
            units: 0,
            done_out: 0,
            done_ends: 0,
            done_units: 0,
        }
    }

    pub fn error(&self) -> Option<Error> {
        self.error
    }

    /// Parses the next piece of input. Records completed before an error stay readable.
    pub fn feed(&mut self, input: &[u8]) -> Result<(), Error> {
        if let Some(error) = self.error {
            return Err(error);
        }
        let mut index = 0;
        while index < input.len() {
            let run = self.plain_run(&input[index..]);
            if run > 0 {
                self.append_plain(&input[index..index + run]);
                index += run;
                continue;
            }
            if let Err(error) = self.byte(input[index]) {
                self.error = Some(error);
                return Err(error);
            }
            index += 1;
        }
        Ok(())
    }

    /// Length of the leading bytes that byte-by-byte parsing would only append to the current field: ASCII inside a
    /// field that is neither a quote nor a line feed, nor, outside quotes, the delimiter or a CR, within the record's
    /// remaining byte budget. Such bytes are valid UTF-8 on their own and change no line count, so they are copied
    /// at once. Every other byte takes the full path.
    fn plain_run(&self, input: &[u8]) -> usize {
        if self.bom_seen.is_some() || self.utf8_need != 0 {
            return 0;
        }
        let quoted = match self.state {
            State::Unquoted => false,
            State::Quoted => true,
            _ => return 0,
        };
        let delimiter = self.delimiter;
        let budget = (self.max_record_bytes - self.record_bytes).min(input.len() as u64) as usize;
        input[..budget]
            .iter()
            .position(|&byte| {
                byte >= 0x80
                    || byte == b'"'
                    || byte == b'\n'
                    || (!quoted && (byte == delimiter || byte == b'\r'))
            })
            .unwrap_or(budget)
    }

    fn append_plain(&mut self, bytes: &[u8]) {
        self.out.extend_from_slice(bytes);
        self.units += bytes.len() as u32;
        self.record_bytes += bytes.len() as u64;
    }

    /// Ends the input: completes the last record or reports why it cannot be completed.
    pub fn finish(&mut self) -> Result<(), Error> {
        if let Some(error) = self.error {
            return Err(error);
        }
        let result = self.end_of_input();
        if let Err(error) = result {
            self.error = Some(error);
        }
        result
    }

    fn end_of_input(&mut self) -> Result<(), Error> {
        if let Some(seen) = self.bom_seen.take() {
            for &byte in &BOM[..seen] {
                self.after_bom(byte)?;
            }
        }
        if self.utf8_need > 0 {
            return Err(Error {
                kind: ErrorKind::Utf8,
                line: None,
            });
        }
        if let State::AfterCr { from } = self.state {
            self.lone_cr(from)?;
        }
        match self.state {
            State::Quoted => Err(self.syntax()),
            State::FieldStart if self.fields_in_record == 0 => Ok(()),
            _ => {
                self.end_field();
                self.end_record()
            }
        }
    }

    fn byte(&mut self, byte: u8) -> Result<(), Error> {
        if let Some(seen) = self.bom_seen {
            if byte == BOM[seen] {
                if seen == 2 {
                    // The mark is skipped but its bytes belong to the first record.
                    self.bom_seen = None;
                    for &held in &BOM {
                        self.validate_utf8(held)?;
                        self.count(held)?;
                    }
                } else {
                    self.bom_seen = Some(seen + 1);
                }
                return Ok(());
            }
            self.bom_seen = None;
            for &held in &BOM[..seen] {
                self.after_bom(held)?;
            }
        }
        self.after_bom(byte)
    }

    /// A byte of input once the byte order mark is decided. Held mark bytes are not counted until then.
    fn after_bom(&mut self, byte: u8) -> Result<(), Error> {
        // A pending CR is resolved first: whatever it completes precedes this byte in the source.
        if let State::AfterCr { from } = self.state
            && byte != b'\n'
        {
            self.lone_cr(from)?;
        }
        self.validate_utf8(byte)?;
        self.count(byte)?;
        self.dialect(byte)
    }

    /// A CR outside quotes that no LF follows: the first record delimiter, or content when CRLF is the delimiter.
    fn lone_cr(&mut self, from: Interrupted) -> Result<(), Error> {
        if self.newline == Newline::Unknown {
            self.newline = Newline::Cr;
            self.end_field();
            return self.end_record();
        }
        self.cr_as_content(from)
    }

    fn validate_utf8(&mut self, byte: u8) -> Result<(), Error> {
        if self.utf8_need == 0 {
            match byte {
                0x00..=0x7F => {}
                0xC2..=0xDF => self.utf8_need = 1,
                0xE0..=0xEF => {
                    if byte == 0xE0 {
                        self.utf8_lower = 0xA0;
                    } else if byte == 0xED {
                        self.utf8_upper = 0x9F;
                    }
                    self.utf8_need = 2;
                }
                0xF0..=0xF4 => {
                    if byte == 0xF0 {
                        self.utf8_lower = 0x90;
                    } else if byte == 0xF4 {
                        self.utf8_upper = 0x8F;
                    }
                    self.utf8_need = 3;
                }
                _ => {
                    return Err(Error {
                        kind: ErrorKind::Utf8,
                        line: None,
                    });
                }
            }
            return Ok(());
        }
        if byte < self.utf8_lower || byte > self.utf8_upper {
            return Err(Error {
                kind: ErrorKind::Utf8,
                line: None,
            });
        }
        self.utf8_lower = 0x80;
        self.utf8_upper = 0xBF;
        self.utf8_need -= 1;
        Ok(())
    }

    /// Counts a byte toward the current record and the line count.
    fn count(&mut self, byte: u8) -> Result<(), Error> {
        self.record_bytes += 1;
        if self.record_bytes > self.max_record_bytes {
            return Err(Error {
                kind: ErrorKind::RecordSize,
                line: Some(self.record_line),
            });
        }
        if byte == b'\n' {
            self.line_feeds += 1;
        }
        Ok(())
    }

    fn dialect(&mut self, byte: u8) -> Result<(), Error> {
        match self.state {
            State::FieldStart => self.outside_quotes(byte, Interrupted::FieldStart),
            State::Unquoted => self.outside_quotes(byte, Interrupted::Unquoted),
            State::Quoted => {
                if byte == b'"' {
                    self.state = State::QuoteInQuoted;
                } else {
                    self.push(byte);
                }
                Ok(())
            }
            State::QuoteInQuoted => {
                if byte == b'"' {
                    self.push(b'"');
                    self.state = State::Quoted;
                    Ok(())
                } else {
                    self.outside_quotes(byte, Interrupted::ClosedQuote)
                }
            }
            // `after_bom` resolves a CR that no LF follows, so only CRLF reaches this state.
            State::AfterCr { .. } => {
                self.newline = Newline::CrLf;
                self.end_field();
                self.end_record()
            }
        }
    }

    /// A byte at the start of a field, inside an unquoted field, or right after a closing quote.
    fn outside_quotes(&mut self, byte: u8, from: Interrupted) -> Result<(), Error> {
        if byte == self.delimiter {
            self.end_field();
            return Ok(());
        }
        match (byte, self.newline) {
            (b'\n', Newline::Unknown | Newline::Lf) => {
                self.newline = Newline::Lf;
                self.end_field();
                return self.end_record();
            }
            (b'\r', Newline::Cr) => {
                self.end_field();
                return self.end_record();
            }
            (b'\r', Newline::Unknown | Newline::CrLf) => {
                self.state = State::AfterCr { from };
                return Ok(());
            }
            _ => {}
        }
        match from {
            Interrupted::ClosedQuote => Err(self.syntax()),
            Interrupted::FieldStart if byte == b'"' => {
                self.state = State::Quoted;
                Ok(())
            }
            Interrupted::Unquoted if byte == b'"' => Err(self.syntax()),
            _ => {
                self.push(byte);
                self.state = State::Unquoted;
                Ok(())
            }
        }
    }

    /// The pending CR is not a record delimiter: content of an unquoted field, or an error after a closing quote.
    fn cr_as_content(&mut self, from: Interrupted) -> Result<(), Error> {
        match from {
            Interrupted::ClosedQuote => Err(self.syntax()),
            Interrupted::FieldStart | Interrupted::Unquoted => {
                self.push(b'\r');
                self.state = State::Unquoted;
                Ok(())
            }
        }
    }

    fn syntax(&self) -> Error {
        Error {
            kind: ErrorKind::Syntax,
            line: Some(self.record_line),
        }
    }

    #[inline(always)]
    fn push(&mut self, byte: u8) {
        self.out.push(byte);
        // UTF-16 code units: one per UTF-8 lead byte, two for a four-byte sequence.
        self.units += ((byte & 0xC0) != 0x80) as u32 + (byte >= 0xF0) as u32;
    }

    fn end_field(&mut self) {
        self.ends.push(self.units);
        self.fields_in_record += 1;
        self.state = State::FieldStart;
    }

    /// Completes the current record; the next one starts after the bytes counted so far.
    fn end_record(&mut self) -> Result<(), Error> {
        let count = self.fields_in_record;
        match self.expected_fields {
            None => self.expected_fields = Some(count),
            Some(expected) if expected != count => {
                return Err(Error {
                    kind: ErrorKind::FieldCount,
                    line: Some(self.record_line),
                });
            }
            Some(_) => {}
        }
        self.counts.push(count);
        self.lines.push(self.record_line as f64);
        self.fields_in_record = 0;
        self.state = State::FieldStart;
        self.record_bytes = 0;
        self.record_line = self.line_feeds + 1;
        self.done_out = self.out.len();
        self.done_ends = self.ends.len();
        self.done_units = self.units;
        Ok(())
    }

    /// Completed records not yet consumed.
    pub fn records(&self) -> usize {
        self.counts.len()
    }

    pub fn completed_content(&self) -> &[u8] {
        &self.out[..self.done_out]
    }

    pub fn field_ends(&self) -> &[u32] {
        &self.ends[..self.done_ends]
    }

    pub fn field_counts(&self) -> &[u32] {
        &self.counts
    }

    pub fn record_lines(&self) -> &[f64] {
        &self.lines
    }

    /// Drops the completed records the caller has read; a partial record's offsets are rebased.
    pub fn consume(&mut self) {
        self.out.drain(..self.done_out);
        self.ends.drain(..self.done_ends);
        for end in self.ends.iter_mut() {
            *end -= self.done_units;
        }
        self.units -= self.done_units;
        self.done_units = 0;
        self.done_out = 0;
        self.done_ends = 0;
        self.counts.clear();
        self.lines.clear();
    }
}

#[cfg(test)]
mod tests;

use super::{Error, ErrorKind, Parser};

type Record = (Vec<String>, u64);

/// Parses `input` in pieces of `piece` bytes and decodes the records the way the JavaScript reader does.
fn parse_in_pieces(
    input: &[u8],
    piece: usize,
    delimiter: u8,
    max: u64,
) -> (Vec<Record>, Option<Error>) {
    let mut parser = Parser::new(delimiter, max);
    let mut records = Vec::new();
    let mut drain = |parser: &mut Parser| {
        let text: Vec<u16> = String::from_utf8(parser.completed_content().to_vec())
            .unwrap()
            .encode_utf16()
            .collect();
        let ends = parser.field_ends();
        let mut field = 0;
        let mut start = 0;
        for (count, line) in parser.field_counts().iter().zip(parser.record_lines()) {
            let mut fields = Vec::new();
            for _ in 0..*count {
                let end = ends[field] as usize;
                fields.push(String::from_utf16(&text[start..end]).unwrap());
                start = end;
                field += 1;
            }
            records.push((fields, *line as u64));
        }
        parser.consume();
    };
    for chunk in input.chunks(piece.max(1)) {
        let result = parser.feed(chunk);
        drain(&mut parser);
        if let Err(error) = result {
            return (records, Some(error));
        }
    }
    let result = parser.finish();
    drain(&mut parser);
    (records, result.err())
}

/// Parses with a comma delimiter and checks that every way of splitting the input gives the same result.
fn parse(input: &[u8], max: u64) -> (Vec<Record>, Option<Error>) {
    let whole = parse_in_pieces(input, input.len(), b',', max);
    for piece in [1, 2, 3, 7] {
        assert_eq!(
            parse_in_pieces(input, piece, b',', max),
            whole,
            "piece size {piece} of {input:?}"
        );
    }
    whole
}

fn ok(input: &str) -> Vec<Record> {
    let (records, error) = parse(input.as_bytes(), u64::MAX);
    assert_eq!(error, None, "{input:?}");
    records
}

fn r(fields: &[&str], line: u64) -> Record {
    (fields.iter().map(|field| field.to_string()).collect(), line)
}

fn error(kind: ErrorKind, line: u64) -> Option<Error> {
    Some(Error {
        kind,
        line: Some(line),
    })
}

const UTF8: Option<Error> = Some(Error {
    kind: ErrorKind::Utf8,
    line: None,
});

#[test]
fn records_end_at_lf_crlf_or_a_lone_cr() {
    assert_eq!(ok("a,b\n1,2\n"), vec![r(&["a", "b"], 1), r(&["1", "2"], 2)]);
    assert_eq!(
        ok("a,b\r\n1,2\r\n"),
        vec![r(&["a", "b"], 1), r(&["1", "2"], 2)]
    );
    // CR alone does not start a line, so every record is on line 1.
    assert_eq!(ok("a,b\r1,2\r"), vec![r(&["a", "b"], 1), r(&["1", "2"], 1)]);
    assert_eq!(ok("a,b\n1,2"), vec![r(&["a", "b"], 1), r(&["1", "2"], 2)]);
}

#[test]
fn the_first_record_delimiter_found_is_the_only_one() {
    // LF first: a later CR is content.
    assert_eq!(ok("a\n1\r\n"), vec![r(&["a"], 1), r(&["1\r"], 2)]);
    // CRLF first: a lone LF or CR is content.
    assert_eq!(
        ok("a\r\nx\ny\rz\r\n"),
        vec![r(&["a"], 1), r(&["x\ny\rz"], 2)]
    );
    // CR first: LF is content.
    assert_eq!(ok("a\r1\n2\r"), vec![r(&["a"], 1), r(&["1\n2"], 1)]);
    // Line breaks inside quotes do not decide the delimiter.
    assert_eq!(
        ok("\"a\r\nb\"\n1\r\n"),
        vec![r(&["a\r\nb"], 1), r(&["1\r"], 3)]
    );
}

#[test]
fn quoted_fields_hold_delimiters_line_breaks_and_escaped_quotes() {
    assert_eq!(
        ok("id,note\n1,\"a, \"\"b\"\"\nc\"\n2,\"\"\n"),
        vec![
            r(&["id", "note"], 1),
            r(&["1", "a, \"b\"\nc"], 2),
            r(&["2", ""], 4),
        ]
    );
    assert_eq!(
        ok("a,b\n\"x\",\"y\"\n"),
        vec![r(&["a", "b"], 1), r(&["x", "y"], 2)]
    );
    // A quoted empty field at the end of input is still a record.
    assert_eq!(ok("a\n\"\""), vec![r(&["a"], 1), r(&[""], 2)]);
}

#[test]
fn empty_lines_are_records_and_a_trailing_delimiter_is_not() {
    assert_eq!(ok(""), vec![]);
    assert_eq!(ok("id\n"), vec![r(&["id"], 1)]);
    assert_eq!(
        ok("id\n\n2\n"),
        vec![r(&["id"], 1), r(&[""], 2), r(&["2"], 3)]
    );
    assert_eq!(ok("a,b\n,\n"), vec![r(&["a", "b"], 1), r(&["", ""], 2)]);
    assert_eq!(ok("a,b\n1,"), vec![r(&["a", "b"], 1), r(&["1", ""], 2)]);
}

#[test]
fn a_byte_order_mark_is_skipped_even_when_split() {
    assert_eq!(ok("\u{FEFF}id\n1\n"), vec![r(&["id"], 1), r(&["1"], 2)]);
    assert_eq!(ok("\u{FEFF}"), vec![]);
    // Only a mark at the start is skipped.
    assert_eq!(
        ok("id\n\u{FEFF}1\n"),
        vec![r(&["id"], 1), r(&["\u{FEFF}1"], 2)]
    );
    assert_eq!(parse(&[0xEF, 0xBB, b'a'], u64::MAX), (vec![], UTF8));
    assert_eq!(parse(&[0xEF, 0xBB], u64::MAX), (vec![], UTF8));
}

#[test]
fn utf16_offsets_cover_multibyte_text() {
    assert_eq!(
        ok("name,city\nñandú,東京🚀\n"),
        vec![r(&["name", "city"], 1), r(&["ñandú", "東京🚀"], 2)]
    );
}

#[test]
fn quotes_in_the_wrong_place_are_errors_at_the_record_line() {
    assert_eq!(
        parse(b"id\n1\nab\"c\n", u64::MAX),
        (
            vec![r(&["id"], 1), r(&["1"], 2)],
            error(ErrorKind::Syntax, 3)
        )
    );
    assert_eq!(
        parse(b"id\n\"a\"b\n", u64::MAX).1,
        error(ErrorKind::Syntax, 2)
    );
    assert_eq!(
        parse(b"id,note\n1,\"a\nb\"\n2,\"open\nstill open", u64::MAX).1,
        error(ErrorKind::Syntax, 4)
    );
    // Once LF is the delimiter, a closing quote cannot be followed by CR.
    assert_eq!(
        parse(b"id\n\"a\"\r\n", u64::MAX).1,
        error(ErrorKind::Syntax, 2)
    );
    // Once CRLF is the delimiter, a closing quote cannot be followed by a lone CR or LF.
    assert_eq!(
        parse(b"id\r\n\"a\"\rb\r\n", u64::MAX).1,
        error(ErrorKind::Syntax, 2)
    );
    assert_eq!(
        parse(b"id\r\n\"a\"\n", u64::MAX).1,
        error(ErrorKind::Syntax, 2)
    );
    assert_eq!(
        parse(b"id\r\n\"a\"\r", u64::MAX).1,
        error(ErrorKind::Syntax, 2)
    );
}

#[test]
fn every_record_needs_the_header_field_count() {
    assert_eq!(
        parse(b"id,note\n1,a\n2\n", u64::MAX),
        (
            vec![r(&["id", "note"], 1), r(&["1", "a"], 2)],
            error(ErrorKind::FieldCount, 3)
        )
    );
    assert_eq!(
        parse(b"a,b\n1,2\n\n", u64::MAX).1,
        error(ErrorKind::FieldCount, 3)
    );
}

#[test]
fn invalid_utf8_is_rejected_where_it_occurs() {
    for input in [
        &b"id\n\xC3\x28\n"[..],
        b"\xC0\x80",
        b"\xED\xA0\x80",
        b"\xF4\x90\x80\x80",
        b"\xF5",
        b"\x80",
        b"id\n\xE2\x82",
    ] {
        assert_eq!(parse(input, u64::MAX).1, UTF8, "{input:?}");
    }
    // The records before the invalid byte are complete.
    assert_eq!(
        parse(b"id\n1\n\xFF", u64::MAX),
        (vec![r(&["id"], 1), r(&["1"], 2)], UTF8)
    );
}

#[test]
fn record_size_counts_every_byte_including_the_mark_and_the_terminator() {
    assert_eq!(parse(b"a,b\n1,2\n", 4).1, None);
    assert_eq!(parse(b"a,b\n1,2\n", 3).1, error(ErrorKind::RecordSize, 1));
    assert_eq!(parse("\u{FEFF}a\n".as_bytes(), 5).1, None);
    assert_eq!(
        parse("\u{FEFF}a\n".as_bytes(), 4).1,
        error(ErrorKind::RecordSize, 1)
    );
    assert_eq!(
        parse(b"id\n1\n12345\n", 4).1,
        error(ErrorKind::RecordSize, 3)
    );
    // Multibyte characters count as their bytes, and so do quotes and delimiters.
    assert_eq!(
        parse("a,b\n1,é\n".as_bytes(), 4).1,
        error(ErrorKind::RecordSize, 2)
    );
    assert_eq!(
        parse(b"a,b\n\"\",\"\"\n", 5).1,
        error(ErrorKind::RecordSize, 2)
    );
    // A record ended by a lone CR does not include the next record's first byte.
    assert_eq!(parse(b"ab\rcd\r", 3).1, None);
}

#[test]
fn an_unbounded_record_fails_before_the_rest_of_the_input() {
    let mut parser = Parser::new(b',', 16);
    assert_eq!(
        parser.feed(&[b','; 17]),
        Err(Error {
            kind: ErrorKind::RecordSize,
            line: Some(1)
        })
    );
    assert!(parser.completed_content().is_empty());
}

#[test]
fn a_declared_delimiter_replaces_the_comma() {
    let (records, error) = parse_in_pieces(b"id;name\n1;one,two\n", 3, b';', u64::MAX);
    assert_eq!(error, None);
    assert_eq!(
        records,
        vec![r(&["id", "name"], 1), r(&["1", "one,two"], 2)]
    );
}

#[test]
fn an_error_is_sticky() {
    let mut parser = Parser::new(b',', u64::MAX);
    let first = parser.feed(b"id\n\"a\"b");
    assert!(first.is_err());
    assert_eq!(parser.feed(b"\n"), first);
    assert_eq!(parser.finish(), first);
}

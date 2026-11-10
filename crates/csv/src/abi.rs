//! The WebAssembly interface: one parser per instance, with its buffers exposed as pointers and lengths into
//! linear memory. Pointers stay valid until the next call that feeds, finishes, consumes or starts.
// `#[unsafe(no_mangle)]` is how a function is exported; this module has no unsafe blocks.
#![allow(unsafe_code)]

use std::cell::RefCell;

use crate::{Error, Parser};

struct Instance {
    parser: Parser,
    input: Vec<u8>,
}

thread_local! {
    static INSTANCE: RefCell<Instance> = RefCell::new(Instance { parser: Parser::new(b',', u64::MAX), input: Vec::new() });
}

fn with<T>(action: impl FnOnce(&mut Instance) -> T) -> T {
    INSTANCE.with(|instance| action(&mut instance.borrow_mut()))
}

fn status(result: Result<(), Error>) -> u32 {
    match result {
        Ok(()) => 0,
        Err(error) => error.kind as u32,
    }
}

/// Starts a new input. `max_record_bytes` is a positive safe integer, checked by the caller.
#[unsafe(no_mangle)]
pub extern "C" fn start(delimiter: u32, max_record_bytes: f64) {
    with(|instance| {
        instance.parser = Parser::new(delimiter as u8, max_record_bytes as u64);
        instance.input = Vec::new();
    });
}

/// A buffer for the next `length` bytes of input.
#[unsafe(no_mangle)]
pub extern "C" fn input(length: u32) -> *mut u8 {
    with(|instance| {
        instance.input.resize(length as usize, 0);
        instance.input.as_mut_ptr()
    })
}

/// Parses the bytes written to the input buffer. Returns 0, or the `ErrorKind` that stopped parsing.
#[unsafe(no_mangle)]
pub extern "C" fn feed() -> u32 {
    with(|instance| {
        let Instance { parser, input } = instance;
        status(parser.feed(input))
    })
}

/// Ends the input. Returns 0, or the `ErrorKind` that stopped parsing.
#[unsafe(no_mangle)]
pub extern "C" fn finish() -> u32 {
    with(|instance| status(instance.parser.finish()))
}

/// Line of the record that caused the error, or 0 when the error has no line.
#[unsafe(no_mangle)]
pub extern "C" fn error_line() -> f64 {
    with(|instance| {
        instance
            .parser
            .error()
            .and_then(|error| error.line)
            .map_or(0.0, |line| line as f64)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn records() -> u32 {
    with(|instance| instance.parser.records() as u32)
}

#[unsafe(no_mangle)]
pub extern "C" fn content_ptr() -> *const u8 {
    with(|instance| instance.parser.completed_content().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn content_len() -> u32 {
    with(|instance| instance.parser.completed_content().len() as u32)
}

#[unsafe(no_mangle)]
pub extern "C" fn ends_ptr() -> *const u32 {
    with(|instance| instance.parser.field_ends().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn ends_len() -> u32 {
    with(|instance| instance.parser.field_ends().len() as u32)
}

#[unsafe(no_mangle)]
pub extern "C" fn counts_ptr() -> *const u32 {
    with(|instance| instance.parser.field_counts().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn lines_ptr() -> *const f64 {
    with(|instance| instance.parser.record_lines().as_ptr())
}

/// Drops the completed records after the caller has read them.
#[unsafe(no_mangle)]
pub extern "C" fn consume() {
    with(|instance| instance.parser.consume());
}

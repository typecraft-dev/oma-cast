use crate::engine::{Catalog, Entry, Hit, Sensitivity};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{self, BufRead, Read, Write};

pub(crate) const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

// Input: {"id":1,"entries":[{"title":"Firefox"}]}.
#[derive(Deserialize)]
struct LoadRequest {
    id: u64,
    entries: Vec<Entry>,
}

// Input: {"id":2,"query":"fire","sensitivity":"medium"}.
#[derive(Deserialize)]
struct SearchRequest {
    id: u64,
    query: String,
    #[serde(default)]
    sensitivity: Sensitivity,
}

#[derive(Serialize)]
#[serde(untagged)]
enum Response {
    Loaded { id: u64, loaded: usize },
    Hits { id: u64, hits: Vec<Hit> },
    Error {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<u64>,
        error: String,
    },
}

impl Response {
    fn error(id: Option<u64>, error: impl Into<String>) -> Self {
        Self::Error { id, error: error.into() }
    }
}

fn request(value: Value, catalog: &mut Catalog) -> Result<Response, String> {
    let object = value.as_object().ok_or("request must be an object")?;
    match (object.contains_key("entries"), object.contains_key("query")) {
        (true, false) => {
            let request: LoadRequest = serde_json::from_value(value)
                .map_err(|error| format!("invalid load request: {error}"))?;
            let loaded = catalog.load(request.entries)?;
            Ok(Response::Loaded { id: request.id, loaded })
        }
        (false, true) => {
            let request: SearchRequest = serde_json::from_value(value)
                .map_err(|error| format!("invalid search request: {error}"))?;
            let hits = catalog.search(&request.query, request.sensitivity)?;
            Ok(Response::Hits { id: request.id, hits })
        }
        _ => Err("request must contain exactly one of entries or query".into()),
    }
}

// Input is one complete JSON object per line; property order and unknown properties are unrestricted.
fn response(line: &[u8], catalog: &mut Catalog) -> Response {
    let value: Value = match serde_json::from_slice(line) {
        Ok(value) => value,
        Err(error) => return Response::error(None, format!("invalid JSON request: {error}")),
    };
    let id = value.get("id").and_then(Value::as_u64);
    request(value, catalog).unwrap_or_else(|error| Response::error(id, error))
}

fn drain_line(reader: &mut impl BufRead) -> io::Result<()> {
    loop {
        let bytes = reader.fill_buf()?;
        if bytes.is_empty() {
            return Ok(());
        }
        let newline = bytes.iter().position(|&byte| byte == b'\n');
        let consumed = newline.map_or(bytes.len(), |at| at + 1);
        reader.consume(consumed);
        if newline.is_some() {
            return Ok(());
        }
    }
}

pub(crate) fn run(mut reader: impl BufRead, writer: &mut impl Write) -> io::Result<()> {
    let mut catalog = Catalog::default();
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = reader.by_ref().take((MAX_LINE_BYTES + 1) as u64).read_until(b'\n', &mut line)?;
        if read == 0 {
            return Ok(());
        }
        if line.last() == Some(&b'\n') {
            line.pop();
        }
        let reply = if line.len() > MAX_LINE_BYTES {
            drain_line(&mut reader)?;
            Response::error(None, format!("request line exceeds {MAX_LINE_BYTES} bytes"))
        } else {
            response(&line, &mut catalog)
        };
        serde_json::to_writer(&mut *writer, &reply).map_err(|error| {
            io::Error::new(error.io_error_kind().unwrap_or(io::ErrorKind::Other), error)
        })?;
        writer.write_all(b"\n")?;
        writer.flush()?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Cursor};

    struct BrokenWriter {
        fail_flush: bool,
    }

    impl Write for BrokenWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.fail_flush {
                Ok(bytes.len())
            } else {
                Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed output"))
            }
        }

        fn flush(&mut self) -> io::Result<()> {
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed output"))
        }
    }

    #[test]
    fn write_and_flush_failure_stop_before_reading_next_request() {
        let first = b"{\"id\":1,\"entries\":[]}\n";
        let mut input = first.to_vec();
        input.extend_from_slice(b"{\"id\":2,\"query\":\"abc\"}\n");
        for fail_flush in [false, true] {
            let mut reader = Cursor::new(&input);
            let error = run(&mut reader, &mut BrokenWriter { fail_flush }).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::BrokenPipe);
            assert_eq!(reader.position(), first.len() as u64);
        }
    }

    #[test]
    fn oversized_drain_crosses_buffer_boundaries_and_preserves_following_line() {
        let mut input = vec![b'x'; MAX_LINE_BYTES + 37];
        input.extend_from_slice(b"\n{\"id\":2,\"entries\":[]}\n");
        let mut output = Vec::new();
        run(BufReader::with_capacity(7, Cursor::new(input)), &mut output).unwrap();
        let replies: Vec<Value> = output.split(|&byte| byte == b'\n').filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).unwrap()).collect();
        assert_eq!(replies.len(), 2);
        assert!(replies[0]["error"].as_str().unwrap().contains("exceeds"));
        assert_eq!(replies[1], serde_json::json!({"id":2,"loaded":0}));
    }
}

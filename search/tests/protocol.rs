use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};

const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
const MAX_FIELD_BYTES: usize = 16_384;
const MAX_FIELDS: usize = 1_024;
const MAX_ENTRIES: usize = 20_000;

fn exchange(input: &[u8]) -> Vec<Value> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_oma-cast-search"))
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert!(output.stderr.is_empty());
    assert!(output.stdout.ends_with(b"\n"));
    output.stdout.split(|&byte| byte == b'\n').filter(|line| !line.is_empty())
        .map(|line| serde_json::from_slice(line).unwrap()).collect()
}

fn encode(requests: &[Value]) -> Vec<u8> {
    let mut input = Vec::new();
    for request in requests {
        serde_json::to_writer(&mut input, request).unwrap();
        input.push(b'\n');
    }
    input
}

#[test]
fn reordered_fields_unknown_properties_missing_optional_fields_and_numeric_null_scores() {
    let output = exchange(concat!(
        "{\"future\":true,\"entries\":[{\"future\":{},\"title\":\"Firefox\"},{\"title\":\"zzzz\"}],\"id\":1}\r\n",
        "{\"sensitivity\":\"high\",\"query\":\"FIREFOX\",\"id\":18446744073709551615}\n",
        "{\"id\":3,\"query\":\"\"}\n"
    ).as_bytes());
    assert_eq!(output, vec![
        json!({"id":1,"loaded":2}),
        json!({"id":u64::MAX,"hits":[{"index":0,"title":5_000_000,"alternate":null,"subtitle":null,"keyword":null}]}),
        json!({"id":3,"hits":[]}),
    ]);
}

#[test]
fn errors_recover_and_invalid_reload_keeps_previous_entries() {
    let output = exchange(concat!(
        "{\"id\":0,\"query\":\"\"}\n",
        "{\"id\":1,\"entries\":[{\"title\":\"Old\"}]}\n",
        "{\"id\":2,\"entries\":[{\"title\":\"New\"},{}]}\n",
        "{\"id\":3,\"query\":\"old\"}\n",
        "not json\n",
        "{\"id\":4,\"query\":\"old\",\"entries\":[]}\n",
        "{\"id\":5,\"entries\":[{\"title\":\"New\"}]}\n",
        "{\"id\":6,\"query\":\"old\"}\n",
        "{\"id\":7,\"query\":\"new\"}\n",
        "{\"id\":8,\"entries\":[]}\n",
        "{\"id\":9,\"query\":\"new\"}"
    ).as_bytes());
    for (at, id) in [(0, 0), (2, 2), (5, 4)] {
        assert_eq!(output[at]["id"], id);
        assert!(output[at]["error"].is_string());
    }
    assert!(output[4].get("id").is_none());
    assert!(output[4]["error"].is_string());
    assert_eq!(output[3]["hits"][0]["title"], 5_000_000);
    assert_eq!(output[6], json!({"id":5,"loaded":1}));
    assert_eq!(output[7], json!({"id":6,"hits":[]}));
    assert_eq!(output[8]["hits"][0]["title"], 5_000_000);
    assert_eq!(output[9], json!({"id":8,"loaded":0}));
    assert_eq!(output[10], json!({"id":9,"hits":[]}));
}

#[test]
fn strict_shapes_reject_nulls_wrong_types_and_invalid_ids_then_recover() {
    let invalid = vec![
        json!({"id":1,"entries":[{}]}),
        json!({"id":2,"entries":[{"title":1}]}),
        json!({"id":3,"entries":[{"title":"x","subtitle":null}]}),
        json!({"id":4,"entries":[{"title":"x","alternateTitles":null}]}),
        json!({"id":5,"entries":[{"title":"x","alternateTitles":[1]}]}),
        json!({"id":6,"entries":[{"title":"x","keywords":[false]}]}),
        json!({"id":7,"entries":[{"title":"x","bundleId":null}]}),
        json!({"id":8,"entries":{}}),
        json!({"id":9,"entries":null}),
        json!({"id":10,"query":null}),
        json!({"id":11,"query":1}),
        json!({"id":12,"query":"x","sensitivity":"maximum"}),
        json!({"id":13,"query":"x","sensitivity":null}),
        json!({"id":14}),
        json!({"entries":[]}),
        json!({"id":-1,"entries":[]}),
        json!({"id":1.5,"entries":[]}),
        json!({"id":"1","entries":[]}),
        json!({"id":null,"entries":[]}),
        json!([]), json!(null), json!(false),
    ];
    let mut requests = vec![json!({"id":0,"entries":[{"title":"Keep"}]})];
    requests.extend(invalid.iter().cloned());
    requests.push(json!({"id":99,"query":"keep"}));
    let output = exchange(&encode(&requests));
    for (request, reply) in invalid.iter().zip(&output[1..]) {
        assert!(reply["error"].is_string(), "{request}: {reply}");
        assert_eq!(reply.get("id").and_then(Value::as_u64), request.get("id").and_then(Value::as_u64));
    }
    assert_eq!(output.last().unwrap()["hits"][0]["title"], 5_000_000);
}

#[test]
fn invalid_utf8_blank_line_and_multiple_json_values_do_not_poison_stream() {
    let mut input = b"\xff\n\n{} {}\n".to_vec();
    input.extend_from_slice(b"{\"id\":1,\"entries\":[]}\n{\"id\":2,\"query\":\"\"}\n");
    let output = exchange(&input);
    assert_eq!(output.len(), 5);
    for reply in &output[..3] {
        assert!(reply["error"].is_string());
        assert!(reply.get("id").is_none());
    }
    assert_eq!(output[3], json!({"id":1,"loaded":0}));
    assert_eq!(output[4], json!({"id":2,"hits":[]}));
}

#[test]
fn default_medium_and_channel_specific_high_filter_use_real_binary() {
    let output = exchange(&encode(&[
        json!({"id":1,"entries":[{"title":"Firefox","alternateTitles":["fierfox"],"subtitle":"Browser","keywords":["Browser"]}]}),
        json!({"id":2,"query":"fierfox"}),
        json!({"id":3,"query":"fierfox","sensitivity":"high"}),
        json!({"id":4,"query":"broxser","sensitivity":"low"}),
        json!({"id":5,"query":"broxser","sensitivity":"high"}),
    ]));
    assert_eq!(output[1]["hits"][0]["title"], 999_000);
    assert_eq!(output[2]["hits"][0]["title"], Value::Null);
    assert_eq!(output[2]["hits"][0]["alternate"], 5_000_000);
    assert_eq!(output[3]["hits"][0]["subtitle"], 999_000);
    assert_eq!(output[4]["hits"], json!([]));
}

#[test]
fn every_input_text_field_checks_byte_limit_before_replacing_catalog() {
    let oversized = "x".repeat(MAX_FIELD_BYTES + 1);
    let invalid = vec![
        json!({"title":oversized}),
        json!({"title":"New","subtitle":oversized}),
        json!({"title":"New","alternateTitles":[oversized]}),
        json!({"title":"New","keywords":[oversized]}),
        json!({"title":"New","bundleId":oversized}),
    ];
    let mut requests = vec![json!({"id":0,"entries":[{"title":"Keep"}]})];
    for (at, entry) in invalid.into_iter().enumerate() {
        requests.push(json!({"id":at + 1,"entries":[entry]}));
    }
    requests.push(json!({"id":6,"query":"keep"}));
    requests.push(json!({"id":7,"entries":[{"title":"x".repeat(MAX_FIELD_BYTES),"subtitle":"y".repeat(MAX_FIELD_BYTES)}]}));
    let output = exchange(&encode(&requests));
    for reply in &output[1..6] {
        assert!(reply["error"].as_str().unwrap().contains("16384 bytes"));
    }
    assert_eq!(output[6]["hits"][0]["title"], 5_000_000);
    assert_eq!(output[7], json!({"id":7,"loaded":1}));
}

#[test]
fn text_field_count_includes_title_optional_scalars_and_each_array_item() {
    let output = exchange(&encode(&[
        json!({"id":1,"entries":[{"title":"Keep","keywords":vec![""; MAX_FIELDS - 1]}]}),
        json!({"id":2,"entries":[{"title":"New","keywords":vec![""; MAX_FIELDS]}]}),
        json!({"id":3,"entries":[{"title":"Keep","subtitle":"","bundleId":"","alternateTitles":["",""],"keywords":vec![""; MAX_FIELDS - 5]}]}),
        json!({"id":4,"entries":[{"title":"New","subtitle":"","bundleId":"","alternateTitles":["",""],"keywords":vec![""; MAX_FIELDS - 4]}]}),
        json!({"id":5,"query":"keep"}),
    ]));
    assert_eq!(output[0], json!({"id":1,"loaded":1}));
    assert!(output[1]["error"].as_str().unwrap().contains("1024 text fields"));
    assert_eq!(output[2], json!({"id":3,"loaded":1}));
    assert!(output[3]["error"].as_str().unwrap().contains("1024 text fields"));
    assert_eq!(output[4]["hits"][0]["title"], 5_000_000);
}

#[test]
fn long_loads_accept_maximum_entry_count_and_reject_one_more_atomically() {
    let output = exchange(&encode(&[
        json!({"id":1,"entries":vec![json!({"title":"x"}); MAX_ENTRIES]}),
        json!({"id":2,"entries":vec![json!({"title":"y"}); MAX_ENTRIES + 1]}),
        json!({"id":3,"query":"x","sensitivity":"medium"}),
        json!({"id":4,"query":"y"}),
        json!({"id":5,"entries":[]}),
    ]));
    assert_eq!(output[0], json!({"id":1,"loaded":MAX_ENTRIES}));
    assert!(output[1]["error"].as_str().unwrap().contains("20000 candidates"));
    assert_eq!(output[2]["hits"].as_array().unwrap().len(), MAX_ENTRIES);
    assert!(output[2]["hits"].as_array().unwrap().iter().all(|hit| hit["title"] == 5_000_000));
    assert_eq!(output[3], json!({"id":4,"hits":[]}));
    assert_eq!(output[4], json!({"id":5,"loaded":0}));
}

#[test]
fn query_character_limit_errors_then_recovers() {
    let output = exchange(&encode(&[
        json!({"id":1,"entries":[{"title":"é".repeat(256)}]}),
        json!({"id":2,"query":"é".repeat(256)}),
        json!({"id":3,"query":"é".repeat(257)}),
        json!({"id":4,"query":"é".repeat(256)}),
    ]));
    assert_eq!(output[1]["hits"][0]["title"], 5_000_000);
    assert!(output[2]["error"].as_str().unwrap().contains("256 characters"));
    assert_eq!(output[3]["hits"][0]["title"], 5_000_000);
}

#[test]
fn wire_limit_accepts_boundary_and_drains_oversized_reload_before_recovery() {
    let mut input = encode(&[json!({"id":1,"entries":[{"title":"Keep"}]})]);
    let mut boundary = b"{\"id\":2,\"query\":\"\",\"padding\":\"".to_vec();
    boundary.resize(MAX_LINE_BYTES - 2, b'x');
    boundary.extend_from_slice(b"\"}");
    assert_eq!(boundary.len(), MAX_LINE_BYTES);
    input.extend_from_slice(&boundary);
    input.push(b'\n');
    input.extend_from_slice(b"{\"id\":3,\"entries\":[],\"padding\":\"");
    input.extend(std::iter::repeat(b'x').take(MAX_LINE_BYTES * 2));
    input.extend_from_slice(b"\"}\n{\"id\":4,\"query\":\"keep\"}\n");
    let output = exchange(&input);
    assert_eq!(output.len(), 4);
    assert_eq!(output[1], json!({"id":2,"hits":[]}));
    assert!(output[2]["error"].as_str().unwrap().contains("8388608 bytes"));
    assert!(output[2].get("id").is_none());
    assert_eq!(output[3]["hits"][0]["title"], 5_000_000);
}

#[test]
fn oversized_final_line_without_newline_reports_one_error() {
    let output = exchange(&vec![b'x'; MAX_LINE_BYTES + 1]);
    assert_eq!(output.len(), 1);
    assert!(output[0]["error"].as_str().unwrap().contains("8388608 bytes"));
}

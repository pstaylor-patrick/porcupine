import { describe, expect, it } from "vitest";
import { JsonlSplitter, toJsonl } from "../src/shared/jsonl.js";

describe("JsonlSplitter", () => {
  it("splits on LF only", () => {
    const s = new JsonlSplitter();
    expect(s.push('{"a":1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("keeps U+2028 and U+2029 inside a record", () => {
    const s = new JsonlSplitter();
    const text = "x y z";
    const [line] = s.push(Buffer.from(toJsonl({ text })));
    expect(line).toBeDefined();
    expect(JSON.parse(line as string)).toEqual({ text });
  });

  it("joins a record split mid-line across chunks", () => {
    const s = new JsonlSplitter();
    expect(s.push('{"id":')).toEqual([]);
    expect(s.push('"1"}\n{"id"')).toEqual(['{"id":"1"}']);
    expect(s.push(':"2"}\n')).toEqual(['{"id":"2"}']);
  });

  it("reassembles a UTF-8 sequence split across chunks", () => {
    const s = new JsonlSplitter();
    const bytes = Buffer.from('{"t":" é🦔"}\n', "utf8");
    const out: string[] = [];
    for (const byte of bytes) out.push(...s.push(Buffer.from([byte])));
    expect(out).toEqual(['{"t":" é🦔"}']);
  });

  it("strips a trailing CR", () => {
    const s = new JsonlSplitter();
    expect(s.push('{"a":1}\r\n')).toEqual(['{"a":1}']);
  });

  it("flushes an unterminated last line on end", () => {
    const s = new JsonlSplitter();
    expect(s.push('{"a":1}')).toEqual([]);
    expect(s.end()).toEqual(['{"a":1}']);
    expect(s.end()).toEqual([]);
  });
});

describe("toJsonl", () => {
  it("writes one LF-terminated record", () => {
    expect(toJsonl({ a: " " })).toBe('{"a":" "}\n');
  });
});

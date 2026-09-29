import { StringDecoder } from "node:string_decoder";

/**
 * Splits a byte stream into JSONL records on LF (0x0A) only.
 *
 * Unlike readline, U+2028 and U+2029 are not treated as line breaks, so they
 * survive inside JSON strings. A trailing CR on each record is stripped.
 * Multi-byte UTF-8 sequences split across chunks are reassembled.
 */
export class JsonlSplitter {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";

  /** Feeds a chunk and returns every complete line it finished. */
  push(chunk: Buffer | string): string[] {
    this.pending += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    const lines: string[] = [];
    let newline = this.pending.indexOf("\n");
    while (newline !== -1) {
      lines.push(stripCr(this.pending.slice(0, newline)));
      this.pending = this.pending.slice(newline + 1);
      newline = this.pending.indexOf("\n");
    }
    return lines;
  }

  /** Flushes a final unterminated line, if any. */
  end(): string[] {
    this.pending += this.decoder.end();
    const rest = this.pending;
    this.pending = "";
    return rest.length > 0 ? [stripCr(rest)] : [];
  }
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** Serializes one value as a single LF-terminated JSONL record. */
export function toJsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

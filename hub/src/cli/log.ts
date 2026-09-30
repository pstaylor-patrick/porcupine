export type LogFn = (line: string) => void;

function hhmmss(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Pane logger: `HH:MM:SS message`. */
export function createLogger(
  write: (s: string) => void = (s) => process.stderr.write(s),
  now: () => Date = () => new Date(),
): LogFn {
  return (line) => write(`${hhmmss(now())} ${line}\n`);
}

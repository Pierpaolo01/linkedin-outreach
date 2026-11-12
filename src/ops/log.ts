import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The app's file log: `app.log` in the data directory's `logs/`, one dated
 * line per entry, mode 600, rotated by size (app.log, app.log.1 ... app.log.4).
 * Lines carry ids and counts only, never names, profile URLs or message text.
 */

export type LogLevel = "INFO" | "WARN" | "ERROR";
export type LogFields = Readonly<Record<string, string | number | boolean>>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export interface FileLoggerOptions {
  /** The data directory's `logs/` folder. */
  readonly dir: string;
  readonly now?: () => Date;
  /** Rotate before a write would take app.log past this size. */
  readonly maxBytes?: number;
  /** Files kept in all, app.log included. */
  readonly files?: number;
}

export const LOG_FILE = "app.log";
const MAX_BYTES = 1024 * 1024;
const FILES = 5;

function oneLine(text: string): string {
  return text.replace(/\r?\n/g, "\\n");
}

function formatValue(value: string | number | boolean): string {
  const text = oneLine(String(value));
  return /[\s"=]/.test(text) || text === "" ? JSON.stringify(String(value)) : text;
}

export function formatLine(at: Date, level: LogLevel, message: string, fields: LogFields = {}): string {
  const pairs = Object.entries(fields).map(([key, value]) => ` ${key}=${formatValue(value)}`);
  return `${at.toISOString()} ${level} ${oneLine(message)}${pairs.join("")}\n`;
}

export function createFileLogger(options: FileLoggerOptions): Logger {
  const { dir, now = () => new Date(), maxBytes = MAX_BYTES, files = FILES } = options;
  const file = join(dir, LOG_FILE);
  let size: number | undefined;

  function currentSize(): number {
    if (size === undefined) size = existsSync(file) ? statSync(file).size : 0;
    return size;
  }

  function rotate(): void {
    rmSync(`${file}.${files - 1}`, { force: true });
    for (let n = files - 2; n >= 1; n--) {
      if (existsSync(`${file}.${n}`)) renameSync(`${file}.${n}`, `${file}.${n + 1}`);
    }
    if (existsSync(file)) renameSync(file, `${file}.1`);
    size = 0;
  }

  function write(level: LogLevel, message: string, fields?: LogFields): void {
    const line = formatLine(now(), level, message, fields);
    const bytes = Buffer.byteLength(line);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (currentSize() > 0 && currentSize() + bytes > maxBytes) rotate();
      const created = !existsSync(file);
      appendFileSync(file, line, { mode: 0o600 });
      if (created) chmodSync(file, 0o600);
      size = currentSize() + bytes;
    } catch {
      // A log that cannot be written must never stop the app.
      size = undefined;
    }
  }

  return {
    info: (message, fields) => write("INFO", message, fields),
    warn: (message, fields) => write("WARN", message, fields),
    error: (message, fields) => write("ERROR", message, fields),
  };
}

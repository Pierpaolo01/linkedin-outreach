import type { FieldProblems } from "./rules";

/** What a write (or a read by id) answers. The HTTP layer maps each failure kind to a status code. */
export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kind: "not_found" | "conflict"; readonly message: string }
  | { readonly ok: false; readonly kind: "invalid"; readonly message: string; readonly fields: FieldProblems };

export type Failure = Extract<Outcome<never>, { ok: false }>;

export const done = <T>(value: T): Outcome<T> => ({ ok: true, value });
export const notFound = (message: string): Failure => ({ ok: false, kind: "not_found", message });
export const conflict = (message: string): Failure => ({ ok: false, kind: "conflict", message });
export const invalid = (message: string, fields: FieldProblems): Failure => ({ ok: false, kind: "invalid", message, fields });

/** 1-based page of a list. */
export interface Paging {
  readonly page: number;
  readonly pageSize: number;
}

export interface Page<T> extends Paging {
  readonly items: readonly T[];
  /** Matching rows across all pages. */
  readonly total: number;
}

export const offsetOf = ({ page, pageSize }: Paging) => (page - 1) * pageSize;

import { describe, expect, it } from "vitest";
import {
  Checkpoint,
  LimitHit,
  LinkedInError,
  LoggedOut,
  Restricted,
  SearchCapped,
  Unexpected,
} from "./errors";

describe("typed driver errors", () => {
  it.each([
    [LoggedOut, "logged_out"],
    [Checkpoint, "checkpoint"],
    [Restricted, "restricted"],
    [Unexpected, "unexpected"],
    [LimitHit, "limit_hit"],
    [SearchCapped, "search_capped"],
  ] as const)("%o has kind %s and is a LinkedInError", (ErrorClass, kind) => {
    const error = new ErrorClass("page said no");

    expect(error).toBeInstanceOf(LinkedInError);
    expect(error).toBeInstanceOf(Error);
    expect(error.kind).toBe(kind);
    expect(error.message).toBe("page said no");
    expect(error.name).toBe(ErrorClass.name);
  });

  it("carries the saved page paths when given", () => {
    const error = new Checkpoint("challenge", {
      artifacts: { screenshot: "/tmp/a.png", html: "/tmp/a.html" },
    });

    expect(error.artifacts).toEqual({ screenshot: "/tmp/a.png", html: "/tmp/a.html" });
    expect(new LoggedOut("x").artifacts).toBeUndefined();
  });
});

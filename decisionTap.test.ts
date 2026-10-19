import { describe, expect, test } from "bun:test";
import { labelFromKeyboard, parseDecisionData, syntheticTapId, tapRowText } from "./decisionTap";

describe("parseDecisionData", () => {
  test("valid", () => {
    expect(parseDecisionData("dec:D186:a")).toEqual({ code: "D186", key: "a" });
    expect(parseDecisionData("dec:Q2.x-y:later")).toEqual({ code: "Q2.x-y", key: "later" });
  });
  test("invalid", () => {
    for (const s of ["", "dec:", "dec:D1", "dec:D1:", "dec::a", "dec:-D1:a", "dec:D1:a:b", "perm:allow:abcde", "dec:D 1:a", "xdec:D1:a"]) {
      expect(parseDecisionData(s)).toBeNull();
    }
  });
  test("64 byte limit", () => {
    const ok = "dec:D1:" + "k".repeat(64 - 7);
    expect(ok.length).toBe(64);
    expect(parseDecisionData(ok)).not.toBeNull();
    expect(parseDecisionData(ok + "k")).toBeNull();
  });
  test("dec:done is null", () => {
    expect(parseDecisionData("dec:done")).toBeNull();
  });
});

describe("labelFromKeyboard", () => {
  const kb = [
    [{ text: "  Approve \n now ", callback_data: "dec:D1:a" }, { text: "No", callback_data: "dec:D1:b" }],
    [{ text: "Later", callback_data: "dec:D1:later" }],
  ];
  test("found, trimmed, single line", () => {
    expect(labelFromKeyboard(kb, "dec:D1:a")).toBe("Approve now");
  });
  test("nested row", () => {
    expect(labelFromKeyboard(kb, "dec:D1:later")).toBe("Later");
  });
  test("missing", () => {
    expect(labelFromKeyboard(kb, "dec:D1:zzz")).toBeNull();
    expect(labelFromKeyboard(undefined, "dec:D1:a")).toBeNull();
    expect(labelFromKeyboard([[{ text: "x" }]], "dec:D1:a")).toBeNull();
  });
  test("max 200 chars", () => {
    const long = [[{ text: "x".repeat(300), callback_data: "dec:D1:a" }]];
    expect(labelFromKeyboard(long, "dec:D1:a")?.length).toBe(200);
  });
});

describe("tapRowText", () => {
  test("code and label", () => {
    expect(tapRowText("D186", "Approve")).toBe("D186 Approve");
  });
});

describe("syntheticTapId", () => {
  test("negative safe integer", () => {
    const id = syntheticTapId("4382910475920183", 1760000000000);
    expect(id).toBeLessThan(0);
    expect(Number.isSafeInteger(id)).toBe(true);
  });
  test("differs for two ids", () => {
    const now = 1760000000000;
    expect(syntheticTapId("4382910475920183", now)).not.toBe(syntheticTapId("4382910475920184", now));
  });
});

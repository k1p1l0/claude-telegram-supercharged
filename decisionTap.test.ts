import { describe, expect, test } from "bun:test";
import {
  cleanLabel,
  doneButtonText,
  labelFromKeyboard,
  parseDecisionData,
  recordDecisionTap,
  syntheticTapId,
  tapRowText,
} from "./decisionTap";

describe("parseDecisionData", () => {
  test("valid", () => {
    expect(parseDecisionData("dec:D186:a")).toEqual({ code: "D186", key: "a" });
    expect(parseDecisionData("dec:Q2.x-y:later")).toEqual({ code: "Q2.x-y", key: "later" });
  });
  test("invalid", () => {
    for (const s of [
      "",
      "dec:",
      "dec:D1",
      "dec:D1:",
      "dec::a",
      "dec:-D1:a",
      "dec:D1:a:b",
      "perm:allow:abcde",
      "dec:D 1:a",
      "xdec:D1:a",
    ]) {
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
    [
      { text: "  Approve \n now ", callback_data: "dec:D1:a" },
      { text: "No", callback_data: "dec:D1:b" },
    ],
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

describe("cleanLabel and doneButtonText", () => {
  test("collapse, trim, cut, empty", () => {
    expect(cleanLabel("  A \n b ")).toBe("A b");
    expect(cleanLabel("   ")).toBeNull();
    expect(cleanLabel("x".repeat(300))?.length).toBe(200);
    expect(doneButtonText("Approve")).toBe("✅ Approve");
  });
});

describe("recordDecisionTap", () => {
  const input = {
    tapId: "4382910475920183",
    nowMs: 1760000000000,
    chatId: "305",
    userId: "305",
    username: "k",
    firstName: "K",
    code: "D186",
    key: "a",
    label: "Approve",
    decisionMsgId: 3414,
    bot: "",
  };
  test("writes the row a Telegram tap writes", () => {
    const rows: any[] = [];
    const r = recordDecisionTap({ store: (m) => rows.push(m) }, input);
    expect(rows).toEqual([
      {
        message_id: syntheticTapId("4382910475920183", 1760000000000),
        chat_id: "305",
        user_id: "305",
        username: "k",
        first_name: "K",
        text: "D186 Approve",
        reply_to_msg_id: 3414,
        date: 1760000000,
        is_outgoing: false,
        bot: "",
      },
    ]);
    expect(rows[0].message_id).toBeLessThan(0);
    expect(r).toEqual({ messageId: rows[0].message_id, text: "D186 Approve", later: false });
  });
  test("later is flagged", () => {
    expect(recordDecisionTap({ store: () => {} }, { ...input, key: "later", label: "Later" }).later).toBe(true);
  });
  test("a store failure propagates", () => {
    expect(() =>
      recordDecisionTap(
        {
          store: () => {
            throw new Error("db");
          },
        },
        input,
      ),
    ).toThrow("db");
  });
});

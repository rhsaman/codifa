import { stripLeadingModeTag } from "../src/lib/modeTag";

describe("stripLeadingModeTag", () => {
  it("strips [Mode: Coder] from the first chunk", () => {
    expect(stripLeadingModeTag("[Mode: Coder] سلام", "")).toBe("سلام");
  });

  it("strips [Mode: Plan] from the first chunk", () => {
    expect(stripLeadingModeTag("[Mode: Plan] متن برنامه", "")).toBe("متن برنامه");
  });

  it("strips a closing [/Mode] tag from the first chunk", () => {
    expect(stripLeadingModeTag("[/Mode] ادامه", "")).toBe("ادامه");
  });

  it("strips with surrounding whitespace and odd spacing", () => {
    expect(stripLeadingModeTag("  [ Mode :  Ask ]   پاسخ", "")).toBe("پاسخ");
  });

  it("does NOT strip when prev is non-empty (mid-stream)", () => {
    expect(stripLeadingModeTag("[Mode: Coder] بعدی", "متن قبلی ")).toBe(
      "[Mode: Coder] بعدی",
    );
  });

  it("leaves normal content untouched", () => {
    expect(stripLeadingModeTag("این یک پاسخ عادی است", "")).toBe(
      "این یک پاسخ عادی است",
    );
  });
});

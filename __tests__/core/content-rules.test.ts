import { describe, expect, it } from "vitest";
import { assertCardContent, validateCardContent } from "../../src/core/content-rules.js";

describe("validateCardContent", () => {
  it("accepts simple HTML", () => {
    const text =
      "Cookies are sent via <code>Set-Cookie</code>.<br><b>Two</b> kinds:<ul><li>session</li><li>persistent</li></ul>";
    expect(validateCardContent(text)).toEqual([]);
  });

  it("accepts pre blocks with internal newlines", () => {
    const text = "Example:<pre><code>if (x) {\n  y();\n}</code></pre>Done.";
    expect(validateCardContent(text)).toEqual([]);
  });

  it("rejects em dashes with two-sentence advice", () => {
    const violations = validateCardContent("Tokens expire — revocation needs state.");
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/em dash/i);
    expect(violations[0]).toMatch(/two sentences/i);
  });

  it("rejects markdown backticks", () => {
    expect(validateCardContent("set `SameSite=Lax`")[0]).toMatch(/<code>/);
  });

  it("rejects markdown bold", () => {
    expect(validateCardContent("**important** note")[0]).toMatch(/<b>/);
  });

  it("rejects bare newlines outside pre blocks", () => {
    expect(validateCardContent("line one\nline two")[0]).toMatch(/<br>/);
  });

  it("rejects wikilinks", () => {
    expect(validateCardContent("see [[security/csp]]")[0]).toMatch(/wikilink/i);
  });

  it("rejects markdown list lines", () => {
    expect(validateCardContent("Two ways:<br>- cookie<br>- header")[0]).toMatch(/<ul>/);
  });

  it("reports multiple violations at once", () => {
    const violations = validateCardContent("a — b with `code`\nnext");
    expect(violations.length).toBe(3);
  });
});

describe("assertCardContent", () => {
  it("throws a clean error naming the field", () => {
    expect(() => assertCardContent({ front: "ok", back: "a — b" })).toThrowError(
      /back: .*em dash/i
    );
  });

  it("passes clean fields and ignores undefined", () => {
    expect(() => assertCardContent({ front: "fine<br>ok", back: undefined })).not.toThrow();
  });
});

import { describe, expect, it } from "vitest";
import {
  MAX_ANSWER_CHARS,
  assertCardContent,
  countSentences,
  validateAnswer,
  validateCardContent,
  validateQuestion,
  visibleText,
} from "../../src/core/content-rules.js";

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

  it("rejects the em dash entity, which Anki renders identically", () => {
    const violations = validateCardContent("Tokens expire &mdash; revocation needs state.");
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/em dash/i);
    expect(violations[0]).toMatch(/two sentences/i);
  });

  it("rejects numeric and hex em dash references", () => {
    expect(validateCardContent("a &#8212; b")[0]).toMatch(/em dash/i);
    expect(validateCardContent("a &#x2014; b")[0]).toMatch(/em dash/i);
  });

  it("still allows en dashes, which are fine in numeric ranges", () => {
    expect(validateCardContent("valid for 1\u20134 days")).toEqual([]);
    expect(validateCardContent("valid for 1&ndash;4 days")).toEqual([]);
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

describe("visibleText", () => {
  it("does not count HTML tags toward the text", () => {
    expect(visibleText("<b>hi</b>")).toBe("hi");
    expect(visibleText("<code>Set-Cookie</code>")).toBe("Set-Cookie");
  });

  it("counts an HTML entity as the single character it renders", () => {
    expect(visibleText("a &lt;b&gt; c")).toBe("a <b> c");
    expect(visibleText("&amp;")).toBe("&");
  });

  it("renders br and list item boundaries as a space, not as nothing", () => {
    expect(visibleText("a<br>b")).toBe("a b");
    expect(visibleText("<ul><li>one</li><li>two</li></ul>")).toBe("one two");
  });
});

describe("countSentences", () => {
  it("counts terminal punctuation", () => {
    expect(countSentences("One. Two. Three.")).toBe(3);
    expect(countSentences("Only one")).toBe(1);
  });

  it("does not split on abbreviations", () => {
    expect(countSentences("Reserved chars, i.e. the ones URLs use. Encode them.")).toBe(2);
    expect(countSentences("encodeURI vs. encodeURIComponent differ.")).toBe(1);
  });

  it("does not split on decimals or hex", () => {
    expect(countSentences("The signature is 0x55AA and pi is 3.14 here.")).toBe(1);
  });

  it("does not split on punctuation inside code", () => {
    expect(countSentences("Use <code>invoice.paid_at.nil?</code> for this.")).toBe(1);
  });

  it("counts each list item as its own unit", () => {
    expect(countSentences("Kinds:<ul><li>session</li><li>persistent</li></ul>")).toBe(3);
  });
});

describe("answer length limit", () => {
  const under = "a".repeat(MAX_ANSWER_CHARS);
  const over = "a".repeat(MAX_ANSWER_CHARS + 1);

  it("accepts an answer at exactly the limit", () => {
    expect(validateAnswer(under)).toEqual([]);
  });

  it("rejects an answer one character over the limit", () => {
    expect(validateAnswer(over)).toHaveLength(1);
  });

  it("states both remedies: split the card, or reduce the text", () => {
    const [violation] = validateAnswer(over);
    expect(violation).toMatch(/split/i);
    expect(violation).toMatch(/reduce/i);
  });

  it("reports the actual and the allowed count", () => {
    expect(validateAnswer(over)[0]).toMatch(new RegExp(`${MAX_ANSWER_CHARS + 1}\\b`));
    expect(validateAnswer(over)[0]).toMatch(new RegExp(`${MAX_ANSWER_CHARS}\\b`));
  });

  it("ignores HTML markup when measuring", () => {
    const marked = `<b>${"a".repeat(MAX_ANSWER_CHARS)}</b>`;
    expect(marked.length).toBeGreaterThan(MAX_ANSWER_CHARS);
    expect(validateAnswer(marked)).toEqual([]);
  });

  it("rejects too many sentences even when under the char limit", () => {
    const stacked = "One. Two. Three. Four. Five.";
    expect(stacked.length).toBeLessThan(MAX_ANSWER_CHARS);
    expect(validateAnswer(stacked)).toHaveLength(1);
    expect(validateAnswer(stacked)[0]).toMatch(/sentence/i);
  });

  it("accepts an answer at exactly the sentence limit", () => {
    expect(validateAnswer("One. Two. Three. Four.")).toEqual([]);
  });

  it("catches a long single sentence that a sentence rule alone would miss", () => {
    const oneLongSentence = `${"word ".repeat(60)}end.`;
    expect(countSentences(oneLongSentence)).toBe(1);
    expect(validateAnswer(oneLongSentence)).toHaveLength(1);
  });
});

describe("single question rule", () => {
  it("accepts one question", () => {
    expect(validateQuestion("What is the Strategy design pattern?")).toEqual([]);
  });

  it("accepts a leading clause before the question", () => {
    expect(validateQuestion("In REST, what is the benefit of statelessness?")).toEqual([]);
    expect(validateQuestion("By default, how does Angular's change detection work?")).toEqual([]);
  });

  it("accepts a long grounded scenario front", () => {
    const scenario =
      "ads.example serves an iframe on both news.site and shop.site, with its cookie set as <code>Set-Cookie: id=abc; SameSite=None; Secure</code>. Today it reads the same id in both iframes, which is cross-site tracking. Which attribute makes each top-level site get its own separate copy of this cookie, so the iframe still works but the values cannot be joined?";
    expect(visibleText(scenario).length).toBeGreaterThan(MAX_ANSWER_CHARS);
    expect(validateQuestion(scenario)).toEqual([]);
  });

  it("accepts a conjunction that joins subjects, not questions", () => {
    expect(
      validateQuestion("How do Bundler and Yarn resolve a version conflict differently?")
    ).toEqual([]);
    expect(validateQuestion("What directive and value should you use?")).toEqual([]);
  });

  it("rejects two questions joined by a conjunction", () => {
    const two = "What does the Domain attribute do and what is its default value?";
    expect(validateQuestion(two)).toHaveLength(1);
    expect(validateQuestion(two)[0]).toMatch(/split/i);
  });

  it("rejects two separate interrogative sentences", () => {
    expect(
      validateQuestion("When does extraction fix a Demeter violation? What is the real test?")
    ).toHaveLength(1);
  });

  it("does not count a Ruby predicate method as a question mark", () => {
    const front =
      "A call site has <code>invoice.paid_at.nil?</code> and you extract <code>invoice.overdue?</code>. Is the objection right?";
    expect(validateQuestion(front)).toEqual([]);
  });
});

describe("assertCardContent field routing", () => {
  it("applies the length limit to the back only", () => {
    const long = "a".repeat(MAX_ANSWER_CHARS + 50);
    expect(() => assertCardContent({ front: long, back: "short" })).not.toThrow();
    expect(() => assertCardContent({ front: "ok?", back: long })).toThrowError(/back: .*limit/i);
  });

  it("applies the single question rule to the front only", () => {
    const two = "What does it do and what is the default?";
    expect(() => assertCardContent({ front: two, back: "ok" })).toThrowError(/front: .*question/i);
    expect(() => assertCardContent({ front: "ok?", back: two })).not.toThrow();
  });

  it("still applies the format rules to both fields", () => {
    expect(() => assertCardContent({ front: "a — b", back: "ok" })).toThrowError(/front: .*em dash/i);
  });
});

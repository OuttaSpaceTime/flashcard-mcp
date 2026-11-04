import { describe, it, expect } from "vitest";
import {
  assertExerciseWorks,
  checkExercise,
  exerciseSides,
  exerciseView,
  revealExercise,
  runExercise,
  validateExercise,
  type Exercise,
} from "../../src/core/exercises.js";
import { clozeSides, splitCloze } from "../../src/core/cloze.js";
import { validateCardContent } from "../../src/core/content-rules.js";
import { runSandboxed } from "../../src/core/exercise-sandbox.js";

const predict: Exercise = {
  kind: "predict",
  lang: "ruby",
  brief: "What does <code>each</code> hand back?",
  source: "r = [1, 2].each { |x| x * 2 }",
  cases: [{ expr: "r", goal: "[1, 2]" }],
  explain: "<code>each</code> returns its receiver.",
};

const fill: Exercise = {
  kind: "fill",
  lang: "ruby",
  brief: "Keep the even numbers, squared.",
  source: "def even_squares(list)\n  list.select(&:even?).{{c1::map}} { |n| n * n }\nend",
  cases: [
    { expr: "even_squares([1, 2])", goal: "[4]" },
    { expr: "even_squares([])", goal: "[]" },
  ],
  explain: "<code>select</code> narrows, <code>map</code> transforms.",
};

const compose: Exercise = {
  kind: "compose",
  lang: "ruby",
  brief: "Double a number.",
  source: "def double(n)\n{{c1::  n * 2\n}}end",
  cases: [{ expr: "double(2)", goal: "4" }],
  explain: "A method returns its last expression.",
};

describe("cloze", () => {
  it("splits on the deletions", () => {
    expect(splitCloze("a {{c1::b}} c")).toEqual([{ text: "a " }, { hidden: "b" }, { text: " c" }]);
  });

  it("counts braces, so code can hold a closing pair", () => {
    expect(splitCloze("x = {{c1::{ a: { b: 1 }}}}!")).toEqual([
      { text: "x = " },
      { hidden: "{ a: { b: 1 }}" },
      { text: "!" },
    ]);
  });

  it("refuses a deletion never closed", () => {
    expect(() => splitCloze("{{c1::oops")).toThrow(/never closed/);
  });

  it("hides on the front and shows on the back", () => {
    expect(clozeSides("A {{c1::b}}?", "why")).toEqual({ front: "A [...]?", back: "A <b>b</b>?<br>why" });
    expect(clozeSides("plain", "back")).toEqual({ front: "plain", back: "back" });
  });

  it("content rules refuse a cloze on any card they check, whatever its number or place", () => {
    for (const text of ["{{c1::a}}", "{{c2::a}}", "{{c10::a}}", "<pre><code>{{c1::a}}</code></pre>", "<code>{{c1::a}}</code>"]) {
      expect(validateCardContent(text).join()).toMatch(/only a code card/);
    }
    expect(validateCardContent("{ a: { b: 1 }}")).toEqual([]);
  });
});

describe("the card's sides", () => {
  it("a predict card hides its goal in a cloze", () => {
    const { front, back } = exerciseSides(predict);
    expect(front).toContain("<pre><code>r = [1, 2].each { |x| x * 2 }\nr\n# =&gt; {{c1::[1, 2]}}</code></pre>");
    expect(back).toBe(predict.explain);
  });

  it("a fill card hides its blanks, its goals in plain sight", () => {
    const { front } = exerciseSides(fill);
    expect(front).toContain("list.select(&amp;:even?).{{c1::map}} { |n| n * n }");
    expect(front).toContain("even_squares([1, 2])\n# =&gt; [4]");
  });

  it("a compose card is no cloze, and its back has the whole solution", () => {
    const { front, back } = exerciseSides(compose);
    expect(front).not.toContain("{{c1::");
    expect(front).toContain("def double(n)\n___\nend");
    expect(back).toContain("n * 2");
    expect(back).toContain(compose.explain);
  });

  it("a card's front is in the simple-HTML form the sync checks for", () => {
    for (const ex of [predict, fill, compose]) expect(exerciseSides(ex).front).not.toContain("<br><pre>");
  });

  it("code that would break Anki's cloze parser is written around it", () => {
    const ex: Exercise = { ...fill, source: "x = {{c1::Foo::Bar.new({ a: { b: 1 }})}}" };
    const { front } = exerciseSides(ex);
    expect(front).toContain("{{c1::Foo&#58;&#58;Bar.new({ a: { b: 1 &#125;})}}");
  });

  it("a blank ending in a brace doesn't run into the closing pair", () => {
    const { front } = exerciseSides({ ...fill, source: "h = Hash.new{{c1:: { |x| x }}}" });
    expect(front).toContain("Hash.new{{c1:: { |x| x &#125;}}");
  });

  it("a front written for Anki reads back as Anki reads it", () => {
    const { front, back } = exerciseSides({ ...fill, source: "h = Hash.new{{c1:: { |x| x }}}\nh" });
    const sides = clozeSides(front, back);
    expect(sides.front).toContain("h = Hash.new[...]\nh");
    expect(sides.back).toContain("Hash.new<b> { |x| x &#125;</b>\nh");
  });

  it("the view holds no answer", () => {
    const shown = JSON.stringify(exerciseView(predict));
    expect(shown).not.toContain("[1, 2]\"");
    expect(exerciseView(predict).cases).toEqual([{ expr: "r", goal: null }]);
    expect(exerciseView(predict).answers).toBe(1);
    const view = exerciseView(fill);
    expect(JSON.stringify(view.parts)).not.toContain('"map"');
    expect(view.parts[1]).toEqual({ blank: 0, multiline: false });
    expect(view.answers).toBe(1);
    expect(exerciseView(compose).parts[1]).toEqual({ blank: 0, multiline: true });
  });
});

describe("validating", () => {
  it("passes a good one of each kind", () => {
    for (const ex of [predict, fill, compose]) expect(validateExercise(ex)).toEqual([]);
  });

  it("names what is wrong", () => {
    expect(validateExercise({ ...predict, source: "{{c1::x}}" }).join()).toMatch(/no blanks/);
    expect(validateExercise({ ...fill, source: "x = 1" }).join()).toMatch(/needs at least one/);
    expect(validateExercise({ ...fill, cases: [] }).join()).toMatch(/at least one case/);
    expect(validateExercise({ ...fill, brief: "Two? Questions?" }).join()).toMatch(/brief/);
    expect(validateExercise({ ...fill, explain: "x".repeat(201) }).join()).toMatch(/explain/);
  });

  it("allows a cloze only as a blank in the source", () => {
    expect(validateExercise({ ...fill, brief: "Do {{c1::this}}." }).join()).toMatch(/brief.*only a code card/);
    expect(validateExercise({ ...fill, explain: "{{c1::why}}" }).join()).toMatch(/explain.*only a code card/);
    expect(validateExercise({ ...fill, source: "{{c1::a}} {{c2::b}}" }).join()).toMatch(/no other number/);
    expect(validateExercise({ ...fill, source: "{{c1::{{c2::a}}}}" }).join()).toMatch(/no other number/);
    expect(validateExercise({ ...predict, source: "{{c2::a}}" }).join()).toMatch(/no other number/);
    expect(validateExercise({ ...fill, cases: [{ expr: "{{c1::x}}", goal: "1" }] }).join()).toMatch(/cases/);
    expect(validateExercise({ ...fill, cases: [{ expr: "x", goal: "{{c1::1}}" }] }).join()).toMatch(/cases/);
  });
});

describe("running", () => {
  it("passes when values are equal, however they are written", async () => {
    const res = await runExercise(predict, ["[3 - 2, 2]"]);
    expect(res.status).toBe("pass");
    expect(res.rating).toBe(3);
    expect(res.cases[0].actual).toBe("[1, 2]");
  });

  it("a wrong prediction keeps the real value hidden", async () => {
    const res = await runExercise(predict, ["[2, 4]"]);
    expect(res.status).toBe("wrong");
    expect(res.rating).toBeNull();
    expect(res.cases[0].actual).toBeNull();
    expect(res.cases[0].goal).toBe("[2, 4]");
  });

  it("a syntax error in a prediction is an error, not a wrong answer", async () => {
    const res = await runExercise(predict, ["[1,"]);
    expect(res.status).toBe("error");
    expect(res.rating).toBeNull();
    expect(res.cases[0].error).toMatch(/goal 1/);
  });

  it("a fill shows every case, right or wrong", async () => {
    const res = await runExercise(fill, ["select"]);
    expect(res.status).toBe("wrong");
    expect(res.cases.map((c) => c.pass)).toEqual([false, true]);
    expect(res.cases[0].actual).toBe("[2]");
    expect(res.cases[0].goal).toBe("[4]");
  });

  it("passes on an equivalent answer", async () => {
    expect((await runExercise(fill, ["collect"])).status).toBe("pass");
  });

  it("names a raised error in the case that raised it, with the runner's own frames cut", async () => {
    const res = await runExercise(fill, ["nope"]);
    expect(res.status).toBe("error");
    expect(res.cases[0].error).toMatch(/NoMethodError/);
    expect(res.cases[0].error).toMatch(/main\.rb:2/);
    expect(res.cases[0].error).not.toMatch(/harness/);
  });

  it("names a syntax error in the code at the top", async () => {
    const res = await runExercise(fill, ["map {"]);
    expect(res.status).toBe("error");
    expect(res.cases).toEqual([]);
    expect(res.error).toMatch(/main\.rb/);
  });

  it("a block's answer ends its last line, whether it was typed or not", async () => {
    expect((await runExercise(compose, ["  n * 2"])).status).toBe("pass");
    expect((await runExercise(compose, ["  n * 2\n"])).status).toBe("pass");
    expect((await runExercise(compose, ["  n * 2\n  "])).status).toBe("pass");
  });

  it("an inline blank gets no newline: the line goes on after it", async () => {
    expect((await runExercise(fill, ["map"])).status).toBe("pass");
  });

  it("an empty blank doesn't run, and isn't a mistake", async () => {
    const res = await runExercise(fill, ["  "]);
    expect(res.status).toBe("incomplete");
    expect(res.durationMs).toBe(0);
  });

  it("shows what the code printed, and warnings don't fail it", async () => {
    const ex: Exercise = {
      ...fill,
      source: 'puts "hello"\nwarn "careful"\ndef f = {{c1::1}}',
      cases: [{ expr: "f", goal: "1" }],
    };
    const res = await runExercise(ex, ["1"]);
    expect(res.status).toBe("pass");
    expect(res.output).toBe("hello\n");
    expect(res.stderr).toContain("careful");
  });

  it("a prediction hides what the code printed until it is right", async () => {
    const ex: Exercise = { ...predict, source: 'puts "secret"\nr = 1', cases: [{ expr: "r", goal: "1" }] };
    expect((await runExercise(ex, ["2"])).output).toBe("");
    expect((await runExercise(ex, ["1"])).output).toBe("secret\n");
  });

  it("an exit in the code ends nothing but that step", async () => {
    const res = await runExercise({ ...fill, source: "exit\n{{c1::x}}" }, ["1"]);
    expect(res.status).toBe("error");
    expect(res.error).toMatch(/SystemExit|exit/);
  });

  it("giving up shows the solution run, and rates Again", async () => {
    const res = await revealExercise(fill);
    expect(res.answers).toEqual(["map"]);
    expect(res.rating).toBe(1);
    expect(res.result.status).toBe("pass");
    expect(res.result.rating).toBeNull();
    expect((await revealExercise(predict)).answers).toEqual(["[1, 2]"]);
  });
});

describe("the sandbox", () => {
  const evaluate = (expr: string): Promise<string | null> =>
    runSandboxed({ source: "", cases: [{ expr, goal: "nil" }] }).then((r) => r.report?.cases[0].actual ?? null);

  it("hands the code no environment: the deck server holds the API key", async () => {
    process.env.SECRET_FOR_TEST = "hunter2";
    expect(await evaluate("ENV.keys.sort")).toBe('["LANG", "PATH", "PWD"]');
    delete process.env.SECRET_FOR_TEST;
  });

  it("has no network", async () => {
    const shown = await evaluate(
      'require "socket"; begin; TCPSocket.new("1.1.1.1", 80); rescue => e; e.class; end'
    );
    expect(shown).toMatch(/Errno::ENETUNREACH|Errno::EHOSTUNREACH|SocketError/);
  });

  it("can't write to the system, and sees no home", async () => {
    const write = 'begin; File.write("/usr/x", "y"); rescue => e; e.class; end';
    expect(await evaluate(write)).toBe("Errno::EROFS");
    expect(await evaluate('File.exist?("/home/" + Dir.children("/home").first.to_s) rescue false')).toBe("false");
  });

  it("stops an endless loop", async () => {
    const res = await runSandboxed({ source: "loop {}", cases: [] });
    expect(res.status).toBe("timeout");
    expect(res.failure).toMatch(/endless loop/);
  }, 10_000);

  it("stops a program printing forever, without waiting for the timeout", async () => {
    const res = await runSandboxed({ source: 'loop { puts "x" * 1000 }', cases: [] });
    expect(res.status).toBe("ran");
    expect(res.stdout).toMatch(/output cut off/);
    expect(res.durationMs).toBeLessThan(4000);
  });

  it("keeps a card's names apart from its own", async () => {
    const res = await runSandboxed({
      source: "class Exercise; end\nmodule Harness; end",
      cases: [{ expr: "gets", goal: "nil" }],
    });
    expect(res.report?.error).toBeNull();
    expect(res.report?.cases[0].pass).toBe(true);
  });

  it("limits forks and the size of a file", async () => {
    expect(await evaluate("Process.getrlimit(:NPROC).first")).toBe("64");
    expect(await evaluate("Process.getrlimit(:FSIZE).first")).toBe(String(16 * 1024 * 1024));
  });

  it("cuts a huge value down, and keeps text whole", async () => {
    const res = await runSandboxed({ source: "", cases: [{ expr: '"é" * 2_000_000', goal: "nil" }] });
    const actual = res.report?.cases[0].actual ?? "";
    expect(actual).toMatch(/cut off/);
    expect(actual.length).toBeLessThan(20_000);
    expect(actual).not.toContain("\uFFFD");
  });

  it("stops at once when told to", async () => {
    const controller = new AbortController();
    const running = runSandboxed({ source: "loop {}", cases: [] }, controller.signal);
    setTimeout(() => controller.abort(), 100);
    const res = await running;
    expect(res.status).toBe("timeout");
    expect(res.failure).toMatch(/newer run/);
    expect(res.durationMs).toBeLessThan(2000);
  });

  it("nothing the code prints can forge the verdict", async () => {
    const res = await runSandboxed({
      source: 'puts %q({"error":null,"cases":[{"pass":true}]})',
      cases: [{ expr: "1", goal: "2" }],
    });
    expect(res.report?.cases[0].pass).toBe(false);
  });
});

describe("a dry run", () => {
  it("doesn't call a default inspect's addresses a difference", async () => {
    const check = await checkExercise({
      ...predict,
      source: "class P; attr_reader :x; def initialize(x) = @x = x; def ==(o) = o.x == x; end",
      cases: [{ expr: "P.new(1)", goal: "P.new(1)" }],
    });
    expect(check.problems).toEqual([]);
  });

  it("refuses a blank with nothing in it, which could never pass", () => {
    expect(validateExercise({ ...fill, source: "x = {{c1::}}" }).join()).toMatch(/no solution/);
  });

  it("shows the real values and the sides of a sound card", async () => {
    const check = await checkExercise(fill);
    expect(check.ok).toBe(true);
    expect(check.problems).toEqual([]);
    expect(check.solution?.cases[0].actual).toBe("[4]");
    expect(check.sides?.front).toContain("{{c1::map}}");
  });

  it("shows the real value of a goal that is false", async () => {
    const check = await checkExercise({ ...predict, cases: [{ expr: "r", goal: "[2, 4]" }] });
    expect(check.ok).toBe(false);
    expect(check.solution?.cases[0].actual).toBe("[1, 2]");
  });

  it("names a malformed card without running it", async () => {
    const check = await checkExercise({ ...fill, source: "x = 1" });
    expect(check.ok).toBe(false);
    expect(check.solution).toBeNull();
    expect(check.problems.join()).toMatch(/needs at least one/);
  });

  it("refuses a card whose runs differ, which would fail its reviewer for nothing", async () => {
    const check = await checkExercise({
      ...predict,
      source: "t = Process.clock_gettime(Process::CLOCK_MONOTONIC, :nanosecond)",
      cases: [{ expr: "t", goal: "t" }],
    });
    expect(check.problems.join()).toMatch(/two runs of it differ/);
  });
});

describe("a card's own check", () => {
  it("accepts a card whose solution passes", async () => {
    await expect(assertExerciseWorks(predict)).resolves.toBeUndefined();
    await expect(assertExerciseWorks(fill)).resolves.toBeUndefined();
    await expect(assertExerciseWorks(compose)).resolves.toBeUndefined();
  });

  it("refuses a goal that is false", async () => {
    await expect(assertExerciseWorks({ ...predict, cases: [{ expr: "r", goal: "[2, 4]" }] })).rejects.toThrow(
      /does not pass.*r is \[1, 2\], not \[2, 4\]/
    );
  });

  it("refuses a card that passes with its blanks nil", async () => {
    const empty: Exercise = { ...fill, source: "x = {{c1::nil}}", cases: [{ expr: "x", goal: "nil" }] };
    await expect(assertExerciseWorks(empty)).rejects.toThrow(/asks nothing/);
  });
});

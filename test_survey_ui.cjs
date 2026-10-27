const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("node:fs");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { spawn, execFileSync } = require("node:child_process");
const { test } = require("node:test");
const root = __dirname;
const html = fs.readFileSync(path.join(root, "survey.html"), "utf8");
test("survey inspection and annotation workflows", async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "loupe-ui-"));
  const fixture = execFileSync(
    "python3",
    [
      "-c",
      "import json; from test_survey import example; print(json.dumps(example()))",
    ],
    { cwd: root, encoding: "utf8" },
  );
  const synthetic = JSON.parse(fixture);
  synthetic.respondents[0].answers.why += '\n<img src="x" onerror="alert(1)">';
  fs.writeFileSync(
    path.join(scratch, "survey.json"),
    JSON.stringify(synthetic),
  );
  const server = spawn(
    "python3",
    ["server.py", "--survey", path.join(scratch, "survey.json"), "--port", "0"],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  let dom;
  try {
    const base = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(Error("Server did not start")),
        10000,
      );
      server.stdout.on("data", (chunk) => {
        const found = chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+/);
        if (found) {
          clearTimeout(timeout);
          resolve(found[0]);
        }
      });
      server.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      server.once("exit", (code) => {
        clearTimeout(timeout);
        reject(Error("Server exited: " + code));
      });
    });
    const failures = [];
    const console = new VirtualConsole();
    console.on("jsdomError", (e) => {
      if (!e.message.includes("navigation")) failures.push(e.message);
    });
    const downloads = [];
    dom = new JSDOM(html, {
      url: base,
      runScripts: "dangerously",
      pretendToBeVisual: true,
      virtualConsole: console,
      beforeParse(w) {
        w.fetch = (path) => fetch(new URL(path, base));
        w.structuredClone = structuredClone;
        w.Blob = Blob;
        w.URL.createObjectURL = (blob) => {
          downloads.push(blob);
          return "blob:synthetic";
        };
        w.URL.revokeObjectURL = () => {};
      },
    });
    const w = dom.window,
      d = w.document,
      $ = (id) => d.getElementById(id);
    const pause = () => new Promise((r) => setTimeout(r, 20));
    async function until(test) {
      for (let i = 0; i < 100; i++) {
        if (test()) return;
        await pause();
      }
      throw Error("UI state did not settle: " + $("error").textContent);
    }
    async function change(id, value, event = "change") {
      const target = $(id);
      target.value = value;
      target.dispatchEvent(new w.Event(event, { bubbles: true }));
      await pause();
    }
    async function select(label, value) {
      const target = d.querySelector(`[aria-label="${label}"]`);
      assert(target, label);
      target.value = value;
      target.dispatchEvent(new w.Event("change", { bubbles: true }));
      await pause();
    }
    async function run() {
      await until(() => $("detail").textContent.includes("Progress depends"));
      assert.equal($("cohort-count").textContent, "3");
      assert.equal($("text-count").textContent, "2");
      assert.equal($("response-count").textContent, "3");
      assert.equal(d.querySelector("#detail img"), null);
      assert($("detail").textContent.includes('<img src="x"'));
      await change("search", "evaluation", "input");
      await until(() => $("response-count").textContent === "1");
      assert.equal(d.querySelector("#detail mark").textContent, "evaluation");
      await change("search", "", "input");
      await until(() => $("response-count").textContent === "3");
      [...d.querySelectorAll("#detail button")]
        .find((b) => b.textContent === "All respondent answers")
        .click();
      assert($("detail").textContent.includes("Structured answers"));
      assert(
        $("detail").textContent.includes(
          "What probability do you assign? — 10",
        ),
      );
      const tags = d.querySelector('[aria-label="Tags for this response"]');
      tags.value = "interpretation, review";
      tags.dispatchEvent(new w.Event("input"));
      const notes = d.querySelector('[aria-label="Research notes"]');
      notes.value = "Synthetic research note";
      notes.dispatchEvent(new w.Event("input"));
      [...d.querySelectorAll("#detail button")]
        .find((b) => b.textContent === "☆ Bookmark")
        .click();
      assert(
        [...d.querySelectorAll("#detail button")].some(
          (b) => b.textContent === "★ Bookmarked",
        ),
      );
      $("bookmarked").checked = true;
      $("bookmarked").dispatchEvent(new w.Event("change"));
      assert.equal($("response-count").textContent, "1");
      $("export-notes").click();
      const backup = JSON.parse(await downloads.at(-1).text());
      assert.equal(
        Object.values(backup.annotations)[0].note,
        "Synthetic research note",
      );
      $("export-data").click();
      const csv = await downloads.at(-1).text();
      assert(csv.includes("interpretation; review"));
      assert(csv.includes("Synthetic research note"));
      const formulaNote = d.querySelector('[aria-label="Research notes"]');
      formulaNote.value = '=HYPERLINK("example.invalid")';
      formulaNote.dispatchEvent(new w.Event("input"));
      $("export-data").click();
      assert((await downloads.at(-1).text()).includes("'=HYPERLINK"));
      Object.values(backup.annotations)[0].note = "Restored synthetic note";
      const fileInput = $("notes-file");
      Object.defineProperty(fileInput, "files", {
        value: [{ text: async () => JSON.stringify(backup) }],
        configurable: true,
      });
      fileInput.dispatchEvent(new w.Event("change"));
      await until(() => $("error").textContent.includes("Backup restored"));
      assert.equal(
        d.querySelector('[aria-label="Research notes"]').value,
        "Restored synthetic note",
      );
      await change("cohort-name", "Bookmarked explanations");
      $("save-cohort").click();
      $("reset").click();
      await until(() => $("response-count").textContent === "3");
      await change("cohort-list", "Bookmarked explanations");
      await until(() => $("response-count").textContent === "1");
      $("reset").click();
      await until(() => $("response-count").textContent === "3");
      $("add-filter").click();
      await pause();
      await select("Condition 1", "gte");
      await until(() => $("error").textContent.includes("finite"));
      const numeric = d.querySelector('[aria-label="Value 1"]');
      numeric.value = "10";
      numeric.dispatchEvent(new w.Event("change"));
      await until(() => $("cohort-count").textContent === "2");
      assert.equal($("response-count").textContent, "2");
      await select("Structured question 1", "pace");
      await until(() => $("cohort-count").textContent === "2");
      await select("Condition 1", "eq");
      await select("Value 1", "Faster");
      await until(() => $("response-count").textContent === "1");
      assert($("detail").textContent.includes("A different interpretation"));
      await change("question", "comments");
      await until(() => $("response-count").textContent === "0");
      assert($("detail").textContent.includes("No responses match"));
      assert.deepEqual(failures, []);
      process.stdout.write(
        "UI workflows passed: search, highlights, respondent view, tags, notes, bookmarks, CSV/JSON export, saved subsets, numeric/category filters, empty results.\n",
      );
      dom.window.close();
    }
    await run();
  } finally {
    if (dom) dom.window.close();
    server.kill();
    await new Promise((resolve) => {
      if (server.exitCode !== null) resolve();
      else server.once("exit", resolve);
    });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

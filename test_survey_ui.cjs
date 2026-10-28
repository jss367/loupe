const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("node:fs");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { spawn, execFileSync } = require("node:child_process");
const { test } = require("node:test");
const root = __dirname;
const html = fs.readFileSync(path.join(root, "survey.html"), "utf8");
function selectQuestions(w, questions) {
  const group = w.document.getElementById("question");
  for (const input of group.querySelectorAll("input"))
    input.checked = questions.includes(input.value);
  group.dispatchEvent(new w.Event("change", { bubbles: true }));
}
const lockQueues = new Map();
const locks = {
  request(name, callback) {
    const result = (lockQueues.get(name) || Promise.resolve()).then(callback);
    lockQueues.set(name, result.catch(() => {}));
    return result;
  },
};
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
  synthetic.questions.push({
    id: "réponse 🐦", wording: "Synthetic Unicode follow-up?", kind: "text",
    section: "Expectations", variable: "réponse 🐦", raw_variable: "réponse 🐦", occurrence: 1,
  });
  synthetic.respondents.push({
    id: "élève 🐦", source_row: 8, retained: false, finished: true,
    answers: { why: "Unicode synthetic expectation: 🐦 Straße İ", "réponse 🐦": "Unicode synthetic follow-up" },
  });
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
        Object.defineProperty(w.navigator, "locks", { value: locks });
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
      assert($("detail").textContent.includes("CSV record 4"));
      assert(!$("detail").textContent.includes("3 header records"));
      assert($("detail").textContent.includes('<img src="x"'));
      await change("sample", "all");
      for (const input of d.querySelectorAll("#question input"))
        if (["comments", "réponse 🐦"].includes(input.value)) input.click();
      await until(() => $("response-count").textContent === "2");
      assert.equal($("question-summary-text").textContent, "2 questions selected");
      assert.equal($("text-count").textContent, "2");
      assert.equal($("people-count").textContent, "2");
      assert.equal($("cohort-count").textContent, "5");
      $("export-data").click();
      const selectedCsv = await downloads.at(-1).text();
      assert(selectedCsv.includes('"comments"'));
      assert(selectedCsv.includes('"réponse 🐦"'));
      assert(!selectedCsv.includes('"why"'));
      await change("search", "follow-up", "input");
      await until(() => $("response-count").textContent === "1");
      assert.equal($("text-count").textContent, "2");
      await change("search", "", "input");
      await until(() => $("response-count").textContent === "2");
      await change("cohort-name", "Selected questions");
      $("save-cohort").click();
      await pause();
      $("reset").click();
      await until(() => $("response-count").textContent === "3");
      await change("cohort-list", "Selected questions");
      await until(() => $("response-count").textContent === "2");
      assert.deepEqual([...d.querySelectorAll("#question input:checked")].map((i) => i.value), ["comments", "réponse 🐦"]);
      $("export-notes").click();
      const selectedBackup = JSON.parse(await downloads.at(-1).text());
      assert.deepEqual(selectedBackup.cohorts["Selected questions"].questions, ["comments", "réponse 🐦"]);
      $("all-questions").click();
      await until(() => $("response-count").textContent === "6");
      assert.equal($("question-summary-text").textContent, "All free-response questions");
      selectQuestions(w, ["comments"]);
      await until(() => $("response-count").textContent === "1");
      assert($("question-summary-text").textContent.includes("Any other comments?"));
      selectQuestions(w, []);
      await until(() => $("response-count").textContent === "6");
      $("reset").click();
      await until(() => $("response-count").textContent === "3");
      await change("search", "evaluation", "input");
      await until(() => $("response-count").textContent === "1");
      await until(() => d.querySelector("#detail mark"));
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
      selectQuestions(w, ["comments"]);
      await until(() => $("response-count").textContent === "0");
      assert($("detail").textContent.includes("No responses match"));
      assert.deepEqual(failures, []);
      process.stdout.write(
        "UI workflows passed: search, highlights, respondent view, tags, notes, bookmarks, CSV/JSON export, saved subsets, numeric/category filters, empty results.\n",
      );
      dom.window.close();
    }
    await run();
    await storageRegressions(base);
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

async function storageRegressions(base) {
  const stored = new Map();
  const storageKey = "loupe-survey:synthetic-survey";
  const windows = [];
  let failWrites = false;
  const pause = () => new Promise((r) => setTimeout(r, 20));
  async function tab(hash = "", expectedText = "") {
    const downloads = [];
    let holdId = null, releaseFetch = null;
    let holdResponses = false, holdDebounce = false, runDebounce = null;
    const dom = new JSDOM(html, {
      url: base + hash,
      runScripts: "dangerously",
      pretendToBeVisual: true,
      virtualConsole: new VirtualConsole(),
      beforeParse(w) {
        Object.defineProperty(w.navigator, "locks", { value: locks, configurable: true });
        const setTimeout = w.setTimeout.bind(w);
        w.setTimeout = (callback, delay, ...args) => {
          if (holdDebounce && delay === 200) {
            runDebounce = () => callback(...args);
            return 0;
          }
          return setTimeout(callback, delay, ...args);
        };
        w.fetch = (path) => {
          if (holdResponses && path.startsWith("/api/survey/responses?")) {
            holdResponses = false;
            return new Promise((resolve) => { releaseFetch = () => resolve(fetch(new URL(path, base))); });
          }
          if (holdId !== null && path.split("?")[0] === "/api/survey/respondents/" + encodeURIComponent(holdId)) {
            holdId = null;
            return new Promise((resolve) => { releaseFetch = () => resolve(fetch(new URL(path, base))); });
          }
          return fetch(new URL(path, base));
        };
        w.structuredClone = structuredClone;
        w.Blob = Blob;
        w.URL.createObjectURL = (blob) => { downloads.push(blob); return "blob:synthetic"; };
        w.URL.revokeObjectURL = () => {};
        Object.defineProperty(w, "localStorage", { value: {
          getItem: (key) => stored.get(key) || null,
          setItem(key, value) {
            if (failWrites) throw Error("Synthetic quota failure");
            stored.set(key, value);
          },
        } });
      },
    });
    windows.push(dom.window);
    const w = dom.window, d = w.document;
    for (let i = 0; i < 100; i++) {
      const expected = expectedText || (hash.includes("beta") ? "A different interpretation" : hash.includes("gamma") ? "Outside the retained" : "Progress depends");
      if (d.querySelector("#detail")?.textContent.includes(expected)) break;
      await pause();
    }
    assert(d.querySelector('[aria-label="Research notes"]'), "response loaded");
    return {
      w, d,
      holdSearch() {
        holdResponses = true;
        holdDebounce = true;
        return async () => {
          assert(releaseFetch, "old search request was held");
          releaseFetch();
          await pause();
          return async () => {
            assert(runDebounce, "new search is waiting for debounce");
            holdDebounce = false;
            runDebounce();
            await pause();
          };
        };
      },
      holdRespondent(id) {
        holdId = id;
        releaseFetch = null;
        return async () => {
          assert(releaseFetch, "linked respondent request was held");
          releaseFetch();
          await pause();
        };
      },
      async edit(label, value) {
        const input = d.querySelector(`[aria-label="${label}"]`);
        input.value = value;
        input.dispatchEvent(new w.Event("input"));
        await pause();
      },
      async subset(name) {
        d.getElementById("cohort-name").value = name;
        d.getElementById("save-cohort").click();
        await pause();
      },
      async restore(backup) {
        const input = d.getElementById("notes-file");
        Object.defineProperty(input, "files", {
          value: [{ text: async () => JSON.stringify(backup) }], configurable: true,
        });
        input.dispatchEvent(new w.Event("change"));
        await pause();
      },
      async backup() {
        d.getElementById("export-notes").click();
        return JSON.parse(await downloads.at(-1).text());
      },
      async csv() {
        d.getElementById("export-data").click();
        return downloads.at(-1).text();
      },
    };
  }
  try {
    const a = await tab(), b = await tab("#respondent=beta&question=why"), stale = await tab(), csvTab = await tab();
    await a.edit("Research notes", "Alpha tab note");
    await a.edit("Tags for this response", "remote-tag");
    [...a.d.querySelectorAll("#detail button")].find((b) => b.textContent === "☆ Bookmark").click();
    await b.edit("Research notes", "Beta tab note");
    await a.subset("First subset");
    await b.subset("Second subset");
    const alpha = JSON.stringify(["alpha", "why"]), beta = JSON.stringify(["beta", "why"]);
    let saved = JSON.parse(stored.get(storageKey));
    assert.equal(saved.annotations[alpha].note, "Alpha tab note");
    assert.equal(saved.annotations[beta].note, "Beta tab note");
    assert.deepEqual(Object.keys(saved.cohorts).sort(), ["First subset", "Second subset"]);
    const csv = await csvTab.csv();
    assert(csv.includes("Alpha tab note"));
    assert(csv.includes("Beta tab note"));
    assert(csv.includes('"true","remote-tag","Alpha tab note"'));
    const staleBackup = await stale.backup();
    assert.equal(staleBackup.annotations[alpha].note, "Alpha tab note");
    assert.equal(staleBackup.annotations[beta].note, "Beta tab note");
    assert.deepEqual(Object.keys(staleBackup.cohorts).sort(), ["First subset", "Second subset"]);
    a.d.getElementById("cohort-list").value = "First subset";
    a.d.getElementById("delete-cohort").click();
    await b.subset("Third subset");
    await stale.edit("Tags for this response", "cross-tab");
    await stale.edit("Research notes", "Last alpha save");
    saved = JSON.parse(stored.get(storageKey));
    assert.equal(saved.annotations[alpha].note, "Last alpha save");
    assert.deepEqual(saved.annotations[alpha].tags, ["cross-tab"]);
    assert.equal(saved.annotations[alpha].bookmark, true);
    assert(!Object.hasOwn(saved.cohorts, "First subset"), "stale tab must not revive deleted subsets");
    const reloaded = await tab();
    assert.equal(reloaded.d.querySelector('[aria-label="Research notes"]').value, "Last alpha save");
    assert.equal(reloaded.d.querySelector('[aria-label="Tags for this response"]').value, "cross-tab");
    assert.equal(JSON.parse(stored.get(storageKey)).annotations[beta].note, "Beta tab note");
    const backup = await reloaded.backup();
    backup.annotations[alpha].note = "Imported session-only note";
    failWrites = true;
    await reloaded.restore(backup);
    assert(reloaded.d.getElementById("error").textContent.includes("Changes remain in this session"));
    assert(!reloaded.d.getElementById("error").textContent.includes("Backup restored"));
    await reloaded.subset("Session subset");
    assert(reloaded.d.getElementById("error").textContent.includes("Back up tags & notes"));
    assert.equal((await reloaded.backup()).annotations[alpha].note, "Imported session-only note");
    failWrites = false;
    await b.subset("Other tab persisted during quota failure");
    failWrites = true;
    const pendingBackup = await reloaded.backup();
    assert(Object.hasOwn(pendingBackup.cohorts, "Other tab persisted during quota failure"));
    assert.equal(pendingBackup.annotations[alpha].note, "Imported session-only note");
    assert(Object.hasOwn(pendingBackup.cohorts, "Session subset"));
    failWrites = false;
    await reloaded.edit("Tags for this response", "recovered");
    assert(!reloaded.d.getElementById("error").textContent.includes("session"));
    saved = JSON.parse(stored.get(storageKey));
    assert.equal(saved.annotations[alpha].note, "Imported session-only note");
    assert(Object.hasOwn(saved.cohorts, "Session subset"));
    stored.clear();
    const recovered = await tab();
    await recovered.restore(staleBackup);
    const restored = JSON.parse(stored.get(storageKey));
    assert.equal(restored.annotations[beta].note, "Beta tab note");
    assert.equal(restored.annotations[alpha].note, "Alpha tab note");
    assert.deepEqual(Object.keys(restored.cohorts).sort(), ["First subset", "Second subset"]);
    const linked = await tab("#respondent=gamma&question=why");
    const bookmark = [...linked.d.querySelectorAll("#detail button")].find((b) => b.textContent === "☆ Bookmark");
    bookmark.click();
    assert(linked.d.getElementById("detail").textContent.includes("Outside the retained row set"));
    assert(linked.d.getElementById("detail").textContent.includes("★ Bookmarked"));
    assert.equal(linked.d.getElementById("response-count").textContent, "3");
    await linked.edit("Tags for this response", "linked-response");
    linked.d.querySelector('[aria-label="Tags for this response"]').dispatchEvent(new linked.w.Event("change"));
    assert(linked.d.getElementById("detail").textContent.includes("Outside the retained row set"));
    await linked.edit("Research notes", "Linked note");
    assert.equal((await linked.backup()).annotations[JSON.stringify(["gamma", "why"])].note, "Linked note");
    const related = await tab();
    selectQuestions(related.w, ["why"]);
    await pause();
    [...related.d.querySelectorAll("#detail button")].find((b) => b.textContent === "All respondent answers").click();
    [...related.d.querySelectorAll("#detail button")].find((b) => b.textContent === "Read and tag this response").click();
    await pause();
    assert(related.d.getElementById("detail").textContent.includes("Interpretation matters"));
    [...related.d.querySelectorAll("#detail button")].find((b) => b.textContent === "☆ Bookmark").click();
    assert(related.d.getElementById("detail").textContent.includes("Interpretation matters"));
    assert(related.d.getElementById("detail").textContent.includes("★ Bookmarked"));
    related.d.getElementById("sample").value = "excluded";
    related.d.getElementById("sample").dispatchEvent(new related.w.Event("change"));
    await pause();
    assert(related.d.getElementById("detail").textContent.includes("Outside the retained row set"));
    const unicode = await tab();
    unicode.d.getElementById("sample").value = "all";
    unicode.d.getElementById("sample").dispatchEvent(new unicode.w.Event("change"));
    await pause();
    [...unicode.d.querySelectorAll("#records button")].find((b) => b.textContent.includes("Unicode synthetic expectation")).click();
    await pause();
    await unicode.edit("Research notes", "Unicode list note");
    const unicodeHash = unicode.w.location.hash;
    unicode.w.location.hash = "";
    unicode.w.location.hash = unicodeHash;
    await pause();
    assert.equal(unicode.d.querySelector('[aria-label="Research notes"]').value, "Unicode list note");
    [...unicode.d.querySelectorAll("#detail button")].find((b) => b.textContent === "All respondent answers").click();
    [...unicode.d.querySelectorAll("#detail button")].find((b) => b.textContent === "Read and tag this response").click();
    await pause();
    await unicode.edit("Research notes", "Unicode follow-up note");
    const unicodeBackup = await unicode.backup();
    assert.equal(unicodeBackup.annotations[JSON.stringify(["élève 🐦", "why"])].note, "Unicode list note");
    assert.equal(unicodeBackup.annotations[JSON.stringify(["élève 🐦", "réponse 🐦"])].note, "Unicode follow-up note");
    const unicodeReloaded = await tab(unicode.w.location.hash, "Unicode synthetic follow-up");
    assert.equal(unicodeReloaded.d.querySelector('[aria-label="Research notes"]').value, "Unicode follow-up note");
    const searchUnicode = await tab();
    searchUnicode.d.getElementById("sample").value = "all";
    searchUnicode.d.getElementById("sample").dispatchEvent(new searchUnicode.w.Event("change"));
    await pause();
    for (const [query, expected] of [["STRASSE", "Straße"], ["i\u0307", "İ"], ["🐦", "🐦"]]) {
      const input = searchUnicode.d.getElementById("search");
      input.value = query;
      input.dispatchEvent(new searchUnicode.w.Event("input"));
      await new Promise((r) => setTimeout(r, 260));
      assert.equal(searchUnicode.d.querySelector("#records mark")?.textContent, expected);
      assert.equal(searchUnicode.d.querySelector("#detail mark")?.textContent, expected);
      assert(searchUnicode.d.querySelector("#detail .answer").textContent.includes("🐦 Straße İ"));
    }
    const race = await tab();
    let release = race.holdRespondent("alpha");
    race.w.location.hash = "#respondent=alpha&question=comments";
    await pause();
    [...race.d.querySelectorAll("#records button")].find((b) => b.textContent.includes("A different interpretation")).click();
    await pause();
    await release();
    assert(race.w.location.hash.includes("respondent=beta"));
    assert(race.d.getElementById("detail").textContent.includes("A different interpretation"));
    let unlock;
    const gate = locks.request(storageKey, () => new Promise((resolve) => { unlock = resolve; }));
    await pause();
    const beforeConcurrentWrites = stored.get(storageKey);
    const concurrentEdits = [
      a.edit("Research notes", "Concurrent alpha note"),
      b.edit("Research notes", "Concurrent beta note"),
      a.subset("Concurrent alpha subset"),
      b.subset("Concurrent beta subset"),
    ];
    await pause();
    assert.equal(stored.get(storageKey), beforeConcurrentWrites, "queued saves must wait for the cross-tab lock");
    unlock();
    await gate;
    await Promise.all(concurrentEdits);
    await pause();
    const concurrent = JSON.parse(stored.get(storageKey));
    assert.equal(concurrent.annotations[alpha].note, "Concurrent alpha note");
    assert.equal(concurrent.annotations[beta].note, "Concurrent beta note");
    assert(Object.hasOwn(concurrent.cohorts, "Concurrent alpha subset"));
    assert(Object.hasOwn(concurrent.cohorts, "Concurrent beta subset"));
    const unsupported = await tab();
    Object.defineProperty(unsupported.w.navigator, "locks", { value: undefined });
    const beforeUnsupportedSave = stored.get(storageKey);
    await unsupported.edit("Research notes", "Session-only without locks");
    assert(unsupported.d.getElementById("error").textContent.includes("cannot coordinate saves"));
    assert.equal(stored.get(storageKey), beforeUnsupportedSave);
    assert.equal((await unsupported.backup()).annotations[alpha].note, "Session-only without locks");
    const invalidImport = await tab();
    const validBackup = await invalidImport.backup();
    const multiBackup = structuredClone(validBackup);
    const subsetDefaults = {
      q: "", sample: "all", completion: "any", tag: "", bookmarked: false, filters: [],
    };
    multiBackup.cohorts["Imported questions"] = { ...subsetDefaults, questions: ["comments", "réponse 🐦"] };
    multiBackup.cohorts["Legacy question"] = { ...subsetDefaults, question: "comments" };
    await invalidImport.restore(multiBackup);
    for (const [name, questions] of [["Imported questions", ["comments", "réponse 🐦"]], ["Legacy question", ["comments"]]]) {
      invalidImport.d.getElementById("cohort-list").value = name;
      invalidImport.d.getElementById("cohort-list").dispatchEvent(new invalidImport.w.Event("change"));
      await pause();
      assert.deepEqual([...invalidImport.d.querySelectorAll("#question input:checked")].map((i) => i.value), questions);
    }
    const beforeInvalidImport = stored.get(storageKey);
    for (const questions of [["why", "risk"], ["unknown"], "why"]) {
      const invalid = structuredClone(validBackup);
      invalid.cohorts.Broken = { ...subsetDefaults, questions };
      await invalidImport.restore(invalid);
      assert(invalidImport.d.getElementById("error").textContent.includes("Invalid saved subset"));
      assert.equal(stored.get(storageKey), beforeInvalidImport);
    }
    for (const filter of [
      { question: "pace", op: "gte", value: "10" },
      { question: "pace", op: "lte", value: "10" },
      { question: "risk", op: "gte", value: "not a number" },
      { question: "risk", op: "eq", value: "Infinity" },
    ]) {
      const invalid = structuredClone(validBackup);
      invalid.annotations[alpha].note = "Must never be applied";
      invalid.cohorts.Broken = {
        q: "", question: "", sample: "retained", completion: "any",
        tag: "", bookmarked: false, filters: [filter],
      };
      await invalidImport.restore(invalid);
      assert(invalidImport.d.getElementById("error").textContent.includes("Numeric filters require"));
      assert.equal(stored.get(storageKey), beforeInvalidImport);
      assert.notEqual(invalidImport.d.querySelector('[aria-label="Research notes"]').value, "Must never be applied");
    }
    const debounce = await tab();
    const releaseOldSearch = debounce.holdSearch();
    selectQuestions(debounce.w, ["why"]);
    await pause();
    debounce.d.getElementById("search").value = "A query with no synthetic matches";
    debounce.d.getElementById("search").dispatchEvent(new debounce.w.Event("input"));
    const runSearch = await releaseOldSearch();
    assert(debounce.d.getElementById("export-data").disabled);
    assert.equal(debounce.d.getElementById("response-count").textContent, "3");
    await runSearch();
    assert.equal(debounce.d.getElementById("response-count").textContent, "0");
    assert(debounce.d.getElementById("export-data").disabled);
    release = race.holdRespondent("gamma");
    race.w.location.hash = "#respondent=gamma&question=why";
    await pause();
    race.w.location.hash = "#respondent=beta&question=why";
    await pause();
    await release();
    assert(race.w.location.hash.includes("respondent=beta"));
    assert(race.d.getElementById("detail").textContent.includes("A different interpretation"));
  } finally {
    for (const w of windows) w.close();
  }
}

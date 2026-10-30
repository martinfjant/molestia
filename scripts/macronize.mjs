#!/usr/bin/env node
/**
 * Add macrons to the Latin in JSON/*.json using latin-macronizer-wasm
 * (https://github.com/hellpanderrr/latin-macronizer-wasm), run in Node
 * the same way as that repo's cli.mjs.
 *
 *   node scripts/macronize.mjs                 dry run: print changes for every lesson
 *   node scripts/macronize.mjs 8 9             only lessons 8 and 9
 *   node scripts/macronize.mjs --write         save the changes into the JSON files
 *   node scripts/macronize.mjs --force         also redo strings that already have macrons
 *
 * Expects the macronizer cloned at tools/latin-macronizer-wasm (override with
 * MACRONIZER_DIR). Footnote markers like <sup>1</sup> are left untouched.
 */
import "fake-indexeddb/auto";

// The macronizer's package.json has no "type": "module"; Node warns about it on import.
process.removeAllListeners("warning");
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const JSON_DIR = join(ROOT, "JSON");
const MACRONIZER_DIR = process.env.MACRONIZER_DIR ?? join(ROOT, "tools", "latin-macronizer-wasm");

const args = process.argv.slice(2);
const write = args.includes("--write");
const force = args.includes("--force");
const verbose = args.includes("--verbose");
const only = new Set(args.filter((a) => /^\d+$/.test(a)).map(Number));

const MACRON = /[āēīōūȳĀĒĪŌŪȲ]/;
const strip = (s) => s.normalize("NFD").replace(/̄/g, "").normalize("NFC");

// Every Latin string in a lesson, as [label, get, set].
function latinFields(d) {
  const fields = [];
  const add = (label, obj, key) => {
    if (obj && typeof obj[key] === "string" && obj[key].trim()) {
      fields.push([label, () => obj[key], (v) => (obj[key] = v)]);
    }
  };
  add("subtitle", d.meta.subtitle, "latin");
  d.latin.forEach((_, i) => add(`latin ${i + 1}`, d.latin, i));
  d.exercises.latin.forEach((_, i) => add(`exercise ${i + 1}`, d.exercises.latin, i));
  if (d.song) {
    add("song title", d.song.title, "latin");
    d.song.latin.forEach((_, i) => add(`song ${i + 1}`, d.song.latin, i));
  }
  (d.sources ?? []).forEach((s, i) => add(`source ${i + 1}`, s, "latin"));
  (d.headings ?? []).forEach((h, i) => add(`heading ${i + 1}`, h, "latin"));
  return fields;
}

// Copy the macrons from `macronized` (plain text) onto `original` (which may
// contain HTML tags such as <sup>1</sup>). Returns null if the texts diverge.
function transferMacrons(original, macronized) {
  const out = [...macronized.normalize("NFC")];
  let j = 0;
  let result = "";
  for (let i = 0; i < original.length; i++) {
    const ch = original[i];
    if (ch === "<") {
      const end = original.indexOf(">", i);
      const closing = original.indexOf("</sup>", i);
      // Skip a whole <sup>…</sup> marker, or a lone tag.
      const stop = original.startsWith("<sup>", i) && closing !== -1 ? closing + 6 : end + 1;
      result += original.slice(i, stop);
      i = stop - 1;
      continue;
    }
    // Whitespace may have been collapsed or added around the removed tags.
    while (j < out.length && /\s/.test(out[j]) && !/\s/.test(ch)) j++;
    if (/\s/.test(ch) && !(j < out.length && /\s/.test(out[j]))) {
      result += ch;
      continue;
    }
    if (j >= out.length || strip(out[j]).toLowerCase() !== ch.toLowerCase()) return null;
    // Keep the original's case and character; only add the macron.
    result += out[j] !== strip(out[j]) ? (ch + "̄").normalize("NFC") : ch;
    j++;
  }
  return result;
}

// Node's fetch() can't read file: URLs, which is how the macronizer loads its
// endings and lemma data; without this they are silently skipped.
const nodeFetch = globalThis.fetch;
globalThis.fetch = async (url, ...rest) => {
  const href = String(url);
  if (!href.startsWith("file:")) return nodeFetch(url, ...rest);
  try {
    return new Response(await readFile(fileURLToPath(href)));
  } catch {
    return new Response(null, { status: 404 });
  }
};

// The macronizer logs a lot; keep our own output readable unless --verbose.
const log = console.log;
if (!verbose) console.log = console.info = console.warn = console.debug = () => {};

async function loadMacronizer() {
  const { Macronizer } = await import(pathToFileURL(join(MACRONIZER_DIR, "dist", "core", "Macronizer.js")).href);
  const macronizer = new Macronizer({ useWasm: false, enableCache: true });
  // Morpheus is browser-only; stub it out exactly like the repo's cli.mjs does.
  macronizer.morpheusAnalyzer = null;
  macronizer.wordlistEngine.setMorpheusAnalyzer({
    isInitialized: () => true,
    analyzeBatch: (words) => words.map((w) => ({ word: w, success: false, analyses: [] })),
  });
  await macronizer.initialize(() => {});
  const wordlist = await readFile(join(MACRONIZER_DIR, "public", "macrons.txt"), "utf8");
  await macronizer.wordlistEngine.loadFromText(wordlist);
  return macronizer;
}

const files = (await readdir(JSON_DIR)).filter((f) => f.endsWith(".json")).sort();
console.error(`Loading macronizer from ${MACRONIZER_DIR} …`);
const macronizer = await loadMacronizer();

let changed = 0;
let failed = 0;
for (const file of files) {
  const path = join(JSON_DIR, file);
  const lesson = JSON.parse(await readFile(path, "utf8"));
  if (only.size && !only.has(lesson.meta.lesson)) continue;

  let fileChanged = false;
  for (const [label, get, set] of latinFields(lesson)) {
    const original = get();
    if (!force && MACRON.test(original)) continue;
    const plain = strip(original).replace(/<sup>\d+<\/sup>/g, "").replace(/<[^>]+>/g, "");
    const { macronized } = await macronizer.macronize(plain, { scan: "prose" });
    const result = transferMacrons(strip(original), macronized);
    if (result === null) {
      failed++;
      log(`${file} ${label}: could not align, left unchanged\n  - ${original}\n  ? ${macronized}`);
      continue;
    }
    if (result !== original) {
      changed++;
      fileChanged = true;
      log(`${file} ${label}\n  - ${original}\n  + ${result}`);
      set(result);
    }
  }
  if (write && fileChanged) await writeFile(path, JSON.stringify(lesson, null, 2) + "\n");
}

macronizer.destroy();
console.error(`\n${changed} strings ${write ? "updated" : "would change"}, ${failed} could not be aligned.`);
if (!write && changed) console.error("Dry run — re-run with --write to save.");

#!/usr/bin/env node
/**
 * Add macrons to the Latin in JSON/*.json using latin-macronizer-wasm
 * (https://github.com/hellpanderrr/latin-macronizer-wasm), with its WASM
 * RFTagger and Morpheus running in Node.
 *
 *   node scripts/macronize.mjs                 dry run: print changes for every lesson
 *   node scripts/macronize.mjs 8 9             only lessons 8 and 9
 *   node scripts/macronize.mjs --write         save the changes into the JSON files
 *   node scripts/macronize.mjs --force         also redo strings that already have macrons
 *   node scripts/macronize.mjs --fallback      use the suffix-rule tagger instead of WASM
 *   node scripts/macronize.mjs --show-accents  also print each new accented version
 *
 * Every Latin field also gets a `latinAccented` twin with liturgical stress
 * accents, rederived on each run from the macrons in `latin`, so correct the
 * macrons and re-run to fix the accents.
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
const fallback = args.includes("--fallback");
const verboseAccents = args.includes("--show-accents");
const only = new Set(args.filter((a) => /^\d+$/.test(a)).map(Number));

const MACRON = /[āēīōūȳĀĒĪŌŪȲ]/;
const strip = (s) => s.normalize("NFD").replace(/̄/g, "").normalize("NFC");

// Put `latinAccented` right after `latin` in `obj`, so the JSON reads naturally.
function setAfterLatin(obj, value) {
  const entries = Object.entries(obj).filter(([k]) => k !== "latinAccented");
  const at = entries.findIndex(([k]) => k === "latin") + 1;
  entries.splice(at, 0, ["latinAccented", value]);
  for (const k of Object.keys(obj)) delete obj[k];
  Object.assign(obj, Object.fromEntries(entries));
}

// Every Latin string in a lesson, as { label, get, set, getAccented, setAccented }.
// Wherever there is a `latin` value, its accented twin lives in `latinAccented`
// beside it (a parallel array for sentence lists).
function latinFields(d) {
  const fields = [];
  const scalar = (label, obj) => {
    if (!obj?.latin?.trim()) return;
    fields.push({
      label,
      get: () => obj.latin,
      set: (v) => (obj.latin = v),
      getAccented: () => obj.latinAccented,
      setAccented: (v) => setAfterLatin(obj, v),
    });
  };
  const list = (label, owner) =>
    owner.latin.forEach((_, i) =>
      fields.push({
        label: `${label} ${i + 1}`,
        get: () => owner.latin[i],
        set: (v) => (owner.latin[i] = v),
        getAccented: () => owner.latinAccented?.[i],
        setAccented: (v) => {
          if (!Array.isArray(owner.latinAccented) || owner.latinAccented.length !== owner.latin.length) {
            setAfterLatin(owner, owner.latin.map(() => ""));
          }
          owner.latinAccented[i] = v;
        },
      })
    );
  scalar("subtitle", d.meta.subtitle);
  list("latin", d);
  list("exercise", d.exercises);
  if (d.song) {
    scalar("song title", d.song.title);
    list("song", d.song);
  }
  (d.sources ?? []).forEach((s, i) => scalar(`source ${i + 1}`, s));
  (d.headings ?? []).forEach((h, i) => scalar(`heading ${i + 1}`, h));
  return fields;
}

// Add liturgical stress accents (aedificā́ta, plaustrúmque) to `text`, using the
// macrons already in it for the vowel quantities, so hand corrections carry
// through. `tokens` (from the macronizer) say which words have an enclitic.
function accentText(text, tokens, applyStress) {
  const words = [];
  for (const t of tokens) {
    if (!/\p{L}/u.test(t.text)) continue;
    if (t.isenclitic && words.length) {
      words.at(-1).word += t.text;
      words.at(-1).enclitic = true;
    } else {
      words.push({ word: t.text, enclitic: false });
    }
  }
  const quantities = (w) => w.normalize("NFD").replace(/([aeiouy])̄/gi, "$1_").normalize("NFC");
  let k = 0;
  return text.replace(/<[^>]*>[^<]*<\/sup>|<[^>]*>|[\p{L}\p{M}]+/gu, (m) => {
    if (m.startsWith("<")) return m;
    const key = strip(m).toLowerCase();
    const found = words.findIndex((w, i) => i >= k && strip(w.word).toLowerCase() === key);
    if (found !== -1) k = found + 1;
    return applyStress(m, quantities(m), found !== -1 && words[found].enclitic);
  });
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
const status = console.error;
if (!verbose) console.log = console.info = console.warn = console.debug = console.error = () => {};

// The WASM modules (RFTagger, Morpheus) were built with -sENVIRONMENT=web,worker,
// so their Emscripten glue refuses to start under Node. The WebAssembly itself
// runs fine, though: evaluate the glue with `process` hidden so it takes its
// browser code path, and hand it the .wasm/.data bytes instead of letting it
// fetch them. The macronizer's own wrappers then pick the factories up from
// `window`, exactly as they do in the browser.
async function installWasmModules() {
  const wasmDir = join(MACRONIZER_DIR, "public", "wasm");
  const read = (f) => readFile(join(wasmDir, f));
  const browserLike = new Proxy(globalThis, {
    get: (target, key) => (key === "process" ? undefined : Reflect.get(target, key)),
    has: (target, key) => key !== "process" && Reflect.has(target, key),
  });
  const loadGlue = async (file, name) =>
    new Function("process", "module", "exports", "define", "globalThis", `${await read(file)}\nreturn ${name};`)(
      undefined, undefined, undefined, undefined, browserLike
    );

  globalThis.window ??= globalThis;
  globalThis.location ??= { href: "file:///", pathname: "/" };

  const [rftagger, rftaggerWasm] = [await loadGlue("rftagger.js", "RFTaggerModule"), await read("rftagger.wasm")];
  window.RFTaggerModule = (opts) => rftagger({ ...opts, wasmBinary: rftaggerWasm, printErr: () => {} });

  const [morpheus, morpheusWasm, morpheusData] = [
    await loadGlue("cruncher.js", "Morpheus"),
    await read("cruncher.wasm"),
    await read("cruncher.data"),
  ];
  const dataBuffer = morpheusData.buffer.slice(morpheusData.byteOffset, morpheusData.byteOffset + morpheusData.byteLength);
  window.Morpheus = (opts) =>
    morpheus({ ...opts, wasmBinary: morpheusWasm, getPreloadedPackage: () => dataBuffer, print: () => {}, printErr: () => {} });

  return pathToFileURL(join(wasmDir, "rftagger-ldt.model")).href;
}

async function loadMacronizer() {
  const { Macronizer } = await import(pathToFileURL(join(MACRONIZER_DIR, "dist", "core", "Macronizer.js")).href);
  let macronizer;
  if (fallback) {
    macronizer = new Macronizer({ useWasm: false, enableCache: true });
    // Without WASM there is no Morpheus; stub it out like the repo's cli.mjs does.
    macronizer.morpheusAnalyzer = null;
    macronizer.wordlistEngine.setMorpheusAnalyzer({
      isInitialized: () => true,
      analyzeBatch: (words) => words.map((w) => ({ word: w, success: false, analyses: [] })),
    });
  } else {
    const modelUrl = await installWasmModules();
    macronizer = new Macronizer({ useWasm: true, enableCache: true, wasmModelPath: modelUrl });
    // Its loader would inject a <script> tag; the factory is already on window.
    macronizer.morpheusAnalyzer.loadScript = async () => {};
  }
  await macronizer.initialize(() => {});
  const wordlist = await readFile(join(MACRONIZER_DIR, "public", "macrons.txt"), "utf8");
  await macronizer.wordlistEngine.loadFromText(wordlist);
  return macronizer;
}

const files = (await readdir(JSON_DIR)).filter((f) => f.endsWith(".json")).sort();
status(`Loading macronizer from ${MACRONIZER_DIR} (${fallback ? "fallback tagger" : "WASM"}) …`);
const macronizer = await loadMacronizer();
const { applyStress } = await import(pathToFileURL(join(MACRONIZER_DIR, "dist", "core", "Stress.js")).href);

let changed = 0;
let accented = 0;
let failed = 0;
for (const file of files) {
  const path = join(JSON_DIR, file);
  const lesson = JSON.parse(await readFile(path, "utf8"));
  if (only.size && !only.has(lesson.meta.lesson)) continue;
  // Revision lessons are one Markdown `content` field, with no sentence lists.
  if (lesson.meta.revision) continue;

  let fileChanged = false;
  for (const { label, get, set, getAccented, setAccented } of latinFields(lesson)) {
    const original = get();
    const plain = strip(original).replace(/<sup>\d+<\/sup>/g, "").replace(/<[^>]+>/g, "");
    const { macronized, taggedTokens } = await macronizer.macronize(plain, { scan: "prose" });

    let text = original;
    if (force || !MACRON.test(original)) {
      const result = transferMacrons(strip(original), macronized);
      if (result === null) {
        failed++;
        log(`${file} ${label}: could not align, left unchanged\n  - ${original}\n  ? ${macronized}`);
      } else if (result !== original) {
        changed++;
        fileChanged = true;
        log(`${file} ${label}\n  - ${original}\n  + ${result}`);
        set(result);
        text = result;
      }
    }

    // Always rederive the accents from the current macrons.
    const stressed = accentText(text, taggedTokens, applyStress);
    if (stressed !== getAccented()) {
      accented++;
      fileChanged = true;
      if (verboseAccents) log(`${file} ${label}\n  ´ ${stressed}`);
      setAccented(stressed);
    }
  }
  if (write && fileChanged) await writeFile(path, JSON.stringify(lesson, null, 2) + "\n");
}

macronizer.destroy();
status(
  `\n${changed} strings ${write ? "macronized" : "would be macronized"}, ` +
    `${accented} accented versions ${write ? "updated" : "would be updated"}, ${failed} could not be aligned.`
);
if (!write && (changed || accented)) status("Dry run — re-run with --write to save.");

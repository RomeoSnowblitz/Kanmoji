// Builds the concept dictionary from core Kanmoji symbols (IDs 1–999)
// and the Learn vocabulary lists (IDs from 1000). The same number is one
// definition across languages: E1000, C1000, and G1000 are that concept.
// Old 1-1 dictionary rows are not copied.
import fs from "fs";
import path from "path";
import vm from "vm";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const letters = ["C", "E", "F", "G", "I", "J", "K", "P", "R", "S"];
const letterCode = { C: "zh", E: "en", F: "fr", G: "de", I: "it", J: "ja", K: "ko", P: "pt", R: "ru", S: "es" };
const codes = ["zh", "en", "fr", "de", "it", "ja", "ko", "pt", "ru", "es"];
const vocabFile = {
  C: "Chinese.txt",
  E: "English.txt",
  F: "French.txt",
  G: "German.txt",
  I: "Italian.txt",
  J: "Japanese.txt",
  K: "Korean.txt",
  P: "Portuguese.txt",
  R: "Russian.txt",
  S: "Spanish.txt",
};

function parseVocabLine(line) {
  const end = line.lastIndexOf(" (");
  if (end < 0 || line.charCodeAt(line.length - 1) !== 41) return { text: line.trim(), first: null };
  const head = line.slice(0, end);
  const linkAt = head.lastIndexOf(" (");
  if (linkAt < 0 || head.charCodeAt(head.length - 1) !== 41) return { text: head.trim(), first: null };
  const text = head.slice(0, linkAt);
  const ids = head.slice(linkAt + 2, -1);
  const first = new Uint32Array(10);
  let i = 0;
  while (i < ids.length) {
    const comma = ids.indexOf(", ", i);
    const token = comma < 0 ? ids.slice(i) : ids.slice(i, comma);
    i = comma < 0 ? ids.length : comma + 2;
    const letter = token.charAt(0);
    const slot = letters.indexOf(letter);
    if (slot < 0 || first[slot]) continue;
    let n = 0;
    for (let c = 1; c < token.length; c++) {
      const d = token.charCodeAt(c) - 48;
      if (d < 0 || d > 9) { n = 0; break; }
      n = n * 10 + d;
    }
    if (n > 0) first[slot] = n;
  }
  return { text, first };
}

function loadLines(letter) {
  const file = path.join(root, "NewLearn", "Vocabulary", vocabFile[letter]);
  const raw = fs.readFileSync(file, "utf8");
  const rows = raw.split(/\r?\n/);
  if (rows.length && rows[rows.length - 1] === "") rows.pop();
  const texts = new Array(rows.length);
  const firsts = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const parsed = parseVocabLine(rows[i]);
    texts[i] = parsed.text;
    firsts[i] = parsed.first;
  }
  return { texts, firsts };
}

function jsString(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/\r|\n|\t/g, " ")
    .replace(/</g, "\\u003c");
}

function loadSymbols() {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, "translations.js"), "utf8"), { window });
  const symbols = vm.runInNewContext(
    fs.readFileSync(path.join(root, "symbols.js"), "utf8") + "\nsymbols;",
    {}
  );
  return { translations: window.TRANSLATIONS, symbols };
}

const { translations, symbols } = loadSymbols();
const core = symbols
  .filter((symbol) => symbol && symbol.id > 0 && symbol.id < 1000)
  .sort((a, b) => a.id - b.id);

const texts = {};
const firsts = {};
letters.forEach((letter) => {
  const loaded = loadLines(letter);
  texts[letter] = loaded.texts;
  firsts[letter] = loaded.firsts;
  console.log(letter, loaded.texts.length);
});

const assigned = {};
letters.forEach((letter) => {
  assigned[letter] = new Uint32Array(texts[letter].length);
});

const concepts = [];
let nextId = 1000;
for (let li = 0; li < letters.length; li++) {
  const letter = letters[li];
  const rows = texts[letter];
  for (let i = 0; i < rows.length; i++) {
    if (assigned[letter][i]) continue;
    const id = nextId++;
    const at = new Int32Array(10);
    at.fill(-1);
    at[li] = i;
    assigned[letter][i] = id;
    const links = firsts[letter][i];
    if (links) {
      for (let oi = 0; oi < letters.length; oi++) {
        if (oi === li) continue;
        const num = links[oi];
        if (!num) continue;
        const idx = num - 1;
        const other = letters[oi];
        if (idx < 0 || idx >= assigned[other].length) continue;
        if (assigned[other][idx]) continue;
        assigned[other][idx] = id;
        at[oi] = idx;
      }
    }
    concepts.push({ id, origin: letterCode[letter], at });
  }
  firsts[letter] = null;
  console.log("assigned", letter, "concepts", concepts.length);
}

const outPath = path.join(root, "world-dictionary-data.js");
const tempPath = outPath + ".tmp";
const out = fs.createWriteStream(tempPath, { encoding: "utf8" });
out.write("// Concept dictionary built from core Kanmoji symbols and Learn vocabulary.\n");
out.write("// Fields: id, origin, pos, definition, zh, en, fr, de, it, ja, ko, pt, ru, es.\n");
out.write("// The same id is one definition in every language. IDs 1-999 are core words.\n");
out.write("window.WORLD_DICTIONARY_ROWS = [];\n");
out.write("window.DICTIONARY_CONCEPTS = [\n");

function writeLine(fields) {
  out.write("\"" + fields.map(jsString).join("\t") + "\",\n");
}

core.forEach((symbol) => {
  const words = codes.map((code) => {
    const pack = translations[code] && translations[code].symbols && translations[code].symbols[symbol.id];
    const name = pack && pack.name ? pack.name : (code === "en" ? symbol.name : "");
    return name || "";
  });
  writeLine([String(symbol.id), "en", "", "", ...words]);
});

concepts.forEach((concept) => {
  const words = letters.map((letter, index) => {
    const line = concept.at[index];
    return line < 0 ? "" : (texts[letter][line] || "");
  });
  writeLine([String(concept.id), concept.origin, "", "", ...words]);
});

out.write("];\n");
await new Promise((resolve, reject) => {
  out.on("finish", resolve);
  out.on("error", reject);
  out.end();
});

fs.copyFileSync(tempPath, outPath);
fs.unlinkSync(tempPath);
const oldTxt = path.join(root, "WorldDictionary.txt");
if (fs.existsSync(oldTxt)) fs.unlinkSync(oldTxt);
console.log("core", core.length, "learn", concepts.length, "next", nextId);

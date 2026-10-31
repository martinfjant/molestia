import { readdir, readFile } from "node:fs/promises";

const dir = new URL("../../JSON/", import.meta.url);

export default async function () {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  const lessons = await Promise.all(
    files.map(async (f) => ({ ...JSON.parse(await readFile(new URL(f, dir), "utf8")), file: `JSON/${f}` }))
  );
  return lessons.sort((a, b) => a.meta.lesson - b.meta.lesson);
}

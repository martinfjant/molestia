export default function (eleventyConfig) {
  // Rebuild when lesson data changes (it lives outside the input dir).
  eleventyConfig.addWatchTarget("JSON/");

  // Split a lesson's sentences into numbered runs, broken by mid-lesson
  // headings ("before" sentence n) and source lines ("after" sentence n).
  eleventyConfig.addFilter("segments", (lesson, lang) => {
    const breaks = new Map();
    for (const h of lesson.headings ?? []) breaks.set(h.before - 1, { heading: h[lang] });
    for (const s of lesson.sources ?? []) breaks.set(s.after, { ...breaks.get(s.after), source: s[lang] });

    const out = [];
    let run = { start: 1, items: [] };
    lesson[lang].forEach((sentence, i) => {
      const br = breaks.get(i);
      if (br) {
        if (run.items.length) out.push(run);
        out.push(br);
        run = { start: i + 1, items: [] };
      }
      run.items.push(sentence);
    });
    if (run.items.length) out.push(run);
    const tail = breaks.get(lesson[lang].length);
    if (tail) out.push(tail);
    return out;
  });

  // Text blocks use blank lines between paragraphs and single newlines within.
  eleventyConfig.addFilter("paras", (text) =>
    text.split("\n\n").map((p) => `<p>${p.replaceAll("\n", "<br>")}</p>`).join("\n")
  );

  return {
    dir: { input: "site", output: "_site" },
  };
}

export default function (eleventyConfig) {
  // Rebuild when lesson data changes (it lives outside the input dir).
  eleventyConfig.addWatchTarget("JSON/");

  // Latin/English pairs, one per row of the parallel grid: numbered sentences,
  // plus any mid-lesson headings ("before" sentence n) and source lines
  // ("after" sentence n). Latin comes with its accented twin.
  eleventyConfig.addFilter("rows", (owner, { headings = [], sources = [] } = {}) => {
    const twin = (obj) => ({ la: { text: obj.latin, accented: obj.latinAccented }, en: obj.english });
    const rows = [];
    const count = Math.max(owner.latin.length, owner.english.length);
    for (let i = 0; i < count; i++) {
      for (const h of headings) if (h.before === i + 1) rows.push({ kind: "heading", ...twin(h) });
      rows.push({
        kind: "sentence",
        n: i + 1,
        la: { text: owner.latin[i] ?? "", accented: owner.latinAccented?.[i] },
        en: owner.english[i] ?? "",
      });
      for (const s of sources) if (s.after === i + 1) rows.push({ kind: "source", ...twin(s) });
    }
    return rows;
  });

  // Latin text plus its stress-accented twin; the header toggle swaps which
  // one is hidden.
  eleventyConfig.addFilter("la", (text, accented) =>
    accented && accented !== text
      ? `<span data-plain>${text}</span><span data-accented hidden>${accented}</span>`
      : text
  );

  // Text blocks use blank lines between paragraphs and single newlines within.
  eleventyConfig.addFilter("paras", (text) =>
    text.split("\n\n").map((p) => `<p>${p.replaceAll("\n", "<br>")}</p>`).join("\n")
  );

  return {
    dir: { input: "site", output: "_site" },
  };
}

import { RenderPlugin } from "@11ty/eleventy";

export default function (eleventyConfig) {
  // Notes and revisions are Markdown, rendered with Eleventy's own markdown-it
  // through `renderContent("md")`. A single newline is a line break, as the
  // book's notes are full of line-by-line examples.
  eleventyConfig.addPlugin(RenderPlugin);
  eleventyConfig.amendLibrary("md", (md) => {
    md.set({ breaks: true });
    // Wide tables (declensions, conjugations) scroll on their own on narrow screens.
    md.renderer.rules.table_open = () => '<div class="table-scroll"><table>\n';
    md.renderer.rules.table_close = () => "</table></div>\n";
  });

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

  // Previous and next lesson in book order, whatever their kind.
  eleventyConfig.addFilter("neighbors", (lessons, n) => {
    const i = lessons.findIndex((l) => l.meta.lesson === n);
    return { previous: lessons[i - 1], next: lessons[i + 1] };
  });

  return {
    dir: { input: "site", output: "_site" },
  };
}

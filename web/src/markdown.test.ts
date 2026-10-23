// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { docIdForPath, renderMarkdown, slugify } from "./markdown";

describe("documentation markdown", () => {
  it("makes GitHub-style anchors", () => {
    expect(slugify("What to verify")).toBe("what-to-verify");
    expect(slugify("Docker: run it (v2)")).toBe("docker-run-it-v2");
  });

  it("maps links between documents", () => {
    expect(docIdForPath("docs/ARCHITECTURE.md#8-placement")).toBe("architecture");
    expect(docIdForPath("./docs/validation.md")).toBe("validation");
    expect(docIdForPath("tools/etl/README.md")).toBe("etl");
    expect(docIdForPath("README.md")).toBe("readme");
    expect(docIdForPath("Dockerfile")).toBeNull();
  });

  it("renders headings with ids, tables and code, and lists the headings", () => {
    const r = renderMarkdown("# Title\n\n## Run it\n\n```bash\ndocker compose up\n```\n\n## Run it\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
    expect(r.html).toContain('<h2 id="run-it">');
    expect(r.html).toContain('<h2 id="run-it-1">');
    expect(r.html).toContain("<table>");
    expect(r.html).toContain("docker compose up");
    expect(r.headings.map((h) => h.id)).toEqual(["run-it", "run-it-1"]);
  });

  it("removes scripts and event handlers", () => {
    const r = renderMarkdown('hi <script>alert(1)</script> <img src=x onerror="alert(2)"> [x](javascript:alert(3))');
    expect(r.html).not.toMatch(/<script/i);
    expect(r.html).not.toMatch(/onerror/i);
    expect(r.html).not.toMatch(/javascript:/i);
  });

  it("opens external links in a new tab safely, keeps anchors, and links docs", () => {
    const r = renderMarkdown("[out](https://example.com) [in](#run-it) [arch](docs/ARCHITECTURE.md#9) [file](Dockerfile)");
    expect(r.html).toContain('target="_blank"');
    expect(r.html).toContain('rel="noopener noreferrer"');
    expect(r.html).toContain('href="#run-it"');
    expect(r.html).toContain('data-doc="architecture"');
    expect(r.html).toContain('data-anchor="9"');
    expect(r.html).toContain('class="doc-file"');
  });
});

import { describe, expect, it } from "bun:test";
import { parseSteamripGameDetails } from "../lib/scraper";

describe("Steamrip game details", () => {
  it("extracts the page title and version from game info", () => {
    const details = parseSteamripGameDetails(`
      <main>
        <h1 class="post-title">Wreckfest 2 Free Download (v365486)</h1>
        <ul>
          <li><strong>Version</strong>: v365486 Content Update #7 (Build 23360499)</li>
        </ul>
      </main>
    `);

    expect(details).toEqual({
      title: "Wreckfest 2 Free Download (v365486)",
      version: "v365486 Content Update #7 (Build 23360499)",
    });
  });
});

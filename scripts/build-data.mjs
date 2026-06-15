import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = resolve(root, "index.html");
const outputPath = resolve(root, "data.json");

function extractSharedCode(html) {
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!scriptMatch) throw new Error("No inline script found in index.html.");
  const script = scriptMatch[1];
  const start = script.indexOf("const HAV_BASE");
  const end = script.indexOf("function saveCache");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("Could not isolate shared data functions in index.html.");
  }
  return script.slice(start, end)
    .replace(/const FORCE_OFFLINE = [^\n]+;/, "const FORCE_OFFLINE = false;")
    .replace(/const FORCE_FALLBACK = [^\n]+;/, "const FORCE_FALLBACK = false;");
}

async function loadSharedRuntime() {
  const html = await readFile(htmlPath, "utf8");
  const sharedCode = extractSharedCode(html);
  const factory = new Function(`${sharedCode}
    return {
      state,
      loadBathingWaters,
      enrichBeaches,
      loadNearbyAmenities,
      compactBeach,
      timeoutAfter
    };
  `);
  return factory();
}

async function main() {
  const startedAt = new Date();
  const runtime = await loadSharedRuntime();
  const beaches = await runtime.loadBathingWaters();
  beaches.sort((a, b) => a.name.localeCompare(b.name, "sv-SE"));
  runtime.state.skaneCount = beaches.length;

  await runtime.enrichBeaches(beaches);
  runtime.state.raw = beaches;

  try {
    await Promise.race([
      runtime.loadNearbyAmenities(beaches),
      runtime.timeoutAfter(180000, "OSM-service tog för lång tid i databygget")
    ]);
  } catch (error) {
    console.warn(error.message);
  }

  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: "github-actions",
    buildSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
    skaneCount: runtime.state.skaneCount || beaches.length,
    osmAmenityCount: runtime.state.osmAmenityCount || 0,
    osmFailedBatches: runtime.state.osmFailedBatches || 0,
    beaches: beaches.map(runtime.compactBeach)
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload)}\n`, "utf8");
  console.log(`Wrote ${payload.beaches.length} beaches to ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

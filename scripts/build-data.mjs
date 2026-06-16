import { readFile, writeFile, mkdir } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = resolve(root, "index.html");
const outputPath = resolve(root, "data.json");
const REQUEST_TIMEOUT_MS = 15000;
const REQUEST_TIMEOUT_SECONDS = Math.round(REQUEST_TIMEOUT_MS / 1000);

function nodeFetch(url, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const target = new URL(url);
    const body = options.body ? String(options.body) : null;
    const headers = { ...(options.headers || {}) };
    if (body && !headers["Content-Length"]) headers["Content-Length"] = Buffer.byteLength(body);
    const client = target.protocol === "http:" ? http : https;
    const request = client.request(target, {
      method: options.method || "GET",
      headers,
      timeout: REQUEST_TIMEOUT_MS
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolvePromise({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode,
          statusText: response.statusMessage || "",
          text: async () => text,
          json: async () => JSON.parse(text)
        });
      });
    });
    request.on("timeout", () => request.destroy(new Error(`Request timeout after ${REQUEST_TIMEOUT_SECONDS}s: ${url}`)));
    request.on("error", reject);
    options.signal?.addEventListener("abort", () => request.destroy(new Error(`Request aborted: ${url}`)), { once: true });
    if (body) request.write(body);
    request.end();
  });
}

globalThis.fetch = nodeFetch;

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
    .replace(/const FORCE_FALLBACK = [^\n]+;/, "const FORCE_FALLBACK = false;")
    .replace(/controller\.abort\(\), 9000\)/g, `controller.abort(), ${REQUEST_TIMEOUT_MS})`)
    .replace(/for \(let attempt = 0; attempt < 3; attempt \+= 1\)/g, "for (let attempt = 0; attempt < 1; attempt += 1)");
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

function restoreExistingHavData(beaches, existing) {
  const previousById = new Map((existing?.beaches || []).map((beach) => [beach.id, beach]));
  let restoredProfiles = 0;
  let restoredResults = 0;
  let restoredForecasts = 0;
  beaches.forEach((beach) => {
    const previous = previousById.get(beach.id);
    if (!previous) return;
    if (!beach.profile && previous.profile) {
      beach.profile = previous.profile;
      restoredProfiles += 1;
    }
    if (!beach.latestResult && previous.latestResult) {
      beach.latestResult = previous.latestResult;
      restoredResults += 1;
    }
    if (!beach.waterForecast?.waterForecasts?.length && previous.waterForecast?.waterForecasts?.length) {
      beach.waterForecast = previous.waterForecast;
      restoredForecasts += 1;
    }
  });
  if (restoredProfiles || restoredResults || restoredForecasts) {
    console.warn(`Restored existing HaV data where refresh was missing: profiles=${restoredProfiles}, results=${restoredResults}, forecasts=${restoredForecasts}`);
  }
}

function restoreExistingStableData(beaches, existing) {
  const previousById = new Map((existing?.beaches || []).map((beach) => [beach.id, beach]));
  let restoredProfiles = 0;
  let restoredService = 0;
  beaches.forEach((beach) => {
    const previous = previousById.get(beach.id);
    if (!previous) return;
    if (previous.profile) {
      beach.profile = previous.profile;
      restoredProfiles += 1;
    }
    if (previous.serviceCheckedAt) {
      beach.nearbyAmenities = Array.isArray(previous.nearbyAmenities) ? previous.nearbyAmenities : [];
      beach.serviceCheckedAt = previous.serviceCheckedAt;
      restoredService += 1;
    }
  });
  if (restoredProfiles || restoredService) {
    console.warn(`Reused stable data: profiles=${restoredProfiles}, service=${restoredService}`);
  }
}

async function main() {
  const startedAt = new Date();
  const runtime = await loadSharedRuntime();
  const existing = JSON.parse(await readFile(outputPath, "utf8").catch(() => "null"));
  let beaches = [];
  try {
    beaches = await runtime.loadBathingWaters();
    beaches.sort((a, b) => a.name.localeCompare(b.name, "sv-SE"));
    runtime.state.skaneCount = beaches.length;
    restoreExistingStableData(beaches, existing);
    await runtime.enrichBeaches(beaches);
    restoreExistingHavData(beaches, existing);
  } catch (error) {
    if (existing?.beaches?.length) {
      console.warn(`Could not refresh full beach list, reusing existing list and refreshing details: ${error.message}`);
      beaches = existing.beaches.map((beach) => ({
        ...beach,
        profile: null,
        latestResult: null,
        waterForecast: null,
        weather: null,
        marine: null,
        nearbyAmenities: []
      }));
      beaches.sort((a, b) => a.name.localeCompare(b.name, "sv-SE"));
      runtime.state.skaneCount = existing.skaneCount || beaches.length;
      restoreExistingStableData(beaches, existing);
      await runtime.enrichBeaches(beaches);
      restoreExistingHavData(beaches, existing);
    } else {
      throw error;
    }
  }

  runtime.state.raw = beaches;

  try {
    const serviceCandidates = beaches.filter((beach) => !beach.serviceCheckedAt);
    if (serviceCandidates.length) {
      await Promise.race([
        runtime.loadNearbyAmenities(serviceCandidates),
        runtime.timeoutAfter(180000, "OSM-service tog för lång tid i databygget")
      ]);
    }
  } catch (error) {
    console.warn(error.message);
  }

  runtime.state.osmAmenityCount = beaches.reduce((sum, beach) => sum + (Array.isArray(beach.nearbyAmenities) ? beach.nearbyAmenities.length : 0), 0);

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

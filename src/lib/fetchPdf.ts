import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { validateUrl, type ValidatedUrl } from "./validateUrl";

const TIMEOUT_MS = 15_000;
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function fetchPdf(source: string): Promise<Buffer> {
  const signal = AbortSignal.timeout(TIMEOUT_MS); // one deadline covering all redirects and the body
  try {
    return await download(source, signal);
  } catch (err) {
    if (signal.aborted) throw new Error(`PDF download timed out after ${TIMEOUT_MS / 1000}s`);
    throw err;
  }
}

async function download(source: string, signal: AbortSignal): Promise<Buffer> {
  let current = source;

  for (let redirects = 0; ; redirects++) {
    const target = await validateUrl(current); // re-validated on every hop
    const res = await request(target, signal);
    const status = res.statusCode ?? 0;

    if (REDIRECT_STATUSES.has(status)) {
      res.resume(); // drain and discard the redirect body so the socket is released
      const location = res.headers.location;
      if (!location) throw new Error(`Redirect (HTTP ${status}) without a Location header`);
      if (redirects >= MAX_REDIRECTS) throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
      current = new URL(location, target.url).toString(); // Location may be relative
      continue;
    }

    if (status < 200 || status >= 300) {
      res.resume();
      throw new Error(`PDF download failed: HTTP ${status}`);
    }

    const contentType = (res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/pdf") {
      res.destroy();
      throw new Error(`Expected application/pdf but got "${contentType || "no content-type"}"`);
    }

    const declaredLength = Number(res.headers["content-length"]);
    if (declaredLength > MAX_PDF_BYTES) {
      res.destroy();
      throw new Error(`PDF is too large: ${declaredLength} bytes (max ${MAX_PDF_BYTES})`);
    }

    // Count bytes as they arrive: Content-Length can be missing or wrong.
    const parts: Buffer[] = [];
    let total = 0;
    for await (const part of res as AsyncIterable<Buffer>) {
      total += part.length;
      if (total > MAX_PDF_BYTES) {
        res.destroy();
        throw new Error(`PDF is too large: over ${MAX_PDF_BYTES} bytes`);
      }
      parts.push(part);
    }

    const body = Buffer.concat(parts);
    if (body.subarray(0, 5).toString("latin1") !== "%PDF-") {
      throw new Error("Response claims to be a PDF but does not start with %PDF-"); // servers mislabel HTML error pages
    }
    return body;
  }
}

function request(target: ValidatedUrl, signal: AbortSignal): Promise<http.IncomingMessage> {
  // Connect to the IP validateUrl already checked instead of resolving again (blocks DNS rebinding).
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address: target.address, family: target.family }]);
    else callback(null, target.address, target.family);
  };

  const client = target.url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      target.url,
      { method: "GET", lookup, signal, headers: { accept: "application/pdf" } },
      resolve,
    );
    req.on("error", reject);
    req.end();
  });
}

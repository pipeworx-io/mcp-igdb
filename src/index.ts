interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * IGDB — the Internet Game Database (Twitch/Amazon), the reference catalogue
 * for video games.
 *
 * ~300,000 games with release dates per platform and region, genres, themes,
 * game modes, player perspectives, cover art, critic and user ratings, the
 * companies that developed and published each one, franchises, DLC and
 * remasters, and the ~200 platforms from the Atari 2600 to current consoles.
 * It is the catalogue Twitch itself categorises streams against — Twitch game
 * ids and IGDB game ids are the same id space, which is what makes it useful
 * next to the `twitch` pack: one answers "what is being streamed", this one
 * answers "what IS that game, who made it, when did it ship".
 *
 * AUTH — SAME CREDENTIAL AS THE TWITCH PACK, DELIBERATELY. IGDB is gated by
 * Twitch OAuth: a Client-ID plus an app access token from the
 * client-credentials grant. This pack takes `_apiKey` as "CLIENT_ID:CLIENT_
 * SECRET" and exchanges it per call (packs are stateless, and the token is
 * valid for ~60 days so the exchange is cheap relative to a cold isolate).
 * The gateway backs it with PLATFORM_TWITCH_KEY — the SAME secret the twitch
 * pack already uses, because it is the same Twitch application. No new binding
 * was added for this pack, which matters: the gateway is at Cloudflare's
 * 250-text-binding cap.
 *
 * Callers can override with their own credentials from
 * https://dev.twitch.tv/console — useful if they want their own rate budget.
 *
 * QUERY LANGUAGE — APICALYPSE, NOT QUERY STRINGS. IGDB v4 is POST-only and the
 * request BODY is a small DSL: `fields name,summary; search "zelda"; limit 10;`
 * Every clause ends in a semicolon and `fields` is MANDATORY — omit it and you
 * get an empty object per row rather than an error, which is the classic silent
 * zero here. This pack always sends an explicit field list.
 *
 * TWO WAYS TO MATCH A NAME, AND THEY BEHAVE DIFFERENTLY: `search "x"` runs
 * IGDB's relevance search but CANNOT be combined with `sort`, while
 * `where name ~ *"x"*` is a substring filter that can. This pack uses `search`
 * for the game and company tools (relevance is what a caller wants) and a
 * where-filter for platforms (a short, sortable list).
 *
 * DATES ARE UNIX SECONDS. first_release_date is an integer epoch, not a
 * string; every date here is also returned as an ISO day so a caller never has
 * to guess the unit.
 */


const UA = 'pipeworx-mcp-igdb/1.0 (+https://pipeworx.io)';
const BASE = 'https://api.igdb.com/v4';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const SOURCE = 'IGDB (Internet Game Database) v4 API, igdb.com';

const KEY_DESC =
  'Twitch app credentials as "CLIENT_ID:CLIENT_SECRET" (IGDB is gated by Twitch OAuth). Optional — omit to use the shared Pipeworx credential. Get your own at https://dev.twitch.tv/console.';

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, 'IGDB');
}

/** Exchange Client-ID + Client-Secret for a Twitch app access token. */
async function getAppToken(clientId: string, clientSecret: string, tool: string): Promise<string> {
  const res = await pwFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }).toString(),
  });
  if (!res.ok) {
    const text = summarizeErrorBody(await res.text());
    throw new Error(`${tool}: Twitch refused the credentials IGDB needs (HTTP ${res.status}). ${text} Check the CLIENT_ID:CLIENT_SECRET pair at https://dev.twitch.tv/console.`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error(`${tool}: Twitch returned no access_token for those credentials.`);
  return data.access_token;
}

interface Creds { clientId: string; clientSecret: string }

/** The refusal a keyless caller meets. It must say "requires an API key" —
 *  quality books a refusal that does not as an outage rather than a gate. */
function requireCreds(raw: string | undefined, tool: string): Creds {
  const [clientId, clientSecret] = String(raw ?? '').split(':');
  if (!clientId || !clientSecret) {
    throw new Error(
      `${tool} requires an API key: IGDB is gated by Twitch OAuth and every /v4 endpoint refuses without one. Pass _apiKey as "CLIENT_ID:CLIENT_SECRET"; credentials are issued free by Twitch at https://dev.twitch.tv/console.`,
    );
  }
  return { clientId, clientSecret };
}

async function apicalypse(endpoint: string, body: string, creds: Creds, tool: string): Promise<any[]> {
  const token = await getAppToken(creds.clientId, creds.clientSecret, tool);
  const res = await pwFetch(`${BASE}/${endpoint}`, {
    method: 'POST',
    headers: { 'Client-ID': creds.clientId, Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain', Accept: 'application/json' },
    body,
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw new Error(`${tool} requires an API key IGDB accepts (HTTP ${res.status}). ${summarizeErrorBody(text)} Issue Twitch app credentials at https://dev.twitch.tv/console and pass them as _apiKey in the form "CLIENT_ID:CLIENT_SECRET".`);
  }
  if (!res.ok) {
    throw new Error(`${tool}: IGDB returned HTTP ${res.status}. ${summarizeErrorBody(text)}`);
  }
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    throw new Error(`${tool}: IGDB returned a non-JSON body (${summarizeErrorBody(text)}).`);
  }
}

function iso(epochSeconds: unknown): string | null {
  const n = Number(epochSeconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString().slice(0, 10) : null;
}

function names(v: any): string[] {
  return Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : x?.name)).filter(Boolean) : [];
}

/** IGDB image ids become URLs through a fixed CDN path with a size token. */
function imageUrl(imageId: unknown, size = 't_cover_big'): string | null {
  return typeof imageId === 'string' && imageId ? `https://images.igdb.com/igdb/image/upload/${size}/${imageId}.jpg` : null;
}

/** Escape a user string for an Apicalypse double-quoted literal. */
function q(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}

function clamp(v: unknown, def: number, min: number, max: number): number {
  return Math.min(Math.max(Number(v ?? def) || def, min), max);
}

const GAME_FIELDS =
  'name,slug,summary,storyline,first_release_date,rating,rating_count,aggregated_rating,aggregated_rating_count,category,status,url,cover.image_id,genres.name,themes.name,platforms.name,platforms.abbreviation,game_modes.name,player_perspectives.name,franchises.name,involved_companies.company.name,involved_companies.developer,involved_companies.publisher';

function shapeGame(g: any) {
  const involved = Array.isArray(g.involved_companies) ? g.involved_companies : [];
  return {
    id: g.id ?? null,
    name: g.name ?? null,
    slug: g.slug ?? null,
    first_release_date: iso(g.first_release_date),
    summary: g.summary ?? null,
    storyline: g.storyline ?? null,
    critic_rating: g.aggregated_rating ?? null,
    critic_rating_count: g.aggregated_rating_count ?? null,
    user_rating: g.rating ?? null,
    user_rating_count: g.rating_count ?? null,
    genres: names(g.genres),
    themes: names(g.themes),
    platforms: names(g.platforms),
    game_modes: names(g.game_modes),
    player_perspectives: names(g.player_perspectives),
    franchises: names(g.franchises),
    developers: involved.filter((c: any) => c?.developer).map((c: any) => c?.company?.name).filter(Boolean),
    publishers: involved.filter((c: any) => c?.publisher).map((c: any) => c?.company?.name).filter(Boolean),
    cover_url: imageUrl(g.cover?.image_id),
    igdb_url: g.url ?? (g.slug ? `https://www.igdb.com/games/${g.slug}` : null),
  };
}

// ── Tool implementations ────────────────────────────────────────────────

async function searchGames(args: Record<string, unknown>, creds: Creds) {
  const query = String(args.query ?? '').trim();
  if (!query) throw new Error('igdb_search_games requires `query` — a game title or part of one, e.g. "Breath of the Wild".');
  const limit = clamp(args.limit, 10, 1, 50);

  const clauses = [`fields ${GAME_FIELDS};`, `search "${q(query)}";`];
  const where: string[] = [];
  const platform = args.platform_id !== undefined ? Number(args.platform_id) : null;
  if (platform && Number.isFinite(platform)) where.push(`platforms = (${platform})`);
  const from = String(args.released_after ?? '').trim();
  if (from) {
    const t = Date.parse(`${from}T00:00:00Z`);
    if (Number.isNaN(t)) throw new Error(`igdb_search_games: \`released_after\` must be YYYY-MM-DD. Got "${from}".`);
    where.push(`first_release_date > ${Math.floor(t / 1000)}`);
  }
  if (where.length) clauses.push(`where ${where.join(' & ')};`);
  clauses.push(`limit ${limit};`);

  const rows = await apicalypse('games', clauses.join(' '), creds, 'igdb_search_games');
  return {
    query,
    match_count: rows.length,
    games: rows.map(shapeGame),
    note: rows.length === 0
      ? 'IGDB matched no game. Its search is relevance-based over the catalogued title — try the title as published, without a subtitle or platform suffix.'
      : undefined,
    source: SOURCE,
  };
}

async function game(args: Record<string, unknown>, creds: Creds) {
  const id = args.id !== undefined && args.id !== null && String(args.id).trim() !== '' ? Number(args.id) : null;
  const slug = String(args.slug ?? '').trim();
  if ((id === null || !Number.isFinite(id)) && !slug) {
    throw new Error('igdb_game requires `id` (a numeric IGDB game id) or `slug` (e.g. "the-legend-of-zelda-breath-of-the-wild"). Find either with igdb_search_games.');
  }
  const selector = id !== null && Number.isFinite(id) ? `where id = ${id};` : `where slug = "${q(slug)}";`;
  const body = `fields ${GAME_FIELDS},dlcs.name,expansions.name,similar_games.name,release_dates.human,release_dates.platform.name,release_dates.region; ${selector} limit 1;`;
  const rows = await apicalypse('games', body, creds, 'igdb_game');
  if (rows.length === 0) {
    return { found: false, id, slug: slug || null, note: 'No IGDB game with that id or slug.', source: SOURCE };
  }
  const g = rows[0];
  return {
    found: true,
    game: {
      ...shapeGame(g),
      dlcs: names(g.dlcs),
      expansions: names(g.expansions),
      similar_games: names(g.similar_games),
      release_dates: (Array.isArray(g.release_dates) ? g.release_dates : []).map((r: any) => ({
        platform: r?.platform?.name ?? null,
        date: r?.human ?? null,
        region_code: r?.region ?? null,
      })),
    },
    source: SOURCE,
  };
}

async function companies(args: Record<string, unknown>, creds: Creds) {
  const query = String(args.query ?? '').trim();
  if (!query) throw new Error('igdb_companies requires `query` — a games company name or part of one, e.g. "Nintendo".');
  const limit = clamp(args.limit, 10, 1, 50);
  const body = `fields name,slug,description,country,start_date,url,logo.image_id,published.name,developed.name; search "${q(query)}"; limit ${limit};`;
  const rows = await apicalypse('companies', body, creds, 'igdb_companies');
  return {
    query,
    match_count: rows.length,
    companies: rows.map((c: any) => ({
      id: c.id ?? null,
      name: c.name ?? null,
      slug: c.slug ?? null,
      country_code: c.country ?? null,
      founded: iso(c.start_date),
      description: c.description ?? null,
      logo_url: imageUrl(c.logo?.image_id, 't_logo_med'),
      developed_count: Array.isArray(c.developed) ? c.developed.length : 0,
      published_count: Array.isArray(c.published) ? c.published.length : 0,
      developed_sample: names(c.developed).slice(0, 10),
      published_sample: names(c.published).slice(0, 10),
      igdb_url: c.url ?? null,
    })),
    note: rows.length === 0 ? 'IGDB matched no company by that name.' : 'country_code is an ISO 3166-1 numeric code, as IGDB publishes it.',
    source: SOURCE,
  };
}

async function platforms(args: Record<string, unknown>, creds: Creds) {
  const query = String(args.query ?? '').trim();
  const limit = clamp(args.limit, 50, 1, 200);
  const clauses = ['fields name,abbreviation,alternative_name,slug,generation,category,platform_family.name,url;'];
  // A where-filter rather than `search`, so the list can be sorted by name;
  // IGDB refuses `sort` in the same query as `search`.
  if (query) clauses.push(`where name ~ *"${q(query)}"*;`);
  clauses.push('sort name asc;', `limit ${limit};`);
  const rows = await apicalypse('platforms', clauses.join(' '), creds, 'igdb_platforms');
  return {
    query: query || null,
    match_count: rows.length,
    platforms: rows.map((p: any) => ({
      id: p.id ?? null,
      name: p.name ?? null,
      abbreviation: p.abbreviation ?? null,
      alternative_name: p.alternative_name ?? null,
      slug: p.slug ?? null,
      generation: p.generation ?? null,
      family: p.platform_family?.name ?? null,
      igdb_url: p.url ?? null,
    })),
    note: 'Pass a platform id to igdb_search_games({ platform_id }) to restrict a search to one console or store.',
    source: SOURCE,
  };
}

// ── Tool definitions ────────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'igdb_search_games',
    description:
      'Search the Internet Game Database (IGDB) for video games by title and get back real catalogue records: release date, summary, genres, themes, platforms, game modes, critic and user ratings, developer, publisher and cover art. Optionally restrict to one platform or to games released after a date. AUTHORITATIVE for video-game metadata — the same catalogue Twitch categorises streams against. Example: igdb_search_games({ query: "Breath of the Wild", limit: 5 }).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Game title or part of one, e.g. "Breath of the Wild".' },
        platform_id: { type: 'number', description: 'Restrict to one IGDB platform id — find it with igdb_platforms.' },
        released_after: { type: 'string', description: 'Only games first released after this date, YYYY-MM-DD.' },
        limit: { type: 'number', description: 'Max games to return, 1-50. Default 10.' },
        _apiKey: { type: 'string', description: KEY_DESC },
      },
      required: ['query'],
    },
  },
  {
    name: 'igdb_game',
    description:
      'One video game in full from IGDB, by numeric id or slug: summary and storyline, per-platform release dates and regions, genres, themes, game modes, player perspectives, franchise, developer and publisher, critic and user ratings, DLC, expansions, similar games and cover art. Use after igdb_search_games. Example: igdb_game({ slug: "the-legend-of-zelda-breath-of-the-wild" }).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Numeric IGDB game id.' },
        slug: { type: 'string', description: 'IGDB slug, e.g. "the-legend-of-zelda-breath-of-the-wild".' },
        _apiKey: { type: 'string', description: KEY_DESC },
      },
    },
  },
  {
    name: 'igdb_companies',
    description:
      'Find video-game companies in IGDB by name — developers, publishers, studios — with country, founding date, description, logo, and how many games each developed and published, with a sample of titles. Answers "who made this" and "what else has this studio shipped". Example: igdb_companies({ query: "Nintendo" }).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Company name or part of one, e.g. "Nintendo", "FromSoftware".' },
        limit: { type: 'number', description: 'Max companies to return, 1-50. Default 10.' },
        _apiKey: { type: 'string', description: KEY_DESC },
      },
      required: ['query'],
    },
  },
  {
    name: 'igdb_platforms',
    description:
      'List or search the ~200 gaming platforms IGDB tracks — consoles, handhelds, computers, arcade systems and digital storefronts — with abbreviation, hardware generation and platform family. Its ids are what igdb_search_games({ platform_id }) filters on. Example: igdb_platforms({ query: "PlayStation" }).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Substring of the platform name, e.g. "PlayStation". Omit to list platforms alphabetically.' },
        limit: { type: 'number', description: 'Max platforms to return, 1-200. Default 50.' },
        _apiKey: { type: 'string', description: KEY_DESC },
      },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const raw = args._apiKey as string | undefined;
  delete args._apiKey;
  const creds = requireCreds(raw, name);

  switch (name) {
    case 'igdb_search_games':
      return searchGames(args, creds);
    case 'igdb_game':
      return game(args, creds);
    case 'igdb_companies':
      return companies(args, creds);
    case 'igdb_platforms':
      return platforms(args, creds);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export { tools, callTool };
export default {
  tools,
  callTool,
  meter: { credits: 1 },
  provider: 'IGDB (Internet Game Database, Twitch)',
} satisfies McpToolExport;

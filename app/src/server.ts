import express from "express";
import { dax, ddb } from "./dax";
import { TABLE_NAME, CATEGORY_INDEX, PORT, DAX_ENDPOINT, HIT_THRESHOLD_MS } from "./config";

const app = express();
app.use(express.json());

// --- Helpers ---------------------------------------------------------------
// The three DynamoDB calls this demo makes. Each takes the client to use, so a
// route reads clearly as dax() (through the cache) or ddb (straight to DynamoDB).

type Db = typeof ddb; // aws-sdk v2 DocumentClient: dax() (cached) or ddb (direct)

const getProduct = (db: Db, id: string) =>
  db.get({ TableName: TABLE_NAME, Key: { id } }).promise();

const queryCategory = (db: Db, category: string) =>
  db
    .query({
      TableName: TABLE_NAME,
      IndexName: CATEGORY_INDEX,
      KeyConditionExpression: "category = :c",
      ExpressionAttributeValues: { ":c": category },
    })
    .promise();

const setPrice = (db: Db, id: string, price: number) =>
  db
    .update({
      TableName: TABLE_NAME,
      Key: { id },
      UpdateExpression: "SET price = :p",
      ExpressionAttributeValues: { ":p": price },
    })
    .promise();

/** Run a call and return how long it took, in ms. */
async function timed<T>(call: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = process.hrtime.bigint();
  const result = await call();
  return { result, ms: Number(process.hrtime.bigint() - start) / 1e6 };
}

/** DAX has no hit/miss flag — infer it from latency (HIT_THRESHOLD_MS). */
const verdict = (ms: number): string =>
  ms <= HIT_THRESHOLD_MS ? "cache HIT" : "likely MISS → DynamoDB";

/** Forward async errors to the handler below (Express 4 won't on its own). */
const route =
  (handler: (req: express.Request, res: express.Response) => Promise<unknown>): express.RequestHandler =>
  (req, res, next): void => {
    handler(req, res).catch(next);
  };

// --- Routes — one per cache behavior, one log line each --------------------

app.get("/health", (_req, res) => {
  res.json({ ok: true, table: TABLE_NAME, daxEndpoint: DAX_ENDPOINT || "(not set)" });
});

// 1) ITEM CACHE — read through DAX. ?compare=1 also reads straight from
//    DynamoDB so you can see the cached-vs-direct latency gap.
app.get(
  "/products/:id",
  route(async (req, res) => {
    const { id } = req.params;

    const { result, ms } = await timed(() => getProduct(dax(), id));
    const value = result.Item ? `= $${result.Item.price}` : "(not found)";
    console.log(`GET /products/${id} — ${verdict(ms)} (${ms.toFixed(1)}ms) ${value}`);

    if (req.query.compare) {
      const { ms: directMs } = await timed(() => getProduct(ddb, id));
      console.log(`GET /products/${id} — direct DynamoDB ${directMs.toFixed(1)}ms (no cache)`);
    }

    if (!result.Item) return res.status(404).json({ error: "not found" });
    res.json(result.Item);
  }),
);

// 2) QUERY CACHE — query a category through DAX. DAX caches the whole result
//    set under the query, so an identical repeat is a query-cache hit.
app.get(
  "/products",
  route(async (req, res) => {
    const category = String(req.query.category ?? "electronics");

    const { result, ms } = await timed(() => queryCategory(dax(), category));
    const count = result.Items?.length ?? 0;
    console.log(`GET /products?category=${category} — ${verdict(ms)} (${ms.toFixed(1)}ms), ${count} items`);
    res.json(result.Items ?? []);
  }),
);

// 3) WRITE-THROUGH — update through DAX: it writes to DynamoDB first, then
//    refreshes its cached copy, so the read-after-write is served from cache.
app.put(
  "/products/:id",
  route(async (req, res) => {
    const { id } = req.params;
    const price = Number(req.body?.price);

    const { ms: writeMs } = await timed(() => setPrice(dax(), id, price));
    const { result, ms } = await timed(() => getProduct(dax(), id));
    console.log(
      `PUT /products/${id} — wrote $${price} via DAX (${writeMs.toFixed(1)}ms), read-after-write ${verdict(ms)} (${ms.toFixed(1)}ms)`,
    );
    res.json(result.Item);
  }),
);

// 4) OUT-OF-BAND WRITE — update DynamoDB DIRECTLY, bypassing DAX. DAX never
//    hears about it, so reads stay stale until the cache entry's TTL expires
//    (60s in this demo's cluster). The cold-open bug.
app.post(
  "/products/:id/direct-write",
  route(async (req, res) => {
    const { id } = req.params;
    const price = Number(req.body?.price);

    await setPrice(ddb, id, price);
    console.log(`POST /products/${id}/direct-write — wrote $${price} direct to DynamoDB, DAX cache now stale until TTL`);
    res.json({ id, dynamoDbPrice: price, note: "DAX cache is stale until TTL" });
  }),
);

// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err.message);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`DAX demo API on http://localhost:${PORT} — table ${TABLE_NAME}, dax ${DAX_ENDPOINT || "(not set)"}`);
});

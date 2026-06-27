import express from "express";
import { dax, ddb } from "./dax";
import { TABLE_NAME, CATEGORY_INDEX, PORT, DAX_ENDPOINT } from "./config";
import * as log from "./log";

const app = express();
app.use(express.json());

/** Elapsed milliseconds since an hrtime.bigint() mark. */
const since = (start: bigint): number => Number(process.hrtime.bigint() - start) / 1e6;

app.get("/health", (_req, res) => {
  res.json({ ok: true, table: TABLE_NAME, daxEndpoint: DAX_ENDPOINT || "(not set)" });
});

// ---------------------------------------------------------------------------
// 1) ITEM CACHE — GetItem through DAX. Add ?compare=1 to also time a direct,
//    uncached DynamoDB read of the same key (side-by-side latency baseline).
// ---------------------------------------------------------------------------
app.get("/products/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    log.request("GET", `/products/${id}`);

    const t = process.hrtime.bigint();
    const out = await dax().get({ TableName: TABLE_NAME, Key: { id } }).promise();
    log.daxRead("GetItem", since(t));

    if (req.query.compare) {
      const t2 = process.hrtime.bigint();
      await ddb.get({ TableName: TABLE_NAME, Key: { id } }).promise();
      log.directRead("GetItem", since(t2));
    }

    if (!out.Item) {
      log.warn("not found");
      return res.status(404).json({ error: "not found" });
    }
    log.ok(`${id} = $${out.Item.price}`);
    res.json(out.Item);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// 2) QUERY CACHE — Query a category through DAX (on the GSI). The whole result
//    set is filed under the question; a repeat is a query-cache HIT.
// ---------------------------------------------------------------------------
app.get("/products", async (req, res, next) => {
  try {
    const category = String(req.query.category ?? "electronics");
    log.request("GET", `/products?category=${category}`);

    const t = process.hrtime.bigint();
    const out = await dax()
      .query({
        TableName: TABLE_NAME,
        IndexName: CATEGORY_INDEX,
        KeyConditionExpression: "category = :c",
        ExpressionAttributeValues: { ":c": category },
      })
      .promise();
    log.daxRead("Query", since(t));
    log.ok(`${out.Items?.length ?? 0} items`);
    res.json(out.Items ?? []);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// 3) WRITE-THROUGH — PUT through DAX: it writes to DynamoDB FIRST, then refiles
//    the item card. The very next read is served from that fresh card
//    (read-after-write), no trip to the table.
// ---------------------------------------------------------------------------
app.put("/products/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    const price = Number(req.body?.price);
    log.request("PUT", `/products/${id}`);
    log.step(`write-through via DAX (table first, then cache): price → $${price}`);

    const t = process.hrtime.bigint();
    await dax()
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression: "SET price = :p",
        ExpressionAttributeValues: { ":p": price },
      })
      .promise();
    log.ok(`${since(t).toFixed(1)}ms — DynamoDB updated AND the item card refiled`);

    // read-after-write, straight from the card
    const t2 = process.hrtime.bigint();
    const out = await dax().get({ TableName: TABLE_NAME, Key: { id } }).promise();
    const result = log.daxRead("read-after-write GetItem", since(t2));
    log.step(
      `reader sees its own write immediately${result === "HIT" ? " (from cache)" : ""}: $${out.Item?.price}`,
    );
    res.json(out.Item);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// 4) OUT-OF-BAND DIVERGENCE — write DIRECTLY to DynamoDB, bypassing DAX. DAX is
//    never told, so the item cache keeps serving the OLD value until its TTL
//    expires. This is the cold-open bug: GET /products/:id stays stale for the
//    TTL window even though DynamoDB already changed.
// ---------------------------------------------------------------------------
app.post("/products/:id/direct-write", async (req, res, next) => {
  try {
    const id = req.params.id;
    const price = Number(req.body?.price);
    log.request("POST", `/products/${id}/direct-write`);
    log.step(`writing DIRECTLY to DynamoDB (bypassing DAX): price → $${price}`);

    await ddb
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression: "SET price = :p",
        ExpressionAttributeValues: { ":p": price },
      })
      .promise();

    log.warn("DAX was NOT notified — the item cache is now stale until its TTL expires");
    log.step(
      `GET /products/${id} will keep returning the OLD price until TTL (default 5 min; ` +
        `60s in this demo's cluster). That gap is the cold-open bug.`,
    );
    res.json({ id, dynamoDbPrice: price, note: "DAX cache is stale until TTL" });
  } catch (err) {
    next(err);
  }
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log.warn(err?.message ?? String(err));
  res.status(500).json({ error: err?.message ?? "error" });
});

app.listen(PORT, () => {
  log.banner([
    "DynamoDB + DAX demo API",
    `listening on http://localhost:${PORT}`,
    `table: ${TABLE_NAME}`,
    `dax:   ${DAX_ENDPOINT || "(DAX_ENDPOINT not set — DAX routes will error)"}`,
  ]);
});

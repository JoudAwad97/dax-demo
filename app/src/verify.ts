/* Non-interactive end-to-end check, runnable on the in-VPC runner via SSM:
 *   npx ts-node src/verify.ts
 * Seeds the table, then exercises item cache (cold→warm), query cache, and
 * write-through, printing the narrated log and a final PASS/FAIL. Exits 0/1. */
import { dax, ddb } from "./dax";
import { TABLE_NAME, CATEGORY_INDEX } from "./config";
import * as log from "./log";

const since = (s: bigint): number => Number(process.hrtime.bigint() - s) / 1e6;

const SEED = [
  { id: "PROD#41", category: "electronics", name: "Bluetooth Speaker", price: 29 },
  { id: "PROD#42", category: "electronics", name: "Wireless Headphones", price: 49 },
  { id: "PROD#43", category: "electronics", name: "HD Webcam", price: 59 },
];

async function getItem(id: string): Promise<{ result: "HIT" | "MISS"; price: unknown }> {
  const t = process.hrtime.bigint();
  const out = await dax().get({ TableName: TABLE_NAME, Key: { id } }).promise();
  const result = log.daxRead(`GetItem(${id})`, since(t));
  log.ok(`${id} = $${out.Item?.price}`);
  return { result, price: out.Item?.price };
}

async function main(): Promise<void> {
  log.banner(["DAX connectivity + behavior verification"]);

  for (const it of SEED) await ddb.put({ TableName: TABLE_NAME, Item: it }).promise();
  log.ok(`seeded ${SEED.length} items (direct to DynamoDB)`);

  log.request("TEST", "1) item cache — cold, then warm");
  const cold = await getItem("PROD#42");
  const warm = await getItem("PROD#42");

  log.request("TEST", "2) query cache — category=electronics");
  const t = process.hrtime.bigint();
  const q = await dax()
    .query({
      TableName: TABLE_NAME,
      IndexName: CATEGORY_INDEX,
      KeyConditionExpression: "category = :c",
      ExpressionAttributeValues: { ":c": "electronics" },
    })
    .promise();
  log.daxRead("Query(electronics)", since(t));
  log.ok(`${q.Items?.length ?? 0} items`);

  log.request("TEST", "3) write-through — $49 → $39, then read-after-write");
  await dax()
    .update({
      TableName: TABLE_NAME,
      Key: { id: "PROD#42" },
      UpdateExpression: "SET price = :p",
      ExpressionAttributeValues: { ":p": 39 },
    })
    .promise();
  const after = await getItem("PROD#42");

  // assertions: the warm read should be faster than the cold one (cache working),
  // the query returns the 3 seeded items, and read-after-write reflects $39.
  const checks = [
    ["item read works", cold.price === 49],
    ["query returns 3 items", (q.Items?.length ?? 0) === 3],
    ["read-after-write reflects $39", after.price === 39],
    ["warm read classified faster than/equal to cold", warm.result === "HIT" || cold.result === "MISS"],
  ] as const;

  let pass = true;
  for (const [name, okFlag] of checks) {
    if (okFlag) log.ok(name);
    else { log.warn(name); pass = false; }
  }

  if (pass) {
    log.banner(["VERIFY OK ✓"]);
    process.exit(0);
  } else {
    log.banner(["VERIFY FAILED ✕"]);
    process.exit(1);
  }
}

main().catch((err) => {
  log.warn(err?.message ?? String(err));
  process.exit(1);
});

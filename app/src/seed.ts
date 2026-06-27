import { ddb } from "./dax";
import { TABLE_NAME } from "./config";
import * as log from "./log";

// The product-catalog anchor from the video. PROD#42 starts at $49 so the
// write-through demo can drop it to $39.
const ITEMS = [
  { id: "PROD#41", category: "electronics", name: "Bluetooth Speaker", price: 29 },
  { id: "PROD#42", category: "electronics", name: "Wireless Headphones", price: 49 },
  { id: "PROD#43", category: "electronics", name: "HD Webcam", price: 59 },
];

async function main(): Promise<void> {
  log.banner([`Seeding ${TABLE_NAME} (direct to DynamoDB, bypassing DAX)…`]);
  for (const item of ITEMS) {
    await ddb.put({ TableName: TABLE_NAME, Item: item }).promise();
    log.ok(`${item.id}  ${item.name.padEnd(20)} $${item.price}`);
  }
  log.banner([`Done — ${ITEMS.length} items in ${TABLE_NAME}.`]);
}

main().catch((err) => {
  log.warn(err?.message ?? String(err));
  process.exit(1);
});

import { ddb } from "./dax";
import { TABLE_NAME } from "./config";

// The product-catalog anchor from the video. PROD#42 starts at $49 so the
// write-through demo can drop it to $39.
const ITEMS = [
  { id: "PROD#41", category: "electronics", name: "Bluetooth Speaker", price: 29 },
  { id: "PROD#42", category: "electronics", name: "Wireless Headphones", price: 49 },
  { id: "PROD#43", category: "electronics", name: "HD Webcam", price: 59 },
];

async function main(): Promise<void> {
  console.log(`\nSeeding ${TABLE_NAME} (direct to DynamoDB, bypassing DAX)…\n`);
  for (const item of ITEMS) {
    await ddb.put({ TableName: TABLE_NAME, Item: item }).promise();
    console.log(`  ✓ ${item.id}  ${item.name.padEnd(20)} $${item.price}`);
  }
  console.log(`\nDone — ${ITEMS.length} items in ${TABLE_NAME}.\n`);
}

main().catch((err) => {
  console.error(err?.message ?? String(err));
  process.exit(1);
});

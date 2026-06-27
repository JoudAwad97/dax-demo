# DynamoDB + DAX — a tiny REST demo

A small Express (TypeScript) REST API that talks to **DynamoDB** through the
official **`amazon-dax-client`**, so you can *see* how DAX behaves: item-cache
and query-cache reads, write-through, read-after-write, and the out-of-band
staleness bug from the cold open.

Every request prints a narrated line to the console — operation, where it was
served (DAX cache vs DynamoDB, inferred from latency), and how long it took.

```
GET /products/PROD#42 — likely MISS → DynamoDB (8.2ms) = $49
GET /products/PROD#42 — cache HIT (0.4ms) = $49
```

> **Why there's no `docker compose up`:** DAX has **no local emulator**. The
> client speaks a binary protocol to a real cluster that only lives inside a
> VPC. So this demo runs **in AWS**. The CDK stack below stands the whole thing
> up; the runner EC2 instance sits in the VPC and reaches the cluster.

> **SDK note:** the Node DAX client follows the **AWS SDK v2** `DocumentClient`
> interface (there is no first-class SDK v3 data-plane DAX client), so data
> calls use `aws-sdk` v2 + `amazon-dax-client`. Everything else is modern TS.

---

## What it demonstrates

| Endpoint | Behavior |
| --- | --- |
| `GET /products/:id` | **Item cache** — `GetItem` through DAX. Add `?compare=1` to also time a direct, uncached DynamoDB read. |
| `GET /products?category=electronics` | **Query cache** — `Query` on the `category-index` GSI; the whole result set is cached under the question. |
| `PUT /products/:id` `{ "price": 39 }` | **Write-through + read-after-write** — DAX writes to the table first, then refiles the item card; the next read is served from it. |
| `POST /products/:id/direct-write` `{ "price": 39 }` | **Out-of-band divergence** — writes *directly* to DynamoDB, bypassing DAX, so the cache stays stale until TTL. The cold-open bug. |

Seed data (the video's anchor): `PROD#41` Speaker `$29`, `PROD#42` Headphones
`$49`, `PROD#43` Webcam `$59` — all `category = electronics`.

The demo cluster sets both DAX TTLs to **60s** (`record-ttl-millis` /
`query-ttl-millis`) so the staleness window is short enough to film. The AWS
default is **300000 ms (5 minutes)**.

---

## Quick path — CDK (recommended for viewers)

**Prerequisites:** Node 18+, an AWS account, credentials configured
(`aws configure`), and the AWS CDK (`npm i -g aws-cdk`). A `dax.t3.small` node
costs ~$0.04/hr and the cluster takes ~5–10 min to create.

```bash
cd dax-demo/infra
npm install
cdk bootstrap          # once per account/region
cdk deploy             # ~10 min (DAX cluster is the slow part)
```

Copy the outputs (`DaxEndpoint`, `TableName`, `RunnerInstanceId`, `SsmConnect`).
The runner already has the app at `/opt/dax-demo` with a populated `.env`.

```bash
# open a shell on the runner (Session Manager — no SSH key needed)
aws ssm start-session --target <RunnerInstanceId>

# on the runner:
cd /opt/dax-demo
npm run seed           # writes the 3 products to DynamoDB
npm start              # starts the API on :3000 (leave running)
```

Open a **second** SSM session to drive it (or run the curls inline):

```bash
curl localhost:3000/products/PROD%2342            # cold → MISS
curl localhost:3000/products/PROD%2342            # warm → HIT
```

Watch the **`npm start`** terminal for the narrated log.

**Tear down** (stops the DAX charges):

```bash
cd dax-demo/infra && cdk destroy
```

---

## Manual path — AWS Console (the on-camera walkthrough)

If you'd rather build it by hand on screen, here's the same stack click-by-click.

1. **VPC** → create a VPC with 2 AZs, public + private subnets (the "VPC and
   more" wizard is fine), 1 NAT gateway.
2. **DynamoDB** → create table `ProductCatalog`, partition key `id` (String),
   on-demand. Add a **GSI** `category-index` with partition key `category`
   (String).
3. **DAX → Subnet groups** → create `dax-demo-subnets` over the VPC's **private**
   subnets.
4. **DAX → Parameter groups** → create `dax-demo-params`; set
   `record-ttl-millis = 60000` and `query-ttl-millis = 60000` (so staleness is
   visible — default is 300000).
5. **IAM** → create a role trusted by `dax.amazonaws.com` with read/write on the
   `ProductCatalog` table.
6. **DAX → Clusters** → create cluster `dax-demo`, node type `dax.t3.small`,
   1 node, the IAM role above, the subnet group, the parameter group, a security
   group, **encryption: none**. Note the **cluster discovery endpoint**.
7. **EC2** → launch a `t3.micro` (Amazon Linux 2023) **in the VPC**, attach an
   instance role with **AmazonSSMManagedInstanceCore** + DynamoDB access +
   `dax:*` on the cluster. Allow the EC2's security group **inbound 8111** on the
   DAX security group.
8. On the box: install Node, copy this `app/` folder over, create `.env` (see
   `app/.env.example`) with the cluster endpoint, then `npm install`,
   `npm run seed`, `npm start`.

---

## The four scenarios (curl)

Run these against the API and narrate the `npm start` console output.

```bash
# 1) ITEM CACHE — cold miss, then warm hit, then a latency comparison
curl localhost:3000/products/PROD%2342
curl localhost:3000/products/PROD%2342
curl "localhost:3000/products/PROD%2342?compare=1"

# 2) QUERY CACHE — the category listing (whole result set cached)
curl "localhost:3000/products?category=electronics"
curl "localhost:3000/products?category=electronics"

# 3) WRITE-THROUGH — drop the price to $39; the read-after-write is fresh
curl -X PUT localhost:3000/products/PROD%2342 \
  -H 'content-type: application/json' -d '{"price":39}'
curl localhost:3000/products/PROD%2342            # $39, served from the card

# 4) OUT-OF-BAND DIVERGENCE — write straight to DynamoDB, bypassing DAX
curl -X POST localhost:3000/products/PROD%2342/direct-write \
  -H 'content-type: application/json' -d '{"price":19}'
curl localhost:3000/products/PROD%2342            # still the OLD price…
#   …wait ~60s for the TTL, then:
curl localhost:3000/products/PROD%2342            # now $19 — it "healed"
```

> `PROD%2342` is `PROD#42` URL-encoded (`#` → `%23`).

---

## How HIT/MISS is determined

DAX does **not** return a hit/miss flag. The narrated log infers it from
latency: a cache hit is typically sub-millisecond, a miss (DAX → DynamoDB) is
several ms. The threshold is `HIT_THRESHOLD_MS` (default `2`). `?compare=1`
times a direct DynamoDB read alongside so you can see the gap for real.

## Layout

Three small files in `app/src` (plus config and the CDK in `infra/`):

```
dax-demo/
  app/src/
    config.ts   # env config: table, GSI, DAX endpoint, port, hit threshold
    dax.ts      # the two clients — dax() (through the cache) and ddb (direct)
    server.ts   # small DAX/DynamoDB helpers, then the 4 routes; logs to console
    seed.ts     # writes the 3 demo products
  infra/
    lib/dax-demo-stack.ts   # CDK: VPC + DAX cluster + DynamoDB + EC2 runner
```

`server.ts` reads top to bottom: a few named helpers (`getProduct`,
`queryCategory`, `setPrice` — each takes `dax()` or `ddb`, so every route shows
whether it goes through the cache), then one route per behavior.

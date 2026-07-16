# Use cases for testing the MCP (Design → Deploy flow)

5 complete architectures to exercise the `sigilum-mcp` server end to end, plus a
section of standalone prompts to test the remaining tools.

## How to use this doc

**Requirements**
- The web server running locally (`http://127.0.0.1:3001`).
- The MCP connected in your coding agent with the dev token `viz_localdev`
  (`SIGILUM_URL=http://127.0.0.1:3001`, `SIGILUM_TOKEN=viz_localdev`). See the README.
- Open the web app → pick the sigil in the top-bar selector to watch the
  diagram update live after each push.

**The two-step flow (design-first → deploy)**
1. **Design.** Paste a case's *Prompt 1*. The agent calls `push_sigil` **without**
   `deployed` → a **Design** diagram is created: the architecture is drawn but **nothing is
   created in AWS**. You can iterate (add/remove things) and it stays a Design.
2. **Deploy.** When you're happy with it, paste *Prompt 2*. The agent calls `deploy_sigil`
   (the backend marks the diagram **Live** and returns the list of resources to create),
   provisions each one in AWS with its own tools, and reports the **real ids/ARNs** back via
   `push_sigil` (`op: "upsert"`, same `id` as in the design).

> Remember: a diagram is either **Design** or **Live**, never mixed. Once it's deployed,
> anything new you add is treated as deployed too.

Each case has two copy-paste blocks: **Prompt 1 (Design)** and **Prompt 2 (Deploy)**.

---

## Case 4 — Event-driven order processing

API Gateway → Lambda (API) → SQS → Lambda (worker) → DynamoDB, with SNS to notify by
email/SMS when the order completes. *(serverless, event-driven)*

**Prompt 1 (Design)**
```
I want to design a serverless order-processing architecture on AWS. The idea: an HTTP API
Gateway receives order-creation requests and hands them to a Lambda function "orders-api",
which validates the order and enqueues it in an SQS queue. A second Lambda "orders-worker"
consumes from the queue, processes the order, and stores it in a DynamoDB table "orders".
When it finishes, it publishes an event to an SNS topic that notifies the customer by email
and SMS. Design it and show it in the diagram, but do NOT deploy anything to AWS yet — I
want to review it first.
```

**Prompt 2 (Deploy)**
```
Great, the design works for me. Now actually deploy it to AWS: create the resources in
dependency order and report the real ids/ARNs back to the diagram as you create them,
keeping the same diagram.
```

---

## Case 5 — Video transcoding pipeline

S3 (uploads) → event → Lambda → MediaConvert → S3 (output) → CloudFront, with metadata in
DynamoDB. *(media, event-driven)*

**Prompt 1 (Design)**
```
Design me an AWS architecture for transcoding videos. Users upload the original video to an
S3 bucket "uploads". The upload triggers a Lambda "transcode-trigger" that launches a
MediaConvert job to generate several resolutions. The results are stored in an S3 bucket
"outputs", which is served through a CloudFront distribution. Each video's metadata (status,
resolutions, duration) is stored in a DynamoDB table "videos". Draw it in the diagram but
don't deploy anything to AWS for now.
```

**Prompt 2 (Deploy)**
```
Perfect, go ahead: deploy this architecture to AWS and update the diagram with the real
resources (buckets, distribution, function, MediaConvert queue, and table) as you create
them.
```

---

## Case 6 — Three-tier web app in a VPC

ALB → EC2 Auto Scaling group (web tier) → RDS Multi-AZ (data) + ElastiCache (sessions), all
inside a VPC with public/private subnets and NAT. *(VPC + EC2, three tiers)*

**Prompt 1 (Design)**
```
I want a classic three-tier web app on AWS inside a VPC. Structure: a VPC 10.0.0.0/16 with
public and private subnets across two availability zones and NAT. An Application Load
Balancer in the public subnets spreads traffic to an Auto Scaling group of EC2 instances
(web tier) in private subnets. Those EC2s use a Multi-AZ RDS PostgreSQL database in the data
subnets, and an ElastiCache Redis cache for sessions. Design it and show it in the diagram
with the VPC and its subnets, but don't deploy anything to AWS yet.
```

**Prompt 2 (Deploy)**
```
OK, deploy it to AWS. Provision in order: first the VPC, subnets, NAT, and security groups;
then RDS and ElastiCache; then the EC2 Auto Scaling group; and finally the ALB. Reflect the
real ids in the same diagram as you go.
```

---

## Case 7 — Machine Learning inference API

Cognito → API Gateway → Lambda → SageMaker endpoint, with the models in S3 and a request log
in DynamoDB. *(serverless + ML)*

**Prompt 1 (Design)**
```
Design an AWS ML-model inference API for me. Clients authenticate with a Cognito user pool
and call an API Gateway, which invokes a Lambda "inference-api". The Lambda calls a SageMaker
endpoint that serves the model (the model artifacts live in an S3 bucket "models"), and logs
each request to a DynamoDB table "inference-logs". Represent it in the diagram but without
creating anything in AWS for now.
```

**Prompt 2 (Deploy)**
```
Perfect. Now deploy the architecture to AWS (models bucket, SageMaker endpoint, the Lambda,
the API Gateway, the Cognito user pool, and the logs table) and update the diagram with the
real resources as you create them.
```

---

## Case 8 — Real-time telemetry ingestion and analytics

Kinesis → Lambda (ingest) → S3 (raw) + DynamoDB (latest values); API Gateway → Lambda
(query) for the dashboard. *(streaming / real-time)*

**Prompt 1 (Design)**
```
I want an AWS architecture to ingest device telemetry in real time. Devices send events to a
Kinesis stream. A Lambda "ingest" consumes them, stores the raw data in an S3 bucket
"telemetry-raw", and updates each device's latest value in a DynamoDB table "device-state".
For the dashboard, an API Gateway invokes a Lambda "query" that reads from DynamoDB. Draw it
in the diagram but don't deploy anything to AWS yet.
```

**Prompt 2 (Deploy)**
```
Great, deploy it to AWS: create the Kinesis stream, the buckets, the two Lambdas, the
DynamoDB table, and the API Gateway, and report the real ids back to the same diagram.
```

---

## Extras for testing the rest of the MCP

Standalone prompts to exercise incremental changes and session resumption (use them on a
diagram already created with the cases above):

- **Modify (delta upsert):**
  ```
  Add an SQS queue "retry-queue" between the API and the worker for retries, and reflect it
  in the diagram.
  ```
- **Delete a resource (op delete):**
  ```
  Remove the ElastiCache Redis cache from the diagram, we're not going to use it anymore.
  ```
- **List diagrams (`list_sigils`):**
  ```
  List my diagrams.
  ```
- **Resume by name (`load_sigil`) and continue:**
  ```
  Resume the "Order processing" diagram and add a second DynamoDB table for the order
  history.
  ```

After each prompt, the corresponding chat's diagram updates in place in the web app (keeping
the layout). The agent only ever reports the **delta**; the backend maintains the full state
and the diagram.

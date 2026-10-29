# WashOps: Interview Study Guide

How to explain this project out loud, honestly and confidently.

**Framing to keep:** *"I'm a full-stack TypeScript developer; AWS was my weakest area, so I built and deployed this to get real hands-on experience."* Everything below is something I actually built, deployed, and verified, unless it's marked:

- **(built, not yet deployed)**: written and unit-tested, but not yet run in AWS. Say exactly that. After deploying and checking it, delete the marker.
- **(future / conceptual)**: not built.

---

## 30-Second Project Explanation

> "WashOps is a small serverless integration service I built on AWS to get hands-on cloud experience. It simulates car wash controllers sending operational events (washes, payments, equipment faults, heartbeats) to an API. API Gateway invokes a Lambda that validates the event, archives the raw payload to S3, puts it on an SQS queue, and returns 202 right away. A second Lambda consumes the queue and writes to DynamoDB idempotently, so duplicate deliveries never double-count revenue. Failed messages retry and land in a dead-letter queue with a CloudWatch alarm. Everything is TypeScript, defined in a SAM template with least-privilege IAM roles, and I deployed it and tested the failure paths in a real AWS account."

**If they ask what I added next (built, not yet deployed):**

> "Then I closed the gaps I'd listed. The API now requires Cognito tokens: client credentials for each site's controller, and a hosted sign-in with PKCE for a small operations dashboard on CloudFront. A scheduled Lambda notices when a site stops sending heartbeats and emails once when it goes offline and once when it's back. Processed events flow from the DynamoDB stream onto an EventBridge bus, so other systems can subscribe; high-severity faults email maintenance. Deploys go through GitHub Actions with OIDC, no stored keys: build once, deploy to a dev stack, run integration tests against the real services, then promote the same build to prod, where CodeDeploy canaries roll back automatically on alarms. Each site's credential is bound to its own location by a scope in the token, and events from controllers with wrong clocks are accepted but flagged. There's also a replay tool and Athena over the S3 archive."

## 2-Minute Architecture Walkthrough

Follow one event through the system:

1. **Controller → API Gateway.** A controller POSTs a `WASH_COMPLETED` event to `/events`. API Gateway (HTTP API) handles TLS, routing, and throttling, then invokes the ingest Lambda with the request as a JSON event.
2. **Ingest Lambda validates.** Zod schemas check the event. Bad input gets a `400` with field-level errors and never touches any AWS resource. It reuses the caller's `x-correlation-id` or generates one, and every log line carries it.
3. **Archive, then enqueue.** It writes the untouched payload to S3 (`raw/date=…/location=…/eventId_correlationId.json`), *then* sends the validated event to SQS. The order guarantees every queued event has an audit record.
4. **Return 202.** "I've durably received it", not "I've processed it". The controller isn't waiting on the database.
5. **SQS → processor Lambda.** Lambda's event source mapping polls the queue and invokes the processor with batches of up to 10.
6. **Idempotent write.** One DynamoDB transaction: put the event record *only if the eventId doesn't exist*, plus increment the location's counters. If it's a duplicate, the transaction cancels and the processor treats that as success.
7. **Failures.** If a message fails, the processor reports just that message ID. SQS makes it visible again after the 60-second visibility timeout. After 3 failed receives it moves to the dead-letter queue and a CloudWatch alarm emails me.
8. **Read side.** A query Lambda behind `GET` routes serves the location summary (a single-item read of pre-computed counters), an event by ID, and recent events via a GSI.
9. **Around it all:** CloudWatch structured logs and alarms, a separate least-privilege IAM role per function, all defined in `template.yaml`, deployed with `sam deploy`, and CI in GitHub Actions.
10. **(Built, not yet deployed.)** Before step 1, API Gateway's JWT authorizer checks a Cognito token and the route's scope, so bad requests never reach a Lambda. After step 6, the DynamoDB stream feeds a publisher Lambda that puts the event on an EventBridge bus; a rule emails HIGH/CRITICAL faults. Separately, every 5 minutes a scheduled Lambda flags sites with no recent heartbeat.

**Numbers I measured:** cold start init was about 430–510 ms; warm processing took about 60–150 ms from API receipt to DynamoDB write; the poison message reached the DLQ after 3 attempts over about 3.5 minutes, and the alarm fired about 2.5 minutes after that.

---

## AWS Services I Personally Used

### API Gateway (HTTP API)
- **What it does:** a managed HTTPS endpoint that routes requests to backends like Lambda.
- **Why I used it:** it's the public front door, with TLS, routing, throttling (25 rps / 50 burst), and access logs, and no servers.
- **Most important lesson:** access logs show both `status` (what the client got) and `integrationStatus` (whether Lambda itself succeeded). That's how you tell an API Gateway/Lambda-invoke problem from your own code returning an error.

### AWS Lambda
- **What it does:** runs a function in response to an event; AWS manages the servers, scaling, and patching.
- **Why I used it:** stateless request/event handlers with bursty traffic and zero idle cost.
- **Most important lesson:** the execution role *is* the credentials. There are no keys in code: the SDK automatically gets temporary credentials from the role. I also saw cold starts in the `REPORT` log line (`Init Duration: 513 ms`).

### Amazon SQS + dead-letter queue
- **What it does:** a durable message queue; consumers receive, process, then delete messages.
- **Why I used it:** it decouples ingestion from processing, so events survive processor outages and bursts.
- **Most important lesson:** a failed message isn't "put back". It just isn't deleted, and reappears when the visibility timeout expires. `maxReceiveCount` decides when SQS gives up and moves it to the DLQ. I watched that happen: receiveCount 1 → 2 → 3, about 60 s apart, then DLQ.

### Amazon S3
- **What it does:** object storage: files (objects) in buckets, addressed by key, extremely durable.
- **Why I used it:** a cheap, permanent audit archive of exactly what each controller sent.
- **Most important lesson:** security is layered: block public access, bucket-owner-enforced ownership, encryption, and a bucket policy that denies non-TLS requests. CloudFormation also can't delete a non-empty bucket, so teardown means emptying it first.

### Amazon DynamoDB
- **What it does:** a serverless key-value/document database with single-digit-millisecond reads by key.
- **Why I used it:** simple access patterns, no connection pooling issues from many Lambdas, pay per request.
- **Most important lesson:** you design the keys around the queries. Conditional writes plus transactions give you idempotency cheaply.

### Amazon CloudWatch (Logs, Metrics, Alarms) + SNS
- **What it does:** collects logs and metrics from AWS services and triggers alarms.
- **Why I used it:** it's the only way to see a distributed system spanning 3 functions and a queue.
- **Most important lesson:** structured JSON logs make Logs Insights powerful. One query over two log groups filtered by `correlationId` rebuilt an event's full journey. Also, metrics for idle queues can lag several minutes, so alarms aren't instant.

### AWS IAM
- **What it does:** controls who can do what to which AWS resource.
- **Why I used it:** a separate role per Lambda, each limited to specific actions on specific ARNs.
- **Most important lesson:** SAM's convenient defaults attach AWS-managed policies with `Resource: "*"`. Writing the roles explicitly is how you actually get least privilege.

### AWS SAM / CloudFormation
- **What it does:** infrastructure as code; SAM is a shorthand layer on CloudFormation for serverless resources.
- **Why I used it:** the whole environment is reviewable, repeatable, and deletable as one stack.
- **Most important lesson:** CloudFormation reads `!Ref`/`!GetAtt` to build a dependency graph (the DLQ was created before the queue that points to it), and changesets show a plan before anything changes.

### Added in the second round (built, not yet deployed)

Say "I built and unit-tested this; I haven't deployed it yet" until it's verified in AWS.

- **Amazon Cognito:** a user pool that issues JWTs. Controllers use the OAuth **client credentials** flow (one app client per site); dashboard users sign in on the hosted page with **authorization code + PKCE**. Scopes `washops/events.write` and `washops/events.read` decide which routes a token can call; a per-site scope (`washops/site.miami-01`) decides which location a controller may send for.
- **Two environments:** the same template deploys as `washops-dev` and `washops` (prod), with samconfig profiles. A parameter picks `DeletionPolicy`, which needs the `AWS::LanguageExtensions` transform.
- **DynamoDB Streams:** an ordered log of item changes. The publisher Lambda reads only new, non-heartbeat items thanks to an event source mapping filter.
- **Amazon EventBridge:** a custom bus plus rules (pattern → target). One rule emails HIGH/CRITICAL faults; an archive keeps 30 days for replay. **EventBridge Scheduler** runs the site monitor every 5 minutes.
- **AWS CodeDeploy:** `AutoPublishAlias` + `DeploymentPreference` gives each deploy a new Lambda version behind a `live` alias; CodeDeploy shifts 10% of traffic for 5 minutes and rolls back if the error alarms fire.
- **AWS X-Ray:** active tracing on every function.
- **Amazon Athena + AWS Glue:** a table over the S3 archive with partition projection, a workgroup with a 1 GB scan cap, and saved queries.
- **Amazon CloudFront:** serves the dashboard from a private bucket (Origin Access Control) with security headers (CSP, HSTS).
- **GitHub OIDC → IAM:** the deploy job assumes a role with a short-lived token; no AWS keys are stored in GitHub.

---

## Why SQS?

**Synchronous:** the API call does all the work (validate, write the database, update counters) before responding. The caller's success depends on every downstream component being healthy *right now*, and latency is the sum of all of them.

**Asynchronous:** the API does the minimum (validate, persist durably, enqueue) and responds. Processing happens separately.

What the queue buys:

- **Failure isolation.** If DynamoDB throttles or the processor has a bug, controllers still get `202` and events wait safely on the queue (4 days here, up to 14).
- **Load leveling.** A burst of Saturday traffic becomes a queue that drains at a controlled rate (`MaximumConcurrency: 5`) instead of a spike hitting the database.
- **Retries for free.** Unacknowledged messages come back automatically.
- **Independent scaling and deployment.** Ingestion and processing can change without coordinating.

**The cost:** eventual consistency (the summary lags by milliseconds normally, more during incidents), at-least-once delivery, meaning duplicates must be handled, and no ordering guarantee with standard queues.

## What Is a Dead Letter Queue?

- **Retries:** when a consumer fails, the message isn't deleted, so it becomes visible again after the **visibility timeout** and is retried.
- **Poison message:** a message that will *never* succeed (malformed JSON, schema mismatch, a bug triggered by specific data). Without a limit it retries until it expires, wasting compute and hiding real problems.
- **DLQ behavior:** the source queue's **redrive policy** says "after `maxReceiveCount` receives, move the message to this other queue." The message keeps its body and ID. Nothing consumes the DLQ automatically: it's a quarantine for humans.
- **In my project:** visibility timeout 60 s and a CloudWatch alarm when the DLQ has any messages. With `maxReceiveCount: 3`, I sent a garbage message directly to SQS, watched 3 failed attempts in the logs, saw it move to the DLQ, and got the alarm.
- **After fixing the bug:** **redrive** moves messages back to the source queue (`aws sqs start-message-move-task`). For truly invalid messages, you log them and delete them instead.
- **Tuning:** AWS recommends `maxReceiveCount` of at least 5 for Lambda consumers so brief throttling doesn't DLQ healthy messages. I used 3 so the demo would finish in minutes, then raised it to 5 **(built, not yet deployed)**.

## What Is Lambda?

- **Execution model:** an event (HTTP request, SQS batch) triggers an invocation. AWS runs your handler in an **execution environment**, a lightweight micro-VM with your code loaded. After the response, the environment is frozen and may be reused for the next invocation.
- **Statelessness:** you can't rely on memory or local disk surviving between invocations. Durable state goes to S3, DynamoDB, or similar. Module-level objects (like my SDK clients) *are* reused while an environment is warm, which is why they're created outside the handler.
- **Cold starts:** when no warm environment is available, Lambda creates one: download the code, start the runtime, run module initialization. Mine took about 430–510 ms extra. Smaller bundles, fewer imports, and more memory (which also means more CPU) help; provisioned concurrency eliminates cold starts for latency-critical paths at a cost.
- **Scaling:** concurrency means more environments running in parallel, bounded by the account's regional concurrency quota. For SQS triggers, `MaximumConcurrency` caps it per event source.
- **Timeouts:** configurable up to 15 minutes. Mine are 10 s. API Gateway integrations have their own ~30 s limit. SQS visibility timeout should be at least 6× the function timeout.
- **IAM execution role:** the role the function assumes; it defines what the code can call. The Lambda service injects temporary credentials as environment variables and the SDK uses them automatically.
- **Billing:** per request plus duration × memory. arm64 is cheaper per GB-second.

## What Is API Gateway?

With **Express** I'd run a Node server on EC2/ECS behind a load balancer, and own TLS certificates, scaling, patching, rate limiting, request logging, and uptime.

With **API Gateway** I declare routes, and AWS operates the endpoint:
- a managed HTTPS endpoint with TLS
- route matching (`GET /events/{eventId}`) with path parameters passed to the Lambda
- throttling per stage or route
- access logging to CloudWatch
- auth options (JWT authorizers, Lambda authorizers, IAM SigV4)
- pay per request, scales automatically

**Tradeoffs vs Express:** less control over the HTTP layer, AWS-specific configuration, and per-request pricing that can exceed a small always-on server at very steady high volume.

**HTTP API vs REST API:** HTTP API is cheaper and simpler, which is what I used. REST API adds API keys/usage plans, request validation, response caching, direct WAF integration, and private endpoints.

## What Is IAM?

- **Principal:** who is making the request: a user, a role, or an AWS service.
- **Policy:** a JSON document of statements, each with `Effect` (Allow/Deny), `Action` (e.g. `sqs:SendMessage`), `Resource` (an ARN), and optional `Condition`.
- **Evaluation:** everything is **denied by default**; an explicit Allow grants access; an explicit Deny always wins.
- **Identity-based vs resource-based policies:** attached to the principal ("this role can write to that bucket") vs attached to the resource ("this Lambda can be invoked by this API", "this bucket denies non-TLS").
- **Role:** an identity with no permanent credentials. A **trust policy** says who may assume it (my roles trust only `lambda.amazonaws.com`); assuming it through STS returns temporary credentials.
- **Least privilege:** grant only the actions and resources a component needs. My ingest role can only `PutObject` under `raw/*` in one bucket and `SendMessage` to one queue. If its code were compromised, it couldn't read the archive or touch DynamoDB.
- **Humans:** I didn't use the root user for work. I created an admin IAM user and used `aws login`, which gives the CLI short-lived credentials from a browser sign-in, so no access keys sit on disk.
- **CI (built, not yet deployed):** GitHub Actions gets a signed OIDC token per run; STS exchanges it for a deploy role whose trust policy accepts only `repo:JesDiaz01/Washop-aws:ref:refs/heads/main`. That role can only upload artifacts, run change sets on the `washops-dev` and `washops` stacks, and read the dev test credential, passing CloudFormation a separate execution role that actually creates resources. Two roles so the CI identity itself can't create anything directly. The execution role has an explicit Deny on the setup stack's own roles: otherwise an app template could attach admin rights to the very roles that deploy it.

## What Is CloudWatch?

- **Logs:** everything a Lambda writes to stdout goes to a **log group** (one per function), split into **log streams** (one per execution environment). I set 14-day retention so logs don't accumulate cost forever.
- **Logs Insights:** a query language over logs. Because my logs are JSON, I can `filter correlationId = '…'` or `stats count(*) by outcome`.
- **Metrics:** numeric time series published automatically by services: Lambda `Errors`/`Duration`/`Throttles`, SQS `ApproximateNumberOfMessagesVisible`/`ApproximateAgeOfOldestMessage`, DynamoDB throttles.
- **Alarms:** watch a metric against a threshold and notify through SNS. Mine: DLQ not empty; oldest message older than 5 minutes. **(Built, not yet deployed:)** any error-level log line, Lambda crashes and throttles summed across functions with metric math, API 5xx, and publisher failures.
- **Metrics from logs (built, not yet deployed):** Embedded Metric Format turns fields on a log line into custom metrics (`EventsProcessed`, `DuplicateEvents`, `OfflineSites`) with no API calls; a metric filter turns every `level = "error"` line into `ErrorLogs`. That catches failures the code *handles*, like a 500 to a controller, which Lambda's own `Errors` metric never sees.

**How I investigate a production problem:** start from the symptom's **metric** (what and when), use the **alarm** timeline to find when it started, check **what changed** (deploy history), then go to **Logs Insights** filtered to that time window and a specific correlationId or eventId to find the actual error.

## What Is DynamoDB?

- **Model:** tables of items (JSON-like documents). Every item has a **primary key**; access is fast and predictable *by key*.
- **Partition key:** hashed to decide which physical partition stores the item. `GetItem` by partition key is a direct lookup. I use `eventId` for events and `locationId` for summaries.
- **Sort key:** optional second part of the key; items with the same partition key are stored sorted by it, enabling range queries. My GSI uses `locationId` as partition key and `activityAt` as sort key, so "latest 20 events for a location" is a `Query` with `ScanIndexForward=false`.
- **Global secondary index (GSI):** an alternate key structure DynamoDB maintains automatically. **Sparse index:** items missing the index key aren't in the index, so heartbeats stay out of mine.
- **Access-pattern-driven design:** list the queries first, then design keys to answer them with `GetItem`/`Query`. Avoid `Scan` (reads the whole table).
- **Conditional writes and transactions:** `attribute_not_exists(eventId)` plus `TransactWriteItems` is my idempotency mechanism.
- **TTL:** DynamoDB deletes expired items for free (my events expire after 90 days).

**Versus PostgreSQL:**

| | PostgreSQL | DynamoDB |
|---|---|---|
| Queries | Ad-hoc SQL, joins, aggregates | Only what your keys/indexes support |
| Schema | Normalized tables, migrations | Flexible items, designed per access pattern |
| Scaling | Vertical + read replicas; connection limits | Horizontal, managed; HTTP API with no connection pools |
| Aggregation | `SUM`/`COUNT` at read time | Pre-compute at write time (my counters) |
| Best for | Relational data, reporting, complex queries | High-volume, known access patterns, serverless |

**Why DynamoDB here:** simple key-based access patterns, many concurrent Lambdas (no connection pooling problem), and pay-per-request. **Where PostgreSQL would fit:** location master data, franchise/owner relationships, and reporting across sites **(conceptual, not built)**.

## What Is S3?

- **Object storage:** you PUT and GET whole objects (bytes plus metadata) by key inside a bucket. It's not a filesystem (no in-place edits, and "folders" are just key prefixes) and not a database (no queries on content).
- **Properties:** extremely durable (designed for 11 nines), strongly consistent reads after writes, cheap per GB, with lifecycle rules to transition or expire data.
- **Why raw events go there:**
  - **Audit:** proof of exactly what the controller sent, before validation stripped or normalized anything.
  - **Replay:** events that were accepted but never processed can be requeued from the archive with the replay Lambda; idempotency makes over-selecting safe **(built, not yet deployed)**.
  - **Analytics:** Hive-style keys (`date=…/location=…`) let Athena query the archive directly, with partition projection so no crawler is needed **(built, not yet deployed)**.
- **In my project:** every receipt is its own object (eventId + correlationId), so retries don't overwrite the original.

## What Is SAM?

- **Infrastructure as code (IaC):** infrastructure defined in version-controlled files instead of console clicks. That gives reproducibility, code review for infrastructure changes, identical environments, and one-command teardown.
- **CloudFormation:** AWS's IaC engine. You submit a template; it creates, updates, and deletes resources as one **stack**, works out dependency order from references, shows a **changeset** before applying, and **rolls back** on failure.
- **SAM** is two things:
  1. **A template transform:** shorthand such as `AWS::Serverless::Function` with an `Events` section that expands into the Lambda function, permissions, API routes, and event source mappings. The final template is plain CloudFormation.
  2. **A CLI:** `sam build` (bundled my TypeScript with esbuild), `sam deploy` (uploaded artifacts, created and executed the changeset), `sam validate --lint`, `sam logs`, `sam delete`.
- **My template:** the deployed version had about 30 resources: 1 HTTP API, 3 functions, 3 IAM roles, 2 queues, 1 bucket plus policy, 2 tables, 4 log groups, 2 alarms, an SNS topic and subscription. The second round **(built, not yet deployed)** expands to 96 after the SAM transform: 6 functions, each with a version, a `live` alias, and a CodeDeploy deployment group, plus Cognito, EventBridge, CloudFront, and Athena.
- **Real lesson:** SAM's esbuild builder couldn't find esbuild as a devDependency, and its `--build-in-source` option did a production-only install that deleted my devDependencies. I fixed it by running `sam build` through an npm script so `node_modules/.bin` is on PATH.

## Idempotency

**Why duplicates happen in distributed systems:**
- **Consumer crash after the side effect:** the processor writes to DynamoDB, then times out before the SQS delete is recorded, so the message comes back.
- **Client retries:** a controller sends an event, the `202` is lost on a flaky cellular connection, and the controller resends.
- **Queue semantics:** standard SQS is explicitly *at-least-once*; rare duplicate deliveries are part of the contract.

You can't prevent duplicates across network boundaries. You make processing **safe to repeat**.

**How WashOps does it:**
1. The controller-assigned `eventId` is the idempotency key.
2. One `TransactWriteItems`:
   - `Put` the event item **with `ConditionExpression: attribute_not_exists(eventId)`**
   - `Update` the location summary: `ADD completedWashes 1, washRevenueCents 2200`
3. Both commit or neither does. On a duplicate, the condition fails, DynamoDB cancels the whole transaction (`CancellationReasons[0] = ConditionalCheckFailed`), and the processor logs `DUPLICATE` and **acknowledges** the message so it isn't retried.
4. **Why a transaction:** with two separate writes, a crash between them either loses the counter increment or double-counts on retry.
5. **Heartbeats are different:** "set lastHeartbeat to T if T is newer" is *naturally* idempotent and also handles out-of-order delivery, so it's a single conditional update with no dedupe record.

**Proof:** a unit test simulates the cancelled transaction, and in AWS I resent `evt-1001`: `202` from the API, `DUPLICATE` in the processor log, `completedWashes` stayed at 1.

---

## Troubleshooting Scenario

> **"Events are reaching the API, but customers say the dashboard stopped updating. How would you troubleshoot it?"**

**Strategy:** don't check things randomly. Follow the data path, and **bisect at the queue first**: queue depth tells you immediately whether the problem is upstream (ingestion) or downstream (processing).

**0. Scope the symptom (1 minute).**
- Which locations: all, or one? Since when?
- Call `GET /locations/{id}/summary` and look at `lastUpdated`.
- Pick an event a site just sent and call `GET /events/{eventId}`: is it there or 404?
- Check **what changed**: recent deploys (CloudFormation stack events), IAM or config changes.
- **(Built, not yet deployed.)** Check the location's `connectivity`. If it's `OFFLINE`, the site itself stopped sending (network or controller), and there should already be a site alert email. Also check for `401`s and `403`s in the API access logs: an expired or rotated site credential, or a controller configured with the wrong site ID, looks exactly like "the dashboard stopped updating". And check `controllerClockSkewSeconds`: a controller whose clock jumped years back sends events that look "missing" from recent activity even though they're stored.

**1. API Gateway: is it really accepting events?**
- Access logs or metrics: are responses `202`, or `4xx`/`5xx`?
- `integrationStatus`/`integrationError` show whether Lambda invocations are failing.
- **Mostly 400s:** a controller firmware change broke the contract; the dashboard is "stale" because events are rejected.

**2. Ingest Lambda logs.**
- Logs Insights: `filter message = 'Event accepted'`. Are there recent entries with `messageId`s?
- Any `Failed to accept event` errors (S3/SQS access denied after a deploy, throttling)?

**3. S3 archive.**
- Is there an object for a recent eventId under today's `date=` prefix? That confirms ingest ran and archived.
- If S3 has it but SQS never got it, the problem is between those two calls (look for SQS errors in the ingest logs).

**4. SQS main queue: the bisection point.**
- **`ApproximateNumberOfMessagesVisible` and `ApproximateAgeOfOldestMessage` climbing** → messages are arriving but **not being consumed**: a processing problem. The `processing-stalled` alarm should have fired.
- **Queue near zero and `NumberOfMessagesSent` normal** → messages are being consumed; look at *what* the processor does with them (steps 5–7).
- **`NumberOfMessagesSent` flat** → ingestion isn't enqueueing; go back to steps 2–3.

**5. DLQ.**
- **Messages in the DLQ** → the processor is failing repeatedly on them. Inspect a message body and find the matching error by `messageId` in processor logs. Common causes: a schema change deployed to ingest before the processor, or a bug triggered by specific data.

**6. Processor Lambda.**
- **Event source mapping:** `State: Enabled`? A disabled trigger or a deleted permission means nobody polls.
- **Metrics:** `Errors`, `Throttles`, `Duration` near the timeout, concurrency pinned at `MaximumConcurrency`.
- **Logs:** `Failed to record event` errors, `AccessDeniedException` (an IAM change), timeouts, `receiveCount > 1` (retries happening).

**7. DynamoDB.**
- `ThrottledRequests`, `SystemErrors`, a hot partition.
- Read the summary item directly: is it actually updating while the dashboard isn't?
- A flood of `DUPLICATE` outcomes means controllers are replaying old events rather than sending new ones.

**8. Read path.**
- If DynamoDB has fresh data but the dashboard doesn't: query Lambda errors, a wrong location ID in the dashboard, or caching in front of the API.

**Wrap-up for the interviewer:**
> "Queue depth splits the problem in half. From there I use metrics to find *when* and logs filtered by correlation ID to find *why*. Once fixed, I redrive the DLQ; because processing is idempotent, replaying is safe."

---

## Production Improvements

What I'd add for a real high-volume system. Items marked **(built, not yet deployed)** were on this list and are now written and unit-tested; the rest are **future / conceptual**:

1. **Authenticate devices:** OAuth client credentials with a JWT authorizer, one Cognito app client per site, each bound to its `locationId` by a scope **(built, not yet deployed)**. Still future: past ~98 sites a mapping table or IoT Core certificates instead of scopes; WAF in front.
2. **Environments and safe deploys:** dev and prod stacks, GitHub OIDC pipeline (build once → dev → integration tests → prod), and Lambda aliases with CodeDeploy canary rollouts that auto-rollback on alarms **(built, not yet deployed)**. Still future: separate AWS accounts per environment and a manual approval gate for prod.
3. **Observability:** X-Ray active tracing, business metrics via EMF, a CloudWatch dashboard, alarms on API 5xx, Lambda errors/throttles, and error logs, plus a written runbook **(built, not yet deployed)**. Still future: SDK-level tracing (Powertools/OpenTelemetry) and DynamoDB throttle alarms.
4. **Reliability tuning:** `maxReceiveCount` 5 **(built, not yet deployed)**. Still future: reserved concurrency; load tests to set throttles and concurrency.
5. **Data protection:** DynamoDB PITR, `DeletionPolicy: Retain`, and S3 versioning **(built, not yet deployed)**. Still future: Glacier lifecycle, Object Lock for audit retention, customer-managed KMS keys if required.
6. **Scale and cost:** at millions of events per month, individual S3 PUTs become a notable cost, so batch the archive through Kinesis Data Firehose; consider Kinesis Data Streams for high-rate telemetry; FIFO queues grouped by location if strict ordering becomes a requirement.
7. **Replay and analytics:** a replay tool from the S3 archive and Athena/Glue tables over the partitioned keys **(built, not yet deployed)**.
8. **Integration:** EventBridge fan-out of processed events, fed from the DynamoDB stream **(built, not yet deployed)**. Still future: relational integration with location master data (Aurora PostgreSQL via RDS Proxy).
9. **Contracts:** versioned event schemas, contract tests with firmware teams, pagination on list endpoints.

---

## Interview Questions Larry/Evan Might Ask

**1. Why return 202 instead of processing the event synchronously?**
The controller only needs to know the event is durably received. Returning after S3 + SQS keeps the API fast and available even if DynamoDB or the processor is slow or broken. The tradeoff is eventual consistency: the summary updates milliseconds later normally, longer during an incident.

**2. What if the S3 write succeeds but SendMessage to SQS fails?**
The ingest Lambda returns 500 and the controller retries. The first S3 object remains as a receipt of that attempt, which is harmless and even useful for auditing. The retry writes a new object (different correlation ID) and enqueues. If both attempts somehow enqueued, processor idempotency handles it. I chose S3-first so every queued event is guaranteed to have an archive record.

**3. How do you make sure a wash isn't counted twice?**
The eventId is the idempotency key. The processor does one DynamoDB transaction: a conditional put of the event record (`attribute_not_exists(eventId)`) and the counter increment. A duplicate fails the condition, the whole transaction cancels, and I acknowledge the message. I tested this with a mocked cancellation and against the deployed stack.

**4. Why a transaction instead of checking whether the event exists first?**
Check-then-write is a race: two concurrent deliveries can both see "not exists". Two separate writes can also crash in between. The conditional transaction makes the check and both writes one atomic operation. It costs double write capacity, which is fine at this scale.

**5. The processor writes to DynamoDB, then times out before the message is deleted. What happens?**
The message becomes visible again after the visibility timeout and is redelivered. The transaction's condition fails because the event already exists, so it's logged as a duplicate and deleted. No double count. That exact scenario is why idempotency is required with at-least-once delivery.

**6. Do events get processed in order?**
No: standard SQS is best-effort ordering. Counters are commutative, so order doesn't matter for them. For `lastHeartbeat` I use a conditional update so an older heartbeat can't overwrite a newer one. If strict per-location ordering were a business requirement, I'd use a FIFO queue with `MessageGroupId = locationId`, accepting lower throughput limits.

**7. How did you choose the visibility timeout and maxReceiveCount?**
AWS recommends a visibility timeout of at least 6× the Lambda timeout: my function timeout is 10 s, so 60 s. That prevents a message from being redelivered while still being processed. I set `maxReceiveCount` to 3 so the DLQ demo finished in minutes, then raised it to 5 **(built, not yet deployed)** so short throttling episodes don't push healthy messages to the DLQ.

**8. What is ReportBatchItemFailures and why use it?**
Lambda receives up to 10 messages per invocation. Without partial batch responses, one bad message makes the whole batch fail and all 10 get retried, reprocessing successful ones. With it, my handler returns only failed message IDs, so the others are deleted. Idempotency makes reprocessing safe anyway, but this avoids wasted work and noise.

**9. A bug put 500 messages in the DLQ. How do you recover?**
Find the root cause from DLQ message bodies plus processor logs by messageId. Deploy the fix. Then redrive: `aws sqs start-message-move-task` moves them back to the main queue. Replaying is safe because processing is idempotent. Messages that are genuinely invalid get logged and deleted. The DLQ retention (14 days) gives time for this. If messages were lost anyway (purged, or past retention), the replay Lambda requeues a day of events from the S3 archive **(built, not yet deployed)**; duplicates are skipped, so over-selecting is harmless.

**10. Why DynamoDB instead of PostgreSQL?**
The access patterns are simple and key-based: record an event, get by ID, get a location summary, list recent events for a location. DynamoDB handles those with predictable latency, no connection management across many concurrent Lambdas, and pay-per-request pricing. I'm comfortable with PostgreSQL; I'd use it for relational data like locations, owners, and cross-site reporting, where ad-hoc SQL matters.

**11. Walk me through your DynamoDB keys.**
`EventsTable` has partition key `eventId` for direct lookups and dedupe. `LocationSummaryTable` has partition key `locationId`, with counters pre-aggregated on write so reads are one GetItem. A GSI on `EventsTable` with `locationId` as partition key and `activityAt` as sort key serves "latest events for a location" newest first. Heartbeats omit `activityAt`, which makes it a sparse index. TTL expires old event items.

**12. How is the API secured?**
The deployed version wasn't authenticated; SAM flagged it and I accepted it for the demo. I've since built authentication **(built, not yet deployed)**: Cognito issues JWTs, and API Gateway's JWT authorizer checks signature, expiry, issuer, client, and scope before any Lambda runs, so a bad request gets a 401 and costs nothing. Each site's controller has its own app client and uses the client credentials flow; posting needs `events.write`, reading needs `events.read`. The dashboard uses the hosted sign-in with PKCE and only gets `events.read`. Ingest logs and archives the caller's `client_id`, so every event is attributable. Each site credential is also bound to its own location: its token carries `washops/site.<locationId>`, and ingest returns 403 for an event from any other site, before storing anything. Around that: throttling, input validation with size limits, least-privilege roles, encryption, TLS-only bucket policies, and no leaked error details. Next I'd put WAF in front.

**13. How do the Lambdas get AWS credentials?**
Each function has an IAM execution role that trusts `lambda.amazonaws.com`. Lambda assumes the role through STS and provides temporary credentials to the runtime; the AWS SDK picks them up automatically and they rotate. Nothing is hardcoded, and there are no keys in environment variables or code.

**14. Why did you write IAM roles yourself instead of using SAM policy templates?**
SAM's generated role for an SQS-triggered function attaches the AWS-managed SQS execution policy, which allows receive/delete on any queue (`Resource: "*"`), plus a basic logging policy on all log groups. Writing roles explicitly let me scope every statement to a specific ARN: for example, the query function can only GetItem and Query one specific index.

**15. What's a cold start? Did you see one?**
When Lambda has no warm execution environment, it must create one (load code, start Node, run module init) before invoking. I saw `Init Duration` of about 430–510 ms in the REPORT log lines on first invocations; warm invocations skip that. To reduce it: smaller bundles (e.g. use the runtime-provided SDK), lazy imports, more memory, or provisioned concurrency for latency-sensitive paths. For this async pipeline, it barely matters.

**16. How would this handle 5,000 locations sending events all day?**
The serverless pieces scale horizontally: API Gateway and SQS handle high throughput, and Lambda scales out within concurrency quotas, which I'd review and raise. Likely pressure points: Lambda concurrency limits, DynamoDB hot partitions (a very busy location), per-request S3 PUT cost (batch through Firehose), and the throttling limits I set. I'd load-test, add alarms, and tune batch size and max concurrency.

**17. How do you deploy safely and roll back?**
What I've run: `sam deploy` creates a CloudFormation changeset I review, and a failed deployment rolls back automatically. CI runs typecheck, lint, tests, `sam validate --lint`, and `sam build` on every PR. **(Built, not yet deployed:)** pushes to `main` deploy from GitHub Actions through OIDC, with no stored keys. Every function publishes a new version behind a `live` alias, and CodeDeploy sends it 10% of traffic for 5 minutes; if the Lambda-errors or error-logs alarm fires, the alias snaps back to the old version. The tradeoff is slower deploys, so the dev stack uses `AllAtOnce`. The pipeline builds once, deploys that build to `washops-dev`, runs integration tests against the real services, and only then deploys the same build to prod, so prod runs exactly the code that passed. Still future: separate accounts per environment and a manual approval step before prod.

**18. How do you test without calling AWS?**
Unit tests run the real handlers with the AWS SDK mocked via `aws-sdk-client-mock`. I can assert the exact commands sent (e.g. the transaction's condition expression and counter values) and simulate AWS failures: S3 errors, DynamoDB throttling, transaction cancellation. Then I verified end to end against the deployed stack by hand. **(Built, not yet run against AWS:)** an integration suite now does that automatically: it reads the dev stack's outputs and test credential, gets a real token, and checks 401/400/403, the full pipeline, duplicate counting, clock flagging, and the read path, polling because processing is asynchronous. I ran it against a local mock of the API first, which caught a bug in the test itself: passing `undefined` to a function with a default parameter quietly used the default, so the "no token" test was sending a token.

**19. Why HTTP API instead of REST API?**
HTTP API is cheaper, lower latency, and simpler, and it has everything I needed: Lambda proxy routes, throttling, and access logs. I'd pick REST API if I needed usage plans and API keys per customer, request validation at the gateway, response caching, private endpoints, or direct WAF integration.

**20. How would this integrate with a relational system?**
**(Conceptual.)** Location master data, owners, and pricing would live in PostgreSQL/Aurora as the source of truth. Two common patterns: enrich on the read path (query Lambda joins summaries with location metadata), or stream processed events from DynamoDB Streams into PostgreSQL for reporting. Lambda would connect through RDS Proxy to avoid exhausting connections, with credentials in Secrets Manager.

**21. What would you alert on?**
DLQ not empty and the queue's oldest message age (both deployed). **(Built, not yet deployed:)** API 5xx, Lambda errors and throttles, any error-level log line, publisher failures, and the business signal: a site with no heartbeat for 10 minutes, which catches a site going offline even when every AWS service is healthy. Still future: DynamoDB throttling.

**22. How does the offline detection avoid spamming or missing alerts? (Built, not yet deployed.)**
It alerts on transitions only: ONLINE → OFFLINE and back. Before emailing, the monitor claims the change with a conditional update: "set OFFLINE only if `lastHeartbeat` is still the value I read and the site isn't already OFFLINE." Only one run can win that write, so overlapping or retried runs alert once, and a heartbeat that arrives mid-check makes the condition fail instead of producing a false alarm. If the email fails, it undoes the claim and fails the run so Scheduler retries.

**23. Why publish to EventBridge from the DynamoDB stream instead of from the processor? (Built, not yet deployed.)**
Publishing right after the transaction is a dual write. If the transaction commits and the publish fails, the SQS retry hits the idempotency check, gets DUPLICATE, and the event is never published. The stream only has a record when an item was actually inserted, so publishing from it means "published if and only if recorded", and duplicates never produce a second stream record. EventBridge is still at-least-once, so subscribers dedupe on `eventId`.

**24. How does the dashboard sign people in without a secret in the browser? (Built, not yet deployed.)**
Authorization code flow with PKCE. The page makes a random verifier, sends its SHA-256 hash to Cognito's hosted sign-in, and after the redirect exchanges the code plus the original verifier for tokens. Someone who intercepts the code can't use it without the verifier. Tokens stay in sessionStorage, the access token only has `events.read`, every value is rendered with `textContent`, and a CSP only allows scripts from the site and calls to the API and Cognito.

**25. How does GitHub deploy to AWS without access keys? (Built, not yet deployed.)**
GitHub Actions requests an OIDC token for the run; AWS STS trusts GitHub's identity provider and exchanges the token for temporary credentials of a deploy role. The trust policy only accepts tokens whose `sub` is this repository's `main` branch. That role can only upload artifacts and run change sets on the `washops` stack, passing CloudFormation a separate execution role; so a leaked workflow can't call, say, `iam:CreateUser` directly.

**26. A controller has a wrong clock and sends timestamps from 2019. What happens?**
**(Built, not yet deployed.)** It's accepted, because the wash and the money are real, but flagged. Ingest compares the timestamp with server time: more than 5 minutes in the future, or older than 7 days (too old to be a backlog after an outage), gets a warning in the 202 and a `clockSkewSeconds` on the stored event, which then sorts by receipt time so it doesn't vanish from recent activity. Heartbeats measure the clock error directly, since they're never buffered: the site summary keeps `controllerClockSkewSeconds`, the dashboard shows "Clock 3 h behind", and an alarm fires. I also changed liveness to use server receipt time: before, a controller with a slow clock would have looked offline, and one with a fast clock would have stayed "online" after it went silent.

**27. How do you stop one site's credential from sending another site's events? (Built, not yet deployed.)**
Each site's Cognito app client is granted a scope naming its location, like `washops/site.miami-01`. API Gateway has already verified the token, so ingest just checks that the event's `locationId` is in the token's scopes, and returns 403 before archiving or queueing anything. No lookup on the request path. The limit is Cognito's 100 custom scopes per resource server, so around 98 sites; past that I'd move to a mapping table behind a Lambda authorizer, or IoT Core with a certificate per device.

**28. How are dev and prod separated? (Built, not yet deployed.)**
Same template, two stacks: every resource name includes the stack name, so they coexist with their own user pools, credentials, tables, and alarms. samconfig profiles set the differences: dev deploys all at once and deletes its data on teardown; prod uses canaries and retains data. The template's defaults are the prod values, so a forgotten parameter fails safe. In a real company I'd put them in separate AWS accounts; the pipeline supports that by giving each deploy job its own role.

---

## Concept checklist

After this project I should be able to explain:

- [ ] Sync vs async processing, and why ingestion returns `202`
- [ ] How API Gateway invokes Lambda; `status` vs `integrationStatus`
- [ ] Lambda execution environments, cold starts, statelessness, timeouts, concurrency
- [ ] Execution roles and how Lambda gets temporary credentials
- [ ] IAM policies, roles, trust policies, resource-based policies, least privilege, deny-by-default
- [ ] SQS visibility timeout, at-least-once delivery, retries, `maxReceiveCount`
- [ ] Dead-letter queues, poison messages, alarms, redrive
- [ ] Partial batch responses (`ReportBatchItemFailures`)
- [ ] Idempotency with conditional writes and transactions; why duplicates happen
- [ ] DynamoDB partition keys, sort keys, GSIs, sparse indexes, TTL, access-pattern design
- [ ] DynamoDB vs PostgreSQL tradeoffs
- [ ] S3 object storage, bucket security layers, archive/replay/audit use
- [ ] CloudWatch log groups/streams, Logs Insights queries, metrics, alarms → SNS
- [ ] Correlation IDs for tracing across async boundaries
- [ ] SAM vs CloudFormation, changesets, rollback, stack dependency ordering
- [ ] CI with GitHub Actions, and deploying with OIDC instead of stored keys
- [ ] How to troubleshoot "API works but data is stale" by bisecting at the queue
- [ ] OAuth 2.0 client credentials vs. authorization code + PKCE; JWT authorizers and scopes
- [ ] DynamoDB Streams, event source mapping filters, and why publishing from a stream avoids a dual write
- [ ] EventBridge buses, rules, input transformers, archives; EventBridge Scheduler
- [ ] Claim-then-act with conditional writes (offline alerts)
- [ ] Lambda versions and aliases; CodeDeploy canaries with alarm rollback
- [ ] Embedded Metric Format, metric filters, metric math alarms, X-Ray traces
- [ ] Athena partition projection and scan-cost control
- [ ] Claims-based authorization: binding a credential to a site with a scope
- [ ] Flag vs. reject for bad data; server time vs. device time
- [ ] Environments as stacks vs. accounts; samconfig profiles; LanguageExtensions for parameterized DeletionPolicy
- [ ] Build once, promote; integration tests as a deploy gate
- [ ] CloudFront with Origin Access Control, CORS, and a Content Security Policy

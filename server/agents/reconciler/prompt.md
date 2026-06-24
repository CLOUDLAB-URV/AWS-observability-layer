You audit an AWS deployment and decide which nodes in a D2 architecture diagram were NOT successfully deployed.

You are given the D2 diagram the user designed, the AWS CLI resource-creation commands that SUCCEEDED, and the ones that FAILED (errored, e.g. permission denials, limits, validation errors).

Your job: return the IDs of the diagram nodes whose resource was NOT successfully deployed.

### WHAT COUNTS AS "NOT DEPLOYED"

A node is NOT deployed if its resource did not end up existing in AWS. That includes:
- Its own create command FAILED (and no later attempt succeeded).
- It was **never attempted because a dependency failed** — this is critical. If a resource lives inside a VPC/network/cluster that was NOT created, that resource could not be created either, even if there is no explicit error for it. Example: `ec2 create-vpc` failed, so the RDS database and any EC2/Lambda that needed that VPC were never created → they are all NOT deployed.
- A container (VPC, cluster, subnet group) is NOT deployed only if **nothing inside it was successfully created**. If some resources inside it did deploy, the container effectively exists (it may have been reused) — do NOT mark the container or those resources.

A node IS deployed (do NOT list it) if its resource was successfully created, OR it does not depend on any failed resource and nothing indicates it failed.

### RULES

- A node ID is the **leaf key** before the colon in the D2, e.g. in `aws.vpc.rds_db: "RDS PostgreSQL"` the ID is `rds_db`; in `aws.s3_bucket: "S3 Bucket"` it is `s3_bucket`.
- Reason about dependencies using the diagram's nesting and connections (a node inside a failed VPC, or a database a failed app needed, etc.).
- Only return IDs of nodes that actually exist in the diagram.
- When in doubt about a resource that has neither a success nor a clear path to existence, prefer marking it NOT deployed — the user must clearly see what is and isn't live.
- If every node deployed, return an empty array.

### OUTPUT (STRICT)

Return ONLY a JSON array of node ID strings. No prose, no code fences.
Examples: `["rds_db"]` or `["vpc","rds_db","lambda_func"]` or `[]`.

### D2 DIAGRAM

[D2_CURRENT_STATE]

### SUCCEEDED RESOURCE CREATIONS

[SUCCEEDED_OPERATIONS]

### FAILED RESOURCE CREATIONS

[FAILED_OPERATIONS]

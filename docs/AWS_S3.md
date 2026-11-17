# AWS S3 document storage

WakeelBoost stores every document (uploads, generated letters and agreements, tablet-signed copies,
SeedFi credit reports, facility ZIP archives and the bank's Word templates) in one private S3 bucket.
The app only ever puts, gets, copies and deletes objects; nothing is publicly addressable, and every
view or download goes through WakeelBoost's own access checks and audit trail.

Replace `<account-id>`, `<region>` (for example `eu-west-1`), `<key-id>` and the bucket name below.

## 1. Bucket

- Name: for example `altbank-wakeelboost-documents-prod`, in the region closest to the app servers.
- **Block all public access**: on (all four settings).
- **Object ownership**: bucket owner enforced (ACLs disabled).
- **Default encryption**: SSE-KMS with a customer-managed key (below), **bucket key enabled** (lowers
  KMS cost).
- **Versioning**: on. It protects against accidental or malicious deletion; old versions are expired
  by the lifecycle rule in section 4, so the retention purge still takes effect.
- Optional: server access logging or CloudTrail data events to the bank's log account.

## 2. Encryption key (KMS)

Create a customer-managed symmetric KMS key, for example alias `alias/wakeelboost-documents`, with
automatic yearly rotation on. Its key policy lets the WakeelBoost role (section 3) use it, and only
the bank's key administrators manage it.

## 3. Access for WakeelBoost (least privilege)

Give the app an IAM role (preferred, on EC2/ECS/EKS) or, if it runs outside AWS, an IAM user whose
access key goes only into the server's secret store. Attach this policy and nothing else:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "WakeelBoostObjects",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::altbank-wakeelboost-documents-prod/*"
    },
    {
      "Sid": "WakeelBoostKey",
      "Effect": "Allow",
      "Action": ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"],
      "Resource": "arn:aws:kms:<region>:<account-id>:key/<key-id>"
    }
  ]
}
```

(Copying an object, used when a file leaves quarantine, needs only `GetObject` on the source and
`PutObject` on the destination.)

## 4. Bucket policy: HTTPS and encryption enforced

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyInsecureTransport",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": ["arn:aws:s3:::altbank-wakeelboost-documents-prod", "arn:aws:s3:::altbank-wakeelboost-documents-prod/*"],
      "Condition": { "Bool": { "aws:SecureTransport": "false" } }
    },
    {
      "Sid": "DenyUnencryptedUploads",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::altbank-wakeelboost-documents-prod/*",
      "Condition": { "StringNotEquals": { "s3:x-amz-server-side-encryption": "aws:kms" } }
    }
  ]
}
```

## 5. Lifecycle: cost and space control

S3 has no capacity limit, so the bucket cannot fill up; the lifecycle rules keep cost down as it grows.
Files still open instantly in WakeelBoost in every storage class used here.

```json
{
  "Rules": [
    {
      "ID": "documents-to-cheaper-storage",
      "Status": "Enabled",
      "Filter": { "Prefix": "documents/" },
      "Transitions": [
        { "Days": 90, "StorageClass": "STANDARD_IA" },
        { "Days": 365, "StorageClass": "GLACIER_IR" }
      ]
    },
    {
      "ID": "expire-old-versions",
      "Status": "Enabled",
      "Filter": {},
      "NoncurrentVersionExpiration": { "NoncurrentDays": 90 }
    },
    {
      "ID": "abort-incomplete-uploads",
      "Status": "Enabled",
      "Filter": {},
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }
    }
  ]
}
```

- `quarantine/` (files waiting for the malware scan) and `templates/` stay in Standard.
- Standard-IA and Glacier Instant Retrieval cost roughly 45% and 80% less per GB than Standard, with a
  small charge per retrieval; documents of closed facilities are rarely opened.
- Deleted (purged) files keep a noncurrent version for 90 days, then are gone.

## 6. Monitoring growth and cost

- **AWS Budgets**: a monthly cost budget for the bucket (filter by the bucket's cost-allocation tag,
  for example `app=wakeelboost`), alerting the IT and finance contacts at 80% and 100%.
- **CloudWatch alarm** on the bucket's `BucketSizeBytes` metric (daily) above the size you expect,
  for example 50 GB in the first year.
- **S3 Storage Lens** (free tier) for growth trends by prefix.

Rough sizing, to check against real usage after go-live: about 20 to 30 MB per facility (documents
plus the closing ZIP archive, which holds copies), so 20 to 30 GB a year at 1,000 facilities. Nothing
is removed before `RETENTION_YEARS` (10 by default), when the retention purge deletes the files.

## 7. WakeelBoost settings

```
STORAGE_DRIVER=s3
S3_BUCKET=altbank-wakeelboost-documents-prod
S3_REGION=<region>
S3_SERVER_SIDE_ENCRYPTION=aws:kms
S3_KMS_KEY_ID=arn:aws:kms:<region>:<account-id>:key/<key-id>
# Leave S3_ENDPOINT empty and S3_FORCE_PATH_STYLE=false for AWS.
# Credentials: the IAM role, or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in the secret store only.
```

Production refuses to start with local file storage or with `S3_SERVER_SIDE_ENCRYPTION=none`.

To check from the server once configured, upload a document to a test request and open it; the
object appears under `documents/<request ref>/<document type>/` in the bucket, encrypted with the
KMS key.

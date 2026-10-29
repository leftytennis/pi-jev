# Security Policy

## Reporting a Vulnerability

If you discover a potential security vulnerability in `pi-jev`, please do not report it via public GitHub issues.

Instead, please email security reports directly to:
**theophilodamiao@gmail.com**

Please include:
- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof of concept
- Any suggested mitigations

We will review reports promptly and publish patches with proper attribution.

## Data Egress

When its features are enabled, pi-jev sends evaluation state (prompts, tool
arguments, error output, diffs, session entries) to the TypeSafe API endpoint
configured by `TYPESAFE_API_KEY`. Common secret formats are redacted before
transmission (`src/redact.ts`), and tool-guard skips calls touching
secret-bearing paths entirely. See "Data sent to the TypeSafe API" in the
README for the exact per-feature payloads, and keep opt-in flags off for
sensitive work.

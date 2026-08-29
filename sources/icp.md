# ICP definition — Speed & Function

This is the rubric the engagement classifier reads verbatim to decide, for each
person who engaged with the tracked posts, whether they are in S&F's Ideal
Customer Profile. It is **geography-first**, matching the company-page geo
classifier (`fast/page/geo_classify.py`): S&F sells to the **US** market.

## Verdict rule

Classify by the person's **location** (their LinkedIn profile location / the
region on their card). Map to one bucket, then to an ICP verdict:

| Bucket | Who | ICP verdict |
|--------|-----|-------------|
| **US** | United States — any US city/metro/state. By LinkedIn convention a location shown with **no country suffix** (e.g. "Greater Philadelphia", "New York City Metropolitan Area", "San Francisco Bay Area") is the US. | **ICP = true** |
| **TEAM** | Ukraine (S&F's own home team — colleagues, not customers) | ICP = false |
| **ANTI** | India or China (explicitly off-target markets) | ICP = false |
| **OTHER** | Anywhere else (EU, UK, LatAm, etc.) | ICP = false |

## Notes for the classifier

- **Location beats headline.** A great title in the wrong geography is still not
  ICP; S&F's ICP is defined by market (US), not by role.
- If the location is genuinely unknown or absent, default the verdict to
  **false** (do not guess ICP=true without a US signal).
- "Remote" or company-only locations with no country: infer from other profile
  signals (city in experience, etc.); if still unresolved → false.
- This intentionally treats Ukrainian colleagues (TEAM) and off-market
  audiences (ANTI/OTHER) the same way for the ICP tier — they are all
  non-ICP — while the geo section of the dashboard keeps the four buckets
  separate for visibility.

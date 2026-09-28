# S&F Enterprise Department — ICP, the part a LinkedIn headline can answer

Source of truth: **"S&F ICP — Enterprise Department (2026)", v1.4, 23 Sep 2026**
(Google Sheets). This file is NOT a copy of it. It is the slice of that document
that can be judged from what LinkedIn actually shows us about a person, and it
is read verbatim by `fast/classify-icp.mjs` as the rubric.

**This replaces the geography-only rubric that stood here until 2026-09-28**
(added in PR #14), which answered one question — "is this person in the US?" —
and made every non-US person, including a perfect CTO, ICP = false. The ED sheet
prices geography at 4 of 100 points, so geography can no longer be the whole
answer; it is kept below as a hard exclusion for the two markets the sheet and
the old rubric both call off-target, and as a signal otherwise. Nothing is lost:
no verdict had ever been computed under the old rubric (the classifier's
`claude -p` call has been failing all along), and a rubric change invalidates
cached verdicts by design.

The four geography buckets stay exactly as they were for the dashboard's own geo
section and for `fast/page/geo_classify.py` — US / TEAM (Ukraine, our own team) /
ANTI (India, China) / OTHER. This file only stops them from BEING the ICP tier.

## What you are judging, and with what

You see one person: a name, one headline line, and sometimes scraped profile
text. You never see the company's revenue, funding, platform, stack or
location. So you are answering the persona question from tab 05 only:

> **Is this person a plausible Enterprise-Department counterpart — someone who
> owns a business-critical platform, or someone who signs for it?**

The company question (tabs 01–02: platform ownership, funded budget, segment,
company age, geography) is deliberately NOT yours. It is answered from HubSpot,
and the two are combined downstream. The source document keeps that split on
purpose: "a company can be a perfect firmographic fit and still be unworkable
because the only reachable contact is the wrong person — and the reverse."

Judge only what is written. Do not infer seniority from a company name, do not
guess a role from an industry, and never invent a title. A headline that says
nothing about the person's role is **not** a match.

## Answer TRUE when the headline shows one of these two personas

**P1 · The Platform Owner** — accountable for the platform staying alive.
Observed in our CRM as: CTO, Chief Technology Officer, Head of Technology,
Director of Technology, VP of IT, CIO, Engineering Manager, Head of
Engineering, Head of Product, Director of Product, Product Manager, Solution
Architect, Application Security Lead, Head of Platform, Technical Lead where it
is clearly the senior technical person.

**P3 · The Economic Buyer / mission sponsor** — the person who signs. In
organisations of 50–300 this is not a procurement function: Owner, CEO,
President, Founder, Co-founder, Managing Partner, Principal, Executive
Director, Managing Director, COO, CFO, Chief Growth Officer, EVP.
P3 is the persona our revenue actually closes through (30.9% of the
relationship base, 58.5% of recent prospecting).

**P2 · The Operations Owner** (Director of Operations, Head of Operations,
Program Manager, Director of Quality) is a hypothesis, not a confirmed persona
— 3.8% of the base. Treat as TRUE only when the headline also ties the person
to an owned platform or system ("Director of Operations, clinical data
platform"). Otherwise FALSE.

## Answer FALSE for these, whatever the title says

- **Agency, studio, consultancy, dev shop, outsourcing, staffing, reseller or
  delivery intermediary.** Out of scope by decision (Aug 2026): agencies have a
  separate ICP. This is the single most important exclusion.
- **Recruiters, talent, HR, sales, marketing or business-development roles** —
  they neither own the platform nor sign for it.
- **Freelancers, contractors, "available for hire", students, interns,
  bootcamp learners, "aspiring" anything.**
- **Our own people** (Speed & Function) and obvious personal accounts.
- **Restricted industries:** gambling and casinos, tobacco, adult content,
  dating, payday lending, weapons, crypto trading and token projects.
- **A headline that is empty, a slogan, a list of hashtags, or only a company
  name** — there is nothing to judge. FALSE, not a guess.
- **A location that is plainly off-market:** India or China (the sheet and the
  geo classifier both call these explicitly off-target), or Ukraine, which is
  our own team and network rather than a customer signal. Location beats title
  for these two cases only.

Geography otherwise: S&F sells to the **US** market, so a US location supports a
TRUE and a non-US one weakens it — but it does not decide. A missing location
does not make a matching persona FALSE. (LinkedIn convention: a US metro carries
no country suffix — "Greater Boston" is the US, "Berlin, Germany" is not.)

## Supporting evidence, never the decider

If the headline names an employer, it may raise confidence when that employer
plainly fits one of the five ED segments, but it can never make a
non-persona person TRUE on its own:

- **A · Mission-driven open data & public knowledge** — non-profit, NGO,
  foundation, open-source project, public-knowledge platform. (Our two largest
  lifetime accounts are here.)
- **B · Regulated life sciences & health operations** — pharma, biotech,
  health services, clinical or commercial operations under regulation.
- **C · Learning & human development** — leadership programmes, professional or
  continuing education, certification, LMS or assessment platforms.
- **D · Subscription media & consumer platforms** — a subscription product with
  a real in-house engineering organisation.
- **E · Supply chain & logistics platforms** — supplier and facility data,
  traceability, due diligence, visibility, planning, carrier or shipper
  portals, freight and 3PL operating systems, standards registries.

Also supporting: a visible purpose-governance signal (B Corp, 501(c)(3),
steward-ownership, Conscious Capitalism, Teal, DDO, regenerative networks,
open-source governance). Roughly $7.5M of our lifetime revenue sits with
organisations whose purpose is structural rather than claimed. A mission
*statement* in a headline proves nothing.

## Reason lines

Give the reason in ≤12 words, naming the persona and the deciding words from
the headline: "P1 — Head of Technology at an open-data non-profit",
"FALSE — agency owner", "FALSE — headline names no role".

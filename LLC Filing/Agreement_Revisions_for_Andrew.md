# Original Work Sales Agreement — requested revisions

**Document:** `Kudzu_Arts_Original_Work_Sales_Agreement_v2.pdf`
**Why:** The agreement was drafted for a fixed set of works agreed in advance. The
platform works differently — artists sign up, upload work continuously, and set
their own prices. These changes align the document with how kudzuarts.com
actually operates, so an artist signs once at signup and nothing further is
needed.

---

## 1. Authorized Works & Pricing

**Problem.** Section 1 lists specific Works in a table with fixed Retail Prices,
and states *"Each additional Work requires a written exhibit signed by both
Parties."* On the platform an artist uploads up to ten works whenever they like,
setting each price themselves. Under the current wording every upload after
signing would fall outside the agreement.

**Change to.** Remove the works table entirely. The agreement should cover **any
and all works the Artist lists on kudzuarts.com**, automatically, for as long as
they remain listed. The Artist sets the Retail Price at upload, and that price is
the authorized price — no separate exhibit, no countersignature per work.

Suggested substance: *"This Agreement applies to each original work the Artist
uploads and lists for sale on kudzuarts.com. The Retail Price is the price set by
the Artist at the time of listing. Listing a work constitutes its addition to
this Agreement."*

---

## 2. Revenue Split & Payment

**Problem.** Section 2 specifies payment by *"ACH / check / Venmo"* within 72
hours of *"confirmed payment processing and DELIVERY."* The platform pays through
**Stripe Connect** — the Artist's 75% is transferred at the moment of purchase,
and Kudzu's 25% is taken in transit as an application fee. Kudzu never holds the
Artist's money.

**Change to.** Payment method is Stripe. Keep 75/25. Payout timing depends on how
the work reaches the buyer, and the two paths are deliberately different:

**Shipped works.** The buyer pays in full before the work ships. The Artist's 75%
transfers on successful payment — Kudzu Arts never holds it. All original works
ship **signature-required**: a one-of-a-kind work cannot be left on a doorstep,
and the carrier's signature record is independent proof of delivery.

**Local pickup.** The buyer pays in full at checkout and the Artist is paid
immediately, exactly as with a shipped work. At the handoff both parties sign a
Bill of Lading, which is emailed to each of them and kept in the Artist's
account.

### Why a Bill of Lading, and why not a hold

A shipped work produces a carrier's signature — independent proof of delivery
that neither party controls. A hand-to-hand sale produces nothing, and the Bill
of Lading fills that gap. It matters most for a **chargeback**: a buyer who pays
by card, collects the work, then disputes the charge weeks later. Documented
proof of delivery is what reverses that, and this is it.

An earlier version of this proposal had Kudzu hold pickup payments until the
document was signed. **That is dropped.** It made Kudzu a custodian of artist
money, and it punished the wrong person — a buyer who simply never turned up
would leave the Artist holding both the work and an unpaid balance. A sale is a
sale. Kudzu never holds an artist's money on either route.

---

## 3. Exclusive Sales Period

**Problem.** Section 3.1 sets an exclusivity period running to a fixed
`[EXCLUSIVITY END DATE]`, which is currently blank. Section 3.2 then bars the
Artist from selling those works through any other channel for that whole period.
As written an artist is agreeing to an open-ended lock-up.

**Change to.** Tie exclusivity to **listing status, not to a date.** A work is
exclusive to Kudzu Arts *for as long as it is listed on kudzuarts.com*. The
Artist may remove a work at any time, and exclusivity for that work ends when it
comes down.

The point is preventing a piece being sold twice — listed here and on another
platform simultaneously. It is not to trap anyone. Telling an artist they cannot
take their own work down would be unreasonable and would put people off signing.

Suggested substance: *"While a Work is listed on kudzuarts.com, the Artist shall
not offer that Work for sale through any other gallery, dealer, marketplace, or
direct-to-buyer channel. The Artist may remove a Work from listing at any time,
whereupon exclusivity as to that Work ends."*

### 3.5 Good faith on removal *(new — the important one)*

Removing a work has to stay easy, or nobody signs. But delisting shouldn't become
the obvious way to take a Kudzu-introduced buyer off the books. The answer is a
good-faith clause rather than a restriction — modelled on the one in Ian's own
gallery agreement, which asked the artist to come back and deal honestly with a
sale that really came from the show.

Suggested substance: *"The Artist may remove a Work from listing at any time and
for any reason. If a Work is removed and subsequently sold within six (6) months
to a buyer who first encountered that Work through Kudzu Arts, the Artist agrees
in good faith to notify Kudzu Arts and to complete the sale through Kudzu Arts,
with Kudzu Arts receiving its 25% share. This obligation rests on good faith and
mutual respect rather than surveillance; Kudzu Arts trusts the Artist to honour
it, as Kudzu Arts undertakes to honour its obligations to the Artist."*

Tone matters here as much as substance. It should read as *we trust you to do the
right thing* — not as a clause waiting to be enforced. Nobody should feel their
own work is held hostage by a website.

---

## 4. Delivery — add local pickup and the Bill of Lading

**Problem.** Section 4.2 sets an order of preference for delivery and encourages
local handoff, but describes nothing concrete for it — no document, no record,
no defined moment when the work is considered delivered.

**Change to.** Name the two delivery paths explicitly and attach the evidence
each one produces.

**(a) Local pickup.** Buyer and Artist arrange the handoff directly — the Artist
chooses where, and their address is never published. Kudzu Arts generates a
**Bill of Lading** for the sale: work title, artist, buyer, price, order number,
date, condition line, and signature blocks for both parties. **Both parties sign
at the handoff, each on their own phone**, or on paper if they prefer; the buyer
keeps a copy, and both signatures are recorded against the order. Delivery is
deemed to occur on signature. Payment is not contingent on it — the Artist was
paid at purchase.

**(b) Shipping.** As currently drafted, plus: all original works ship
**signature-required and insured for the Retail Price**, and the tracking number
is recorded against the order. Delivery is deemed to occur on the carrier's
confirmed signature.

**(c) No third path.** A Work should not change hands without one of these two
records existing. Worth saying so plainly — it protects the Artist as much as
Kudzu Arts.

---

## 5. Condition Report

**Problem.** Section 5 requires the Artist to complete and sign a written
Condition Report for each work before listing, provided to Kudzu Arts and
attached as an exhibit. Nothing on the platform does this, and requiring a signed
document per upload defeats the point of self-serve uploading.

**Change to.** Fold it into the single signature. Signing the agreement means
every work the Artist subsequently uploads is covered, and the Artist warrants at
upload that the photographs and description accurately represent the work's
current condition. Drop the separate signed report and the exhibit requirement.

---

## Signature block

**Problem.** The document has signature lines for both parties, plus
`[ARTIST FULL LEGAL NAME]` and `[ARTIST ADDRESS]` as blanks. Signing on the site
is one-sided and digital — the artist signs and it's done. Kudzu cannot
countersign in the moment.

**Change to.**

- **Kudzu Arts' signature pre-executed on the document**, with name, title, and a
  standing date — so what the artist receives is already signed by Kudzu and they
  are countersigning it.
- **Artist's full legal name and address collected as part of signing** — typed
  into the agreement itself, not into the signup flow. This distinction matters:
  asking a stranger for their home address as they create an account reads as
  intrusive; asking for it inside a contract they're executing is ordinary and
  expected, because that's what a contract needs. It appears once, on the
  agreement page, alongside a line saying it's used only for the agreement and
  never shown publicly.
- Section 11.7 already permits electronic execution, so typed-name signature is
  covered. Worth adding an explicit line that typing their full legal name and
  submitting constitutes their signature.

---

## What gets recorded when someone signs

For Andrew's reference, the platform will store, per signature:

- The artist's typed full legal name and address
- The exact version of the agreement they signed
- Timestamp, IP address, and browser

Versioning matters: when this document is revised, existing artists remain on the
version they actually agreed to, and can be asked to sign the new one. Nobody is
retroactively bound to terms they never saw.

---

## Summary

| Section | Change |
|---|---|
| 1 | Drop the works table — the agreement covers everything uploaded to the site |
| 2 | Stripe, not ACH/check/Venmo. Artist paid immediately on both routes; Kudzu never holds funds. Local pickup adds a signed Bill of Lading as the record of delivery. |
| 4 | **New:** two named delivery paths — local pickup with a signed Bill of Lading, or shipping signature-required and insured. No work changes hands without one of the two records. |
| 3.1 | Exclusivity lasts while a work is listed, not to a fixed date. Artist may remove work at any time. |
| 3.5 | **New:** good-faith clause — if a removed work sells within 6 months to a buyer who found it here, bring the sale back through Kudzu |
| 5 | No separate Condition Report — covered by the one signature and a warranty at upload |
| Signatures | Kudzu pre-signed; artist types full legal name and address to execute |

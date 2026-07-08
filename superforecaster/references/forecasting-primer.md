# Forecasting Primer — Quick Reference

## Base Rates to Know

| Domain | Typical success rate |
|--------|---------------------|
| FDA drug approvals (Phase 2 → market) | ~12% |
| Tech startups reaching $1B valuation | ~1% of funded |
| Major wars ending within 5 years | ~40% |
| IPCC "likely" events (>66%) | Calibrated well historically |
| Political forecasts by pundits | Roughly coin-flip |
| Superforecaster predictions at 70% | Hit ~70% of the time |

## Brier Score Reference
- Brier score = mean squared error of probability predictions
- Perfect = 0.0, Random = 0.25, Always-50% = 0.25
- Top human superforecasters: ~0.14–0.17
- AI superforecasters (mid-2026): ~0.15–0.18

## Key Biases to Avoid in Forecasting
- **Planning fallacy**: Things take longer and cost more than expected
- **Scope insensitivity**: Don't treat "10% by 2030" and "10% by 2040" the same
- **Narrative bias**: A compelling story ≠ high probability
- **Anchoring**: First number you hear biases all subsequent estimates
- **Availability**: Recent/vivid events seem more probable than they are

## Reference Class Forecasting Steps
1. Identify the class of similar cases
2. Find the base rate for that class
3. Identify how this case is above/below average within the class
4. Adjust from base rate based on those differences
5. Weight inside view (specific details) more heavily as resolution approaches

## Confidence Interval Guidance
- 90% CI should contain the true value 90% of the time
- Most people's 90% CIs are actually ~50% CIs (overconfident)
- Rule of thumb: your CI should feel "too wide" — that's usually right

## When Markets Differ From Your Estimate
- If you're >15pp away from the market: you likely know something the market doesn't, OR you have a bias
- Check: am I adjusting for platform-specific biases? (Manifold = play money, more volatile; Kalshi = CFTC-regulated, tighter spreads)
- Check: is there a structural reason one platform prices differently? (e.g., US regulatory risk doesn't apply on offshore platforms)

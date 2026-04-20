# ORB Breakout — Backtest Results

## Best Config (2026-04-14)
- orbBars=12 (1hr opening range on 5m), tpRangeMult=2.5
- adx=20, trendAge=3, sessionStart=0 (midnight UTC)
- **Quality filters**: diConfirm=true, stAlign=true
- SL = opposite side of range + 0.3 ATR buffer (capped at 3 ATR)
- Trail: BE at 1R, start trailing at 1.5R, trailAtrMult=1.0
- Per-session: one long + one short allowed (reset at session open)

## Results with Quality Filters (diConfirm + stAlign)

### SUIUSDT (2026-04-14)
```
3m:  +12.7% | PF 2.20 | DD ~5%
6m:  +21.8% | PF 2.00 | DD ~7%
12m: +29.9% | PF 1.67 | DD 9.7%
```

### APTUSDT — FAILS on 12m (do not trade)
### DOGEUSDT — FAILS everywhere (do not trade)

## Results without Quality Filters (2026-04-14)

### SUIUSDT
```
3m:  +4.8%  | PF 1.59
6m:  +7.6%  | PF 1.47
12m: +12.0% | PF 1.43
```

## Run Commands

```bash
# 12-month with quality filters (best config)
node src/strategies/orb/backtest.js SUIUSDT 12 5 --orbbars=12 --tpmult=2.5 --adx=20 --trendage=3 --sessionstart=0 --slbuffer=0.3 --maxsl=3.0 --minrange=0.5 --maxrange=3.0 --maxbars=48 --trailbe=1.0 --trailstart=1.5 --trailatr=1.0

# Without quality filters (for comparison)
node src/strategies/orb/backtest.js SUIUSDT 12 5 --orbbars=12 --tpmult=2.5 --adx=20 --trendage=3 --sessionstart=0 --diconf=0 --stalign=0

# 3-month quick test
node src/strategies/orb/backtest.js SUIUSDT 3 5 --orbbars=12 --tpmult=2.5 --adx=20 --trendage=3 --sessionstart=0

# Add --debug for individual trades
```

## Key Findings
- **Only SUI works** — APT fails 12m validation, DOGE fails everywhere
- Quality filters (diConfirm + stAlign) nearly double performance
- Session=0 (midnight UTC) is optimal — session=2 overfits on 3m, fails on 6m/12m
- closeq filter helps 3m/6m but HURTS 12m badly — do NOT use

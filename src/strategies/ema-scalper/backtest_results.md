# EMA Pullback Scalper — Backtest Results

## Best Config (2026-04-14)
- sl=2.0, tp=4.0, pullback=5, os=40, trendAge=3
- VWAP alignment + 5m ST direction + 15m trend age >= 3
- Trail: BE at 1.0R, start at 1.5R, trailAtrMult=0.75

## 6-Month Results (2026-04-14)

### SUIUSDT (ema=21, adx=25)
```
+5.7% | PF 1.72
```

### APTUSDT (ema=30, adx=20)
```
+5.6% | PF 1.99
```

### DOGEUSDT — marginal, skip

## 12-Month Validation (2026-04-14)

### APTUSDT (ema=30, adx=20)
```
+6.0% | PF 1.66 — validated
```

### SUIUSDT — fails on 12m (Apr-Oct 2025 choppy), seasonal edge only

## Run Commands

```bash
# SUI 6-month
node src/strategies/ema-scalper/backtest.js SUIUSDT 6 5 --sl=2.0 --tp=4.0 --adx=25 --pullback=5 --os=40 --trendage=3 --ema=21 --maxbars=24 --trailbe=1.0 --trailstart=1.5 --trailatr=0.75

# APT 12-month (best pair for this strategy)
node src/strategies/ema-scalper/backtest.js APTUSDT 12 5 --sl=2.0 --tp=4.0 --adx=20 --pullback=5 --os=40 --trendage=3 --ema=30 --maxbars=24 --trailbe=1.0 --trailstart=1.5 --trailatr=0.75

# Add --debug for individual trades
```

## Key Findings
- APT needs different params: EMA_LEN=30, ADX_THRESH=20 (set in ecosystem.config.js)
- SUI has seasonal edge — works in trending markets, fails in chop
- DOGE is marginal — not worth trading with this strategy
- Hardcode timeframe: "5" — don't use TIMEFRAME env var

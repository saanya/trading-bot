# MTF Trend Scalper — Backtest Results

## Best Config (2026-04-14)
- **usePartial: false** + trailing stop (no partial TPs)
- session=1, dow=1 (skip Monday only), adx=20
- sl=2.0, tp=4.0, trailBeR=1.0, trailStartR=2.0, trailAtrMult=1.0
- sessionSkipStart=20, sessionSkipEnd=2, sessionSkipHours=[8,9,13]
- maxBarsTrade=40, cooldownBars=2, beOnStFlip=true

## 12-Month Results (2026-04-14)

### SUIUSDT
```
Net Profit: $421.35 (42.1%) | Max DD: 3.5% | PF: 3.63 | Trades: 68 (W:44 L:24)
```

### APTUSDT
```
Net Profit: $396.77 (39.7%) | Max DD: 7.0% | PF: 3.02 | Trades: 86 (W:54 L:32)
```

### DOGEUSDT
```
Net Profit: $360.14 (36.0%) | Max DD: 4.7% | PF: 3.51 | Trades: 81 (W:52 L:29)
```

## Run Commands

```bash
# 12-month backtest (best config)
node src/strategies/mtf-trend/backtest.js SUIUSDT 12 15 --partial=0 --trailbe=1.0 --trailstart=2.0 --sl=2.0 --tp=4.0 --session=1 --dow=1 --adx=20
node src/strategies/mtf-trend/backtest.js APTUSDT 12 15 --partial=0 --trailbe=1.0 --trailstart=2.0 --sl=2.0 --tp=4.0 --session=1 --dow=1 --adx=20
node src/strategies/mtf-trend/backtest.js DOGEUSDT 12 15 --partial=0 --trailbe=1.0 --trailstart=2.0 --sl=2.0 --tp=4.0 --session=1 --dow=1 --adx=20

# With full trade list
# Add --debug flag to see individual trades

# 3-month quick test
node src/strategies/mtf-trend/backtest.js SUIUSDT 3 15 --partial=0 --trailbe=1.0 --trailstart=2.0 --sl=2.0 --tp=4.0 --session=1 --dow=1 --adx=20
```

## Config Comparison (SUIUSDT 12m, 2026-04-14)

| Config | PnL | PF | Trades | DD |
|--------|-----|-----|--------|-----|
| session=1, dow=1, adx=20 | **+42.1%** | **3.63** | 68 | 3.5% |
| session=1, dow=1,2, adx=20 | +23.2% | 3.16 | 40 | 3.3% |
| session=1, dow=1, adx=25 | +24.4% | 3.28 | 39 | 3.3% |
| session=1, no dow, adx=20 | +36.4% | 2.87 | 82 | 5.1% |
| session=0, no dow, adx=20 | +22.6% | 2.13 | 112 | 7.2% |
| session=0, no dow, adx=25 | +9.4% | 1.52 | 64 | 6.8% |

## Key Findings
- **skipDays: [1]** (Monday only) is optimal — skipping Tuesday cuts profitable trades
- **adx=20** much better than adx=25 — more trades with similar quality
- Session filter is critical — without it PnL drops significantly
- No partial + trailing outperforms partial TPs (PF 3.6x vs 1.8x)

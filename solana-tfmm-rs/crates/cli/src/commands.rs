use anyhow::Result;
use std::collections::BTreeMap;
use std::fs;

// =========================
// sim
// =========================

pub fn run_sim() -> Result<()> {
    println!("=== Phase 5.1: PFDA parameter sweep (Rust) ===");
    println!("Running baseline / PFDA scenarios + parameter sweep...\n");

    // (A) まず既存のサマリー（比較用）
    let summaries = tfmm_sim::run_pfda_baseline_vs_pfda()?;
    println!("--- Baseline vs PFDA (preview) ---");
    for s in &summaries {
        println!("{}", s);
        println!();
    }
    write_sim_summaries_csv(&summaries)?;

    // (B) Phase 5.1: パラメータスイープ
    let sweep_rows = tfmm_sim::run_pfda_parameter_sweep()?;
    write_pfda_sweep_summary_csv(&sweep_rows)?;

    println!("--- PFDA sweep preview (top 10 by LVR reduction %) ---");
    let mut sorted = sweep_rows.clone();
    sorted.sort_by(|a, b| {
        b.lvr_reduction_pct
            .partial_cmp(&a.lvr_reduction_pct)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    for row in sorted.iter().take(10) {
        println!(
            "ws={:<4} disc={:<4.1} alpha={:<4.2} | LVR_red={:>8.4}% | protΔ={:>8.4} | valΔ={:>8.4}",
            row.window_slots,
            row.fee_discount_bps,
            row.alpha,
            row.lvr_reduction_pct * 100.0,
            row.protocol_revenue_delta_usd,
            row.validator_revenue_delta_usd,
        );
    }

    println!("\nNext:");
    println!("- Pythonで results/pfda_sweep_summary.csv を読み込み");
    println!("- LVR削減率ヒートマップ（window_slots × discount_bps, alpha別）を出す");
    println!("- マネーショット図：best PFDA vs vanilla のLVR比較を作る");

    Ok(())
}

// =========================
// real (Helius + Coinbase)
// =========================

pub fn run_real(pool: &str) -> Result<()> {
    println!("=== Phase 4.2: Helius + Coinbase (edge / fee / dt diagnostics) ===");
    println!("pool address: {pool}");

    const MAX_MATCH_DT_MS: i64 = 2_000;

    let helius = tfmm_ingest::HeliusClient::from_env()?;

    let txs = match helius.get_address_transactions(pool, 100, Some("SWAP"), None) {
        Ok(v) => {
            println!("fetched {} txs (type=SWAP)", v.len());
            v
        }
        Err(e) => {
            println!("SWAP filter fetch failed: {e}");
            println!("fallback: fetching without type filter...");
            let v = helius.get_address_transactions(pool, 100, None, None)?;
            println!("fetched {} txs (no type filter)", v.len());
            v
        }
    };

    if txs.is_empty() {
        println!("No transactions returned.");
        return Ok(());
    }

    let trades = tfmm_ingest::extract_swap_trade_previews(&txs);
    let (norm_trades, norm_report) = tfmm_ingest::normalize_sol_usdc_trades(&trades);

    println!("\n--- Normalization report (SOL/USDC only) ---");
    println!("total_trades             : {}", norm_report.total_trades);
    println!("normalized_sol_usdc      : {}", norm_report.normalized_sol_usdc);
    println!("dropped_not_sol_usdc_pair: {}", norm_report.dropped_not_sol_usdc_pair);
    println!("dropped_invalid_amount   : {}", norm_report.dropped_invalid_amount);

    if norm_trades.is_empty() {
        println!("No normalized SOL/USDC trades found.");
        return Ok(());
    }

    let min_ts_sec = norm_trades.iter().filter_map(|t| t.timestamp).min();
    let max_ts_sec = norm_trades.iter().filter_map(|t| t.timestamp).max();

    let (min_ts_sec, max_ts_sec) = match (min_ts_sec, max_ts_sec) {
        (Some(a), Some(b)) => (a, b),
        _ => {
            println!("No timestamps on normalized trades; cannot align external price.");
            return Ok(());
        }
    };

    let start_ms = (min_ts_sec - 5).max(0) * 1000;
    let end_ms = (max_ts_sec + 5).max(0) * 1000;

    println!("\nHelius normalized trade window:");
    println!("  min_ts_sec: {}", min_ts_sec);
    println!("  max_ts_sec: {}", max_ts_sec);
    println!("  query Coinbase trades range: {} .. {} (ms)", start_ms, end_ms);

    let coinbase = tfmm_ingest::coinbase::CoinbaseClient::new()?;
    let cb_trades = coinbase.get_trades_covering_range("SOL-USD", start_ms, end_ms, 1000, 10)?;

    println!("\nCoinbase trades fetched (in range): {}", cb_trades.len());

    if cb_trades.is_empty() {
        println!("No Coinbase trades returned in time window.");
        println!("(Try wider window / more pages / rerun shortly)");
        return Ok(());
    }

    #[derive(Debug, Clone)]
    struct MatchedTradeEdge {
        slot: u64,
        tx_ts_sec: i64,
        exec_price_usdc_per_sol: f64,
        ext_price_usd_per_sol: f64,
        edge_bps: f64,
        match_time_diff_ms: i64,
        notional_usdc: f64,
        fee_lamports: Option<u64>,
    }

    let mut matched = Vec::<MatchedTradeEdge>::new();
    let mut unmatched_count = 0usize;
    let mut dropped_by_match_dt = 0usize;

    for t in &norm_trades {
        let ts_sec = match t.timestamp {
            Some(v) => v,
            None => {
                unmatched_count += 1;
                continue;
            }
        };
        let ts_ms = ts_sec * 1000;

        if let Some(m) = tfmm_ingest::coinbase::nearest_price_match(&cb_trades, ts_ms) {
            if m.abs_time_diff_ms > MAX_MATCH_DT_MS {
                dropped_by_match_dt += 1;
                continue;
            }

            if let Some(edge) =
                tfmm_ingest::coinbase::edge_bps(t.exec_price_usdc_per_sol, m.price_usd_per_sol)
            {
                matched.push(MatchedTradeEdge {
                    slot: t.slot,
                    tx_ts_sec: ts_sec,
                    exec_price_usdc_per_sol: t.exec_price_usdc_per_sol,
                    ext_price_usd_per_sol: m.price_usd_per_sol,
                    edge_bps: edge,
                    match_time_diff_ms: m.abs_time_diff_ms,
                    notional_usdc: t.notional_usdc,
                    fee_lamports: t.fee,
                });
            } else {
                unmatched_count += 1;
            }
        } else {
            unmatched_count += 1;
        }
    }

    println!("\nMatch filter config:");
    println!("  max_match_dt_ms         : {}", MAX_MATCH_DT_MS);

    println!("\nMatched trade edges: {}", matched.len());
    println!("Unmatched / skipped : {}", unmatched_count);
    println!("Dropped by match dt : {}", dropped_by_match_dt);

    if matched.is_empty() {
        println!("No matched trades with Coinbase external price after dt filter.");
        println!("Try relaxing MAX_MATCH_DT_MS to 5000 or 10000.");
        return Ok(());
    }

    // ===== shared proxy price (used by fee proxy + CSV exports) =====
    let mean_ext_sol_usd = {
        let xs: Vec<f64> = matched.iter().map(|m| m.ext_price_usd_per_sol).collect();
        if xs.is_empty() {
            86.0
        } else {
            xs.iter().sum::<f64>() / xs.len() as f64
        }
    };

    // ===== CSV: matched_trades.csv =====
    ensure_results_dir()?;
    {
        let path = "results/matched_trades.csv";
        let mut wtr = csv::Writer::from_path(path)?;

        wtr.write_record([
            "slot",
            "tx_ts_sec",
            "exec_price_usdc_per_sol",
            "ext_price_usd_per_sol",
            "edge_bps",
            "match_time_diff_ms",
            "notional_usdc",
            "fee_lamports",
            "fee_usd_proxy",
            "edge_usd_proxy",
        ])?;

        for m in &matched {
            let fee_lamports = m.fee_lamports.unwrap_or(0);
            let fee_usd_proxy = (fee_lamports as f64 / 1_000_000_000.0) * mean_ext_sol_usd;
            let edge_usd_proxy = (m.edge_bps / 10_000.0) * m.notional_usdc;

            wtr.write_record([
                m.slot.to_string(),
                m.tx_ts_sec.to_string(),
                m.exec_price_usdc_per_sol.to_string(),
                m.ext_price_usd_per_sol.to_string(),
                m.edge_bps.to_string(),
                m.match_time_diff_ms.to_string(),
                m.notional_usdc.to_string(),
                fee_lamports.to_string(),
                fee_usd_proxy.to_string(),
                edge_usd_proxy.to_string(),
            ])?;
        }

        wtr.flush()?;
        println!("wrote: {}", path);
    }

    // ===== Phase 4.0a: fee_lamports / fee_usd_proxy distribution =====
    let mut fee_lamports_vals: Vec<f64> = matched
        .iter()
        .filter_map(|m| m.fee_lamports.map(|v| v as f64))
        .collect();

    fee_lamports_vals.sort_by(|a, b| a.partial_cmp(b).unwrap());

    let fee_count = fee_lamports_vals.len();

    let (
        fee_lamports_min,
        fee_lamports_p10,
        fee_lamports_p50,
        fee_lamports_p90,
        fee_lamports_max,
        fee_lamports_mean,
    ) = if fee_lamports_vals.is_empty() {
        (0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
    } else {
        let min_v = *fee_lamports_vals.first().unwrap();
        let p10_v = percentile_sorted(&fee_lamports_vals, 0.10).unwrap_or(0.0);
        let p50_v = percentile_sorted(&fee_lamports_vals, 0.50).unwrap_or(0.0);
        let p90_v = percentile_sorted(&fee_lamports_vals, 0.90).unwrap_or(0.0);
        let max_v = *fee_lamports_vals.last().unwrap();
        let mean_v = fee_lamports_vals.iter().sum::<f64>() / fee_lamports_vals.len() as f64;
        (min_v, p10_v, p50_v, p90_v, max_v, mean_v)
    };

    let lamports_to_usd = |lamports: f64| -> f64 {
        let sol = lamports / 1_000_000_000.0;
        sol * mean_ext_sol_usd
    };

    let fee_usd_min = lamports_to_usd(fee_lamports_min);
    let fee_usd_p10 = lamports_to_usd(fee_lamports_p10);
    let fee_usd_p50 = lamports_to_usd(fee_lamports_p50);
    let fee_usd_p90 = lamports_to_usd(fee_lamports_p90);
    let fee_usd_max = lamports_to_usd(fee_lamports_max);
    let fee_usd_mean = lamports_to_usd(fee_lamports_mean);

    let edge_usd_vals: Vec<f64> = matched
        .iter()
        .map(|m| (m.edge_bps / 10_000.0) * m.notional_usdc)
        .collect();

    let mean_edge_usd_proxy = if edge_usd_vals.is_empty() {
        0.0
    } else {
        edge_usd_vals.iter().sum::<f64>() / edge_usd_vals.len() as f64
    };

    let edge_to_fee_ratio_mean = if fee_usd_mean > 0.0 {
        mean_edge_usd_proxy / fee_usd_mean
    } else {
        0.0
    };

    println!("\nfee distribution (matched trades only):");
    println!("  fee count (with lamports)        : {}", fee_count);
    println!("  mean ext SOL/USD (proxy)         : {:.4}", mean_ext_sol_usd);

    println!("  fee_lamports min / p10 / p50 / p90 / max / mean");
    println!(
        "  {:.0} / {:.0} / {:.0} / {:.0} / {:.0} / {:.1}",
        fee_lamports_min,
        fee_lamports_p10,
        fee_lamports_p50,
        fee_lamports_p90,
        fee_lamports_max,
        fee_lamports_mean
    );

    println!("  fee_usd_proxy min / p10 / p50 / p90 / max / mean");
    println!(
        "  {:.6} / {:.6} / {:.6} / {:.6} / {:.6} / {:.6}",
        fee_usd_min, fee_usd_p10, fee_usd_p50, fee_usd_p90, fee_usd_max, fee_usd_mean
    );

    println!(
        "  mean edge_usd_proxy (|edge|*notional) : {:.6}",
        mean_edge_usd_proxy
    );
    println!(
        "  mean edge_usd_proxy / mean fee_usd    : {:.2}x",
        edge_to_fee_ratio_mean
    );

    println!("\nPhase 4.0b cost proxy candidates (from fee_usd_proxy quantiles):");
    println!("  low_cost_usd  ~= p10 = {:.6}", fee_usd_p10);
    println!("  base_cost_usd ~= p50 = {:.6}", fee_usd_p50);
    println!("  high_cost_usd ~= p90 = {:.6}", fee_usd_p90);

    // ===== Phase 4.1: edge × fee bucket analysis =====
    #[derive(Debug, Clone)]
    struct EdgeBucketAgg {
        label: &'static str,
        count: usize,
        mean_edge_bps: f64,
        mean_notional_usdc: f64,
        mean_fee_lamports: f64,
        mean_fee_usd_proxy: f64,
        mean_match_dt_ms: f64,
        min_edge_bps: f64,
        max_edge_bps: f64,
    }

    fn edge_bucket_label(edge_bps: f64) -> &'static str {
        if edge_bps < 1.0 {
            "[0,1)"
        } else if edge_bps < 2.0 {
            "[1,2)"
        } else if edge_bps < 3.0 {
            "[2,3)"
        } else if edge_bps < 4.0 {
            "[3,4)"
        } else {
            "[4,+)"
        }
    }

    let bucket_order = ["[0,1)", "[1,2)", "[2,3)", "[3,4)", "[4,+)"];
    let mut bucket_map: BTreeMap<&'static str, Vec<&MatchedTradeEdge>> = BTreeMap::new();

    for m in &matched {
        let key = edge_bucket_label(m.edge_bps);
        bucket_map.entry(key).or_default().push(m);
    }

    let mut bucket_aggs = Vec::<EdgeBucketAgg>::new();

    for label in bucket_order {
        if let Some(xs) = bucket_map.get(label) {
            if xs.is_empty() {
                continue;
            }

            let count = xs.len();
            let mean_edge_bps = xs.iter().map(|x| x.edge_bps).sum::<f64>() / count as f64;
            let mean_notional_usdc =
                xs.iter().map(|x| x.notional_usdc).sum::<f64>() / count as f64;

            let fee_lamports_vals: Vec<f64> = xs
                .iter()
                .filter_map(|x| x.fee_lamports.map(|v| v as f64))
                .collect();

            let mean_fee_lamports = if fee_lamports_vals.is_empty() {
                0.0
            } else {
                fee_lamports_vals.iter().sum::<f64>() / fee_lamports_vals.len() as f64
            };

            let mean_fee_usd_proxy = if fee_lamports_vals.is_empty() {
                0.0
            } else {
                fee_lamports_vals
                    .iter()
                    .map(|v| (*v / 1_000_000_000.0) * mean_ext_sol_usd)
                    .sum::<f64>()
                    / fee_lamports_vals.len() as f64
            };

            let mean_match_dt_ms =
                xs.iter().map(|x| x.match_time_diff_ms as f64).sum::<f64>() / count as f64;

            let min_edge_bps = xs.iter().map(|x| x.edge_bps).fold(f64::INFINITY, f64::min);
            let max_edge_bps = xs.iter().map(|x| x.edge_bps).fold(f64::NEG_INFINITY, f64::max);

            bucket_aggs.push(EdgeBucketAgg {
                label,
                count,
                mean_edge_bps,
                mean_notional_usdc,
                mean_fee_lamports,
                mean_fee_usd_proxy,
                mean_match_dt_ms,
                min_edge_bps,
                max_edge_bps,
            });
        }
    }

    println!("\nedge×fee bucket analysis (matched trades):");
    println!(
        "{:<8} {:>6} {:>10} {:>12} {:>14} {:>12} {:>12}",
        "bucket", "count", "mean_edge", "mean_notnl", "mean_fee_lam", "mean_fee_usd", "mean_dt_ms"
    );
    for b in &bucket_aggs {
        println!(
            "{:<8} {:>6} {:>10.3} {:>12.3} {:>14.1} {:>12.6} {:>12.1}",
            b.label,
            b.count,
            b.mean_edge_bps,
            b.mean_notional_usdc,
            b.mean_fee_lamports,
            b.mean_fee_usd_proxy,
            b.mean_match_dt_ms
        );
    }

    println!("\nedge×fee bucket notes:");
    for b in &bucket_aggs {
        println!(
            "  {}: edge range [{:.3}, {:.3}] bps, n={}",
            b.label, b.min_edge_bps, b.max_edge_bps, b.count
        );
    }

    let low_bucket = bucket_aggs.iter().find(|b| b.label == "[0,1)");
    let high_bucket = bucket_aggs.iter().find(|b| b.label == "[4,+)");
    if let (Some(lo), Some(hi)) = (low_bucket, high_bucket) {
        let fee_ratio = if lo.mean_fee_usd_proxy > 0.0 {
            hi.mean_fee_usd_proxy / lo.mean_fee_usd_proxy
        } else {
            0.0
        };
        let dt_ratio = if lo.mean_match_dt_ms > 0.0 {
            hi.mean_match_dt_ms / lo.mean_match_dt_ms
        } else {
            0.0
        };
        println!("\nedge bucket contrast ([4,+) vs [0,1)):");
        println!("  mean_fee_usd_proxy ratio : {:.2}x", fee_ratio);
        println!("  mean_match_dt_ms ratio   : {:.2}x", dt_ratio);
    }

    // ===== CSV: edge_buckets.csv =====
    {
        let path = "results/edge_buckets.csv";
        let mut wtr = csv::Writer::from_path(path)?;

        wtr.write_record([
            "bucket",
            "count",
            "mean_edge_bps",
            "mean_notional_usdc",
            "mean_fee_lamports",
            "mean_fee_usd_proxy",
            "mean_match_dt_ms",
            "min_edge_bps",
            "max_edge_bps",
        ])?;

        for b in &bucket_aggs {
            wtr.write_record([
                b.label.to_string(),
                b.count.to_string(),
                b.mean_edge_bps.to_string(),
                b.mean_notional_usdc.to_string(),
                b.mean_fee_lamports.to_string(),
                b.mean_fee_usd_proxy.to_string(),
                b.mean_match_dt_ms.to_string(),
                b.min_edge_bps.to_string(),
                b.max_edge_bps.to_string(),
            ])?;
        }

        wtr.flush()?;
        println!("wrote: {}", path);
    }

    println!("\n--- First 5 matched trade edges ---");
    for (i, m) in matched.iter().take(5).enumerate() {
        println!(
            "[{}] slot={} ts={} exec={:.6} ext={:.6} edge_bps={:.3} dt_ms={} notional_usdc={:.3} fee={:?}",
            i,
            m.slot,
            m.tx_ts_sec,
            m.exec_price_usdc_per_sol,
            m.ext_price_usd_per_sol,
            m.edge_bps,
            m.match_time_diff_ms,
            m.notional_usdc,
            m.fee_lamports
        );
    }

    let mut edges: Vec<f64> = matched.iter().map(|m| m.edge_bps).collect();
    edges.sort_by(|a, b| a.partial_cmp(b).unwrap());

    let edge_min = *edges.first().unwrap_or(&0.0);
    let edge_p10 = percentile_sorted(&edges, 0.10).unwrap_or(0.0);
    let edge_p25 = percentile_sorted(&edges, 0.25).unwrap_or(0.0);
    let edge_p50 = percentile_sorted(&edges, 0.50).unwrap_or(0.0);
    let edge_p75 = percentile_sorted(&edges, 0.75).unwrap_or(0.0);
    let edge_p90 = percentile_sorted(&edges, 0.90).unwrap_or(0.0);
    let edge_max = *edges.last().unwrap_or(&0.0);
    let edge_mean = edges.iter().sum::<f64>() / edges.len() as f64;

    let mean_match_dt_ms =
        matched.iter().map(|m| m.match_time_diff_ms as f64).sum::<f64>() / matched.len() as f64;
    let max_match_dt_observed = matched
        .iter()
        .map(|m| m.match_time_diff_ms)
        .max()
        .unwrap_or(0);

    #[derive(Debug, Clone)]
    struct SlotEdgeAgg {
        slot: u64,
        trade_count: usize,
        mean_edge_bps: f64,
        min_edge_bps: f64,
        max_edge_bps: f64,
        total_notional_usdc: f64,
        mean_match_dt_ms: f64,
    }

    let mut slot_map: BTreeMap<u64, Vec<&MatchedTradeEdge>> = BTreeMap::new();
    for m in &matched {
        slot_map.entry(m.slot).or_default().push(m);
    }

    let mut slot_aggs = Vec::<SlotEdgeAgg>::new();
    for (slot, xs) in slot_map {
        let trade_count = xs.len();
        let edge_vals: Vec<f64> = xs.iter().map(|x| x.edge_bps).collect();

        let mean_edge = edge_vals.iter().sum::<f64>() / edge_vals.len() as f64;
        let min_edge = edge_vals.iter().copied().fold(f64::INFINITY, f64::min);
        let max_edge = edge_vals.iter().copied().fold(f64::NEG_INFINITY, f64::max);

        let total_notional_usdc = xs.iter().map(|x| x.notional_usdc).sum::<f64>();
        let mean_dt_ms =
            xs.iter().map(|x| x.match_time_diff_ms as f64).sum::<f64>() / xs.len() as f64;

        slot_aggs.push(SlotEdgeAgg {
            slot,
            trade_count,
            mean_edge_bps: mean_edge,
            min_edge_bps: min_edge,
            max_edge_bps: max_edge,
            total_notional_usdc,
            mean_match_dt_ms: mean_dt_ms,
        });
    }

    slot_aggs.sort_by_key(|s| s.slot);

    println!("\n--- Slot-level edge aggregation (first 10) ---");
    for s in slot_aggs.iter().take(10) {
        println!(
            "slot={} trades={} mean_edge_bps={:.3} min={:.3} max={:.3} total_notional_usdc={:.3} mean_match_dt_ms={:.1}",
            s.slot,
            s.trade_count,
            s.mean_edge_bps,
            s.min_edge_bps,
            s.max_edge_bps,
            s.total_notional_usdc,
            s.mean_match_dt_ms
        );
    }

    // ===== CSV: slot_edge_aggs.csv =====
    {
        let path = "results/slot_edge_aggs.csv";
        let mut wtr = csv::Writer::from_path(path)?;

        wtr.write_record([
            "slot",
            "trade_count",
            "mean_edge_bps",
            "min_edge_bps",
            "max_edge_bps",
            "total_notional_usdc",
            "mean_match_dt_ms",
        ])?;

        for s in &slot_aggs {
            wtr.write_record([
                s.slot.to_string(),
                s.trade_count.to_string(),
                s.mean_edge_bps.to_string(),
                s.min_edge_bps.to_string(),
                s.max_edge_bps.to_string(),
                s.total_notional_usdc.to_string(),
                s.mean_match_dt_ms.to_string(),
            ])?;
        }

        wtr.flush()?;
        println!("wrote: {}", path);
    }

    // ===== Phase 4.2: edge × dt / edge × fee / edge × notional diagnostics =====

    // Trade-level vectors (for correlation + plot CSV)
    let edge_vec: Vec<f64> = matched.iter().map(|m| m.edge_bps).collect();
    let dt_vec: Vec<f64> = matched.iter().map(|m| m.match_time_diff_ms as f64).collect();
    let notional_vec: Vec<f64> = matched.iter().map(|m| m.notional_usdc).collect();
    let fee_usd_vec: Vec<f64> = matched
        .iter()
        .map(|m| {
            let lamports = m.fee_lamports.unwrap_or(0) as f64;
            (lamports / 1_000_000_000.0) * mean_ext_sol_usd
        })
        .collect();

    let corr_edge_dt = pearson_corr(&edge_vec, &dt_vec);
    let corr_edge_fee_usd = pearson_corr(&edge_vec, &fee_usd_vec);
    let corr_edge_notional = pearson_corr(&edge_vec, &notional_vec);

    println!("\n=== Phase 4.2 diagnostics ===");
    match corr_edge_dt {
        Some(v) => println!("corr(edge_bps, match_dt_ms)      : {:.4}", v),
        None => println!("corr(edge_bps, match_dt_ms)      : N/A"),
    }
    match corr_edge_fee_usd {
        Some(v) => println!("corr(edge_bps, fee_usd_proxy)    : {:.4}", v),
        None => println!("corr(edge_bps, fee_usd_proxy)    : N/A"),
    }
    match corr_edge_notional {
        Some(v) => println!("corr(edge_bps, notional_usdc)    : {:.4}", v),
        None => println!("corr(edge_bps, notional_usdc)    : N/A"),
    }

    #[derive(Debug, Clone)]
    struct DtBucketAgg {
        label: &'static str,
        count: usize,
        mean_edge_bps: f64,
        median_edge_bps: f64,
        mean_notional_usdc: f64,
        mean_fee_usd_proxy: f64,
        min_dt_ms: i64,
        max_dt_ms: i64,
    }

    fn dt_bucket_label(dt_ms: i64) -> &'static str {
        if dt_ms < 100 {
            "[0,100)"
        } else if dt_ms < 250 {
            "[100,250)"
        } else if dt_ms < 500 {
            "[250,500)"
        } else if dt_ms < 1000 {
            "[500,1000)"
        } else {
            "[1000,2000]"
        }
    }

    let dt_bucket_order = ["[0,100)", "[100,250)", "[250,500)", "[500,1000)", "[1000,2000]"];
    let mut dt_bucket_map: BTreeMap<&'static str, Vec<&MatchedTradeEdge>> = BTreeMap::new();
    for m in &matched {
        let key = dt_bucket_label(m.match_time_diff_ms);
        dt_bucket_map.entry(key).or_default().push(m);
    }

    let mut dt_bucket_aggs = Vec::<DtBucketAgg>::new();
    for label in dt_bucket_order {
        if let Some(xs) = dt_bucket_map.get(label) {
            if xs.is_empty() {
                continue;
            }

            let count = xs.len();
            let mean_edge_bps = xs.iter().map(|x| x.edge_bps).sum::<f64>() / count as f64;

            let mut edge_vals: Vec<f64> = xs.iter().map(|x| x.edge_bps).collect();
            edge_vals.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let median_edge_bps = percentile_sorted(&edge_vals, 0.50).unwrap_or(0.0);

            let mean_notional_usdc = xs.iter().map(|x| x.notional_usdc).sum::<f64>() / count as f64;

            let fee_usd_proxy_vals: Vec<f64> = xs
                .iter()
                .map(|x| {
                    let lamports = x.fee_lamports.unwrap_or(0) as f64;
                    (lamports / 1_000_000_000.0) * mean_ext_sol_usd
                })
                .collect();

            let mean_fee_usd_proxy = if fee_usd_proxy_vals.is_empty() {
                0.0
            } else {
                fee_usd_proxy_vals.iter().sum::<f64>() / fee_usd_proxy_vals.len() as f64
            };

            let min_dt_ms = xs.iter().map(|x| x.match_time_diff_ms).min().unwrap_or(0);
            let max_dt_ms = xs.iter().map(|x| x.match_time_diff_ms).max().unwrap_or(0);

            dt_bucket_aggs.push(DtBucketAgg {
                label,
                count,
                mean_edge_bps,
                median_edge_bps,
                mean_notional_usdc,
                mean_fee_usd_proxy,
                min_dt_ms,
                max_dt_ms,
            });
        }
    }

    println!("\ndt-bucket analysis (matched trades):");
    println!(
        "{:<12} {:>6} {:>10} {:>10} {:>12} {:>12} {:>8} {:>8}",
        "dt_bucket", "count", "mean_edge", "med_edge", "mean_notnl", "mean_fee", "dt_min", "dt_max"
    );
    for b in &dt_bucket_aggs {
        println!(
            "{:<12} {:>6} {:>10.3} {:>10.3} {:>12.3} {:>12.6} {:>8} {:>8}",
            b.label,
            b.count,
            b.mean_edge_bps,
            b.median_edge_bps,
            b.mean_notional_usdc,
            b.mean_fee_usd_proxy,
            b.min_dt_ms,
            b.max_dt_ms
        );
    }

    // ===== CSV: dt_buckets.csv =====
    {
        let path = "results/dt_buckets.csv";
        let mut wtr = csv::Writer::from_path(path)?;

        wtr.write_record([
            "dt_bucket",
            "count",
            "mean_edge_bps",
            "median_edge_bps",
            "mean_notional_usdc",
            "mean_fee_usd_proxy",
            "min_dt_ms",
            "max_dt_ms",
        ])?;

        for b in &dt_bucket_aggs {
            wtr.write_record([
                b.label.to_string(),
                b.count.to_string(),
                b.mean_edge_bps.to_string(),
                b.median_edge_bps.to_string(),
                b.mean_notional_usdc.to_string(),
                b.mean_fee_usd_proxy.to_string(),
                b.min_dt_ms.to_string(),
                b.max_dt_ms.to_string(),
            ])?;
        }

        wtr.flush()?;
        println!("wrote: {}", path);
    }

    // ===== CSV: edge_dt_points.csv (scatter plot source) =====
    {
        let path = "results/edge_dt_points.csv";
        let mut wtr = csv::Writer::from_path(path)?;

        wtr.write_record([
            "slot",
            "tx_ts_sec",
            "edge_bps",
            "match_time_diff_ms",
            "notional_usdc",
            "fee_lamports",
            "fee_usd_proxy",
            "edge_usd_proxy",
        ])?;

        for m in &matched {
            let fee_lamports = m.fee_lamports.unwrap_or(0);
            let fee_usd_proxy = (fee_lamports as f64 / 1_000_000_000.0) * mean_ext_sol_usd;
            let edge_usd_proxy = (m.edge_bps / 10_000.0) * m.notional_usdc;

            wtr.write_record([
                m.slot.to_string(),
                m.tx_ts_sec.to_string(),
                m.edge_bps.to_string(),
                m.match_time_diff_ms.to_string(),
                m.notional_usdc.to_string(),
                fee_lamports.to_string(),
                fee_usd_proxy.to_string(),
                edge_usd_proxy.to_string(),
            ])?;
        }

        wtr.flush()?;
        println!("wrote: {}", path);
    }

    let total_notional: f64 = matched.iter().map(|m| m.notional_usdc).sum();
    let slot_count = slot_aggs.len();

    println!("\nsummary (edge_bps_at_trigger proxy, Coinbase SOL-USD as external):");
    println!("  raw txs                      : {}", txs.len());
    println!("  parsed trades (all)          : {}", trades.len());
    println!("  normalized SOL/USDC trades   : {}", norm_trades.len());
    println!("  matched trades w/ Coinbase   : {}", matched.len());
    println!("  unmatched/skipped            : {}", unmatched_count);
    println!("  dropped by match dt filter   : {}", dropped_by_match_dt);
    println!("  unique slots (matched)       : {}", slot_count);
    println!("  total notional usdc (matched): {:.3}", total_notional);
    println!("  mean Coinbase match dt       : {:.1} ms", mean_match_dt_ms);
    println!("  max Coinbase match dt        : {} ms", max_match_dt_observed);

    println!("\ntrade-level edge_bps distribution:");
    println!("  min  : {:.3}", edge_min);
    println!("  p10  : {:.3}", edge_p10);
    println!("  p25  : {:.3}", edge_p25);
    println!("  p50  : {:.3}", edge_p50);
    println!("  p75  : {:.3}", edge_p75);
    println!("  p90  : {:.3}", edge_p90);
    println!("  max  : {:.3}", edge_max);
    println!("  mean : {:.3}", edge_mean);

    // ===== CSV: real_summary.csv =====
    write_real_summary_csv(
        "results/real_summary.csv",
        txs.len(),
        trades.len(),
        norm_trades.len(),
        matched.len(),
        unmatched_count,
        dropped_by_match_dt,
        slot_count,
        total_notional,
        mean_match_dt_ms,
        max_match_dt_observed,
        edge_min,
        edge_p10,
        edge_p25,
        edge_p50,
        edge_p75,
        edge_p90,
        edge_max,
        edge_mean,
        fee_count,
        mean_ext_sol_usd,
        fee_lamports_min,
        fee_lamports_p10,
        fee_lamports_p50,
        fee_lamports_p90,
        fee_lamports_max,
        fee_lamports_mean,
        fee_usd_min,
        fee_usd_p10,
        fee_usd_p50,
        fee_usd_p90,
        fee_usd_max,
        fee_usd_mean,
        mean_edge_usd_proxy,
        edge_to_fee_ratio_mean,
    )?;

    println!("\nNext:");
    println!("- Use CSVs to generate Figure set (scatter / bucket bars / time series)");
    println!("- Feed quantiles into PFDA sim parameter sweep");
    println!("- Compare PFDA discount/window settings against vanilla TFMM LVR proxy");

    Ok(())
}

// =========================
// live (placeholder)
// =========================

pub fn run_live(pool: &str) -> Result<()> {
    println!("live command reached (placeholder) - pool={pool}");
    println!("Next: wire this to realtime Helius + Coinbase streams");
    Ok(())
}

// =========================
// local utils
// =========================

fn truncate_label(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max.saturating_sub(1)])
    }
}

fn percentile_sorted(xs: &[f64], p: f64) -> Option<f64> {
    if xs.is_empty() {
        return None;
    }
    if !(0.0..=1.0).contains(&p) {
        return None;
    }

    let n = xs.len();
    if n == 1 {
        return Some(xs[0]);
    }

    let pos = p * (n as f64 - 1.0);
    let lo = pos.floor() as usize;
    let hi = pos.ceil() as usize;

    if lo == hi {
        Some(xs[lo])
    } else {
        let w = pos - lo as f64;
        Some(xs[lo] * (1.0 - w) + xs[hi] * w)
    }
}

fn mean(xs: &[f64]) -> Option<f64> {
    if xs.is_empty() {
        None
    } else {
        Some(xs.iter().sum::<f64>() / xs.len() as f64)
    }
}

fn pearson_corr(xs: &[f64], ys: &[f64]) -> Option<f64> {
    if xs.len() != ys.len() || xs.len() < 2 {
        return None;
    }

    let mx = mean(xs)?;
    let my = mean(ys)?;

    let mut num = 0.0_f64;
    let mut den_x = 0.0_f64;
    let mut den_y = 0.0_f64;

    for (x, y) in xs.iter().zip(ys.iter()) {
        let dx = *x - mx;
        let dy = *y - my;
        num += dx * dy;
        den_x += dx * dx;
        den_y += dy * dy;
    }

    if den_x <= 0.0 || den_y <= 0.0 {
        return None;
    }

    Some(num / (den_x.sqrt() * den_y.sqrt()))
}

fn ensure_results_dir() -> Result<()> {
    fs::create_dir_all("results")?;
    Ok(())
}

fn write_sim_summaries_csv(summaries: &[tfmm_sim::SimulationSummary]) -> Result<()> {
    ensure_results_dir()?;

    let path = "results/sim_summaries.csv";
    let mut wtr = csv::Writer::from_path(path)?;

    // CSVのヘッダー（列名）にPFDAの指標を追加
    wtr.write_record([
        "label",
        "slots",
        "arb_count",
        "arb_rate",
        "avg_slots_between_arb",
        "median_slots_between_arb",
        "mean_drift_pre",
        "mean_drift_post",
        "total_arb_gross_usd",
        "total_arb_net_usd",
        "avg_extraction_per_arb",
        "avg_net_per_arb",
        "mean_edge_bps_when_arb",
        "mean_threshold_bps_used",
        "mean_cost_usd_used",
        // ▼ ここから下の5行を追加
        "total_protocol_revenue_usd",
        "total_validator_searcher_revenue_usd",
        "total_lp_loss_proxy_usd",
        "lvr_proxy_usd",
        "lvr_proxy_ratio",
    ])?;

    for s in summaries {
        wtr.write_record([
            s.label.clone(),
            s.slots.to_string(),
            s.arb_count.to_string(),
            s.arb_rate.to_string(),
            s.avg_slots_between_arb.to_string(),
            s.median_slots_between_arb.to_string(),
            s.mean_drift_pre.to_string(),
            s.mean_drift_post.to_string(),
            s.total_arb_gross_usd.to_string(),
            s.total_arb_net_usd.to_string(),
            s.avg_extraction_per_arb.to_string(),
            s.avg_net_per_arb.to_string(),
            s.mean_edge_bps_when_arb.to_string(),
            s.mean_threshold_bps_used.to_string(),
            s.mean_cost_usd_used.to_string(),
            // ▼ ここから下の5行を追加
            s.total_protocol_revenue_usd.to_string(),
            s.total_validator_searcher_revenue_usd.to_string(),
            s.total_lp_loss_proxy_usd.to_string(),
            s.lvr_proxy_usd.to_string(),
            s.lvr_proxy_ratio.to_string(),
        ])?;
    }

    wtr.flush()?;
    println!("wrote: {}", path);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn write_real_summary_csv(
    path: &str,
    raw_txs: usize,
    parsed_trades: usize,
    normalized_trades: usize,
    matched_trades: usize,
    unmatched_skipped: usize,
    dropped_by_match_dt: usize,
    unique_slots_matched: usize,
    total_notional_usdc: f64,
    mean_match_dt_ms: f64,
    max_match_dt_ms: i64,
    edge_min: f64,
    edge_p10: f64,
    edge_p25: f64,
    edge_p50: f64,
    edge_p75: f64,
    edge_p90: f64,
    edge_max: f64,
    edge_mean: f64,
    fee_count: usize,
    mean_ext_sol_usd: f64,
    fee_lamports_min: f64,
    fee_lamports_p10: f64,
    fee_lamports_p50: f64,
    fee_lamports_p90: f64,
    fee_lamports_max: f64,
    fee_lamports_mean: f64,
    fee_usd_min: f64,
    fee_usd_p10: f64,
    fee_usd_p50: f64,
    fee_usd_p90: f64,
    fee_usd_max: f64,
    fee_usd_mean: f64,
    mean_edge_usd_proxy: f64,
    edge_to_fee_ratio_mean: f64,
) -> Result<()> {
    ensure_results_dir()?;

    let mut wtr = csv::Writer::from_path(path)?;

    wtr.write_record([
        "raw_txs",
        "parsed_trades",
        "normalized_sol_usdc_trades",
        "matched_trades",
        "unmatched_skipped",
        "dropped_by_match_dt",
        "unique_slots_matched",
        "total_notional_usdc",
        "mean_match_dt_ms",
        "max_match_dt_ms",
        "edge_min_bps",
        "edge_p10_bps",
        "edge_p25_bps",
        "edge_p50_bps",
        "edge_p75_bps",
        "edge_p90_bps",
        "edge_max_bps",
        "edge_mean_bps",
        "fee_count",
        "mean_ext_sol_usd",
        "fee_lamports_min",
        "fee_lamports_p10",
        "fee_lamports_p50",
        "fee_lamports_p90",
        "fee_lamports_max",
        "fee_lamports_mean",
        "fee_usd_min",
        "fee_usd_p10",
        "fee_usd_p50",
        "fee_usd_p90",
        "fee_usd_max",
        "fee_usd_mean",
        "mean_edge_usd_proxy",
        "edge_to_fee_ratio_mean",
    ])?;

    wtr.write_record([
        raw_txs.to_string(),
        parsed_trades.to_string(),
        normalized_trades.to_string(),
        matched_trades.to_string(),
        unmatched_skipped.to_string(),
        dropped_by_match_dt.to_string(),
        unique_slots_matched.to_string(),
        total_notional_usdc.to_string(),
        mean_match_dt_ms.to_string(),
        max_match_dt_ms.to_string(),
        edge_min.to_string(),
        edge_p10.to_string(),
        edge_p25.to_string(),
        edge_p50.to_string(),
        edge_p75.to_string(),
        edge_p90.to_string(),
        edge_max.to_string(),
        edge_mean.to_string(),
        fee_count.to_string(),
        mean_ext_sol_usd.to_string(),
        fee_lamports_min.to_string(),
        fee_lamports_p10.to_string(),
        fee_lamports_p50.to_string(),
        fee_lamports_p90.to_string(),
        fee_lamports_max.to_string(),
        fee_lamports_mean.to_string(),
        fee_usd_min.to_string(),
        fee_usd_p10.to_string(),
        fee_usd_p50.to_string(),
        fee_usd_p90.to_string(),
        fee_usd_max.to_string(),
        fee_usd_mean.to_string(),
        mean_edge_usd_proxy.to_string(),
        edge_to_fee_ratio_mean.to_string(),
    ])?;

    wtr.flush()?;
    println!("wrote: {}", path);
    Ok(())
}

fn write_pfda_sweep_summary_csv(rows: &[tfmm_sim::PfdaSweepRow]) -> Result<()> {
    ensure_results_dir()?;

    let path = "results/pfda_sweep_summary.csv";
    let mut wtr = csv::Writer::from_path(path)?;

    wtr.write_record([
        "label",
        "window_slots",
        "fee_discount_bps",
        "alpha",

        "vanilla_lvr_proxy_usd",
        "vanilla_lvr_proxy_ratio",
        "vanilla_arb_rate",
        "vanilla_total_protocol_revenue_usd",
        "vanilla_total_validator_searcher_revenue_usd",
        "vanilla_total_lp_loss_proxy_usd",

        "pfda_lvr_proxy_usd",
        "pfda_lvr_proxy_ratio",
        "pfda_arb_rate",
        "pfda_total_protocol_revenue_usd",
        "pfda_total_validator_searcher_revenue_usd",
        "pfda_total_lp_loss_proxy_usd",

        "lvr_reduction_usd",
        "lvr_reduction_ratio",
        "lvr_reduction_pct",
        "protocol_revenue_delta_usd",
        "validator_revenue_delta_usd",
        "lp_loss_delta_usd",
    ])?;

    for r in rows {
        wtr.write_record([
            r.label.clone(),
            r.window_slots.to_string(),
            r.fee_discount_bps.to_string(),
            r.alpha.to_string(),

            r.vanilla_lvr_proxy_usd.to_string(),
            r.vanilla_lvr_proxy_ratio.to_string(),
            r.vanilla_arb_rate.to_string(),
            r.vanilla_total_protocol_revenue_usd.to_string(),
            r.vanilla_total_validator_searcher_revenue_usd.to_string(),
            r.vanilla_total_lp_loss_proxy_usd.to_string(),

            r.pfda_lvr_proxy_usd.to_string(),
            r.pfda_lvr_proxy_ratio.to_string(),
            r.pfda_arb_rate.to_string(),
            r.pfda_total_protocol_revenue_usd.to_string(),
            r.pfda_total_validator_searcher_revenue_usd.to_string(),
            r.pfda_total_lp_loss_proxy_usd.to_string(),

            r.lvr_reduction_usd.to_string(),
            r.lvr_reduction_ratio.to_string(),
            r.lvr_reduction_pct.to_string(),
            r.protocol_revenue_delta_usd.to_string(),
            r.validator_revenue_delta_usd.to_string(),
            r.lp_loss_delta_usd.to_string(),
        ])?;
    }

    wtr.flush()?;
    println!("wrote: {}", path);
    Ok(())
}
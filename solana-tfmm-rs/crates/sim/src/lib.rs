use anyhow::Result;
use std::fmt;

// =========================
// Core config / enums
// =========================

#[derive(Debug, Clone)]
pub enum AuctionMode {
    /// 従来: 誰でも同じ条件で裁定
    Vanilla,

    /// PFDA: 勝者が一定期間だけ実効コスト優位
    PfdaWindowed(PfdaParams),
}

#[derive(Debug, Clone)]
pub struct PfdaParams {
    /// 1ウィンドウの長さ（slot数）
    pub window_slots: usize,

    /// winnerの protocol fee discount (bps)
    /// 例: 2.0 bps
    pub fee_discount_bps: f64,

    /// オークション収入モデル（簡易）
    pub auction_payment_mode: AuctionPaymentMode,

    /// 競争度（0~1）
    /// 1.0 = 勝者の期待超過利益をほぼ全額 protocol に返す想定
    pub auction_competitiveness_alpha: f64,
}

#[derive(Debug, Clone)]
pub enum AuctionPaymentMode {
    /// auction収入なし（差分影響だけ見たいとき）
    None,

    /// 勝者の実現超過利益の alpha を protocol revenue とみなす
    RealizedExcessShare,

    /// 勝者の期待超過利益を固定proxyで課金（slot配賦は簡易）
    FixedPerWindowUsd(f64),
}

#[derive(Debug, Clone)]
pub enum ThresholdMode {
    /// 固定閾値（bps）
    FixedBps(f64),

    /// mixture threshold（例: 20/60/20）
    MixtureBps {
        low_bps: f64,
        base_bps: f64,
        high_bps: f64,
        w_low: f64,
        w_base: f64,
        w_high: f64,
    },
}

#[derive(Debug, Clone)]
pub enum CostMode {
    /// 固定コスト（USD）
    FixedUsd(f64),

    /// mixture cost proxy
    MixtureUsd {
        low_usd: f64,
        base_usd: f64,
        high_usd: f64,
        w_low: f64,
        w_base: f64,
        w_high: f64,
    },
}

#[derive(Debug, Clone)]
pub struct SimulationConfig {
    // horizon
    pub slots: usize,
    pub dt_seconds: f64,

    // pool / sizing
    pub tvl_usd: f64,
    pub rebalance_notional_usd: f64,

    // synthetic price path
    pub sigma_annual: f64,
    pub drift_annual: f64,
    pub seed: u64,

    // TFMM / drift generation simplification
    /// slotごとの target shift が pool price に与える基本押し出し量（log-price proxy）
    pub weight_shift_push_per_slot: f64,

    /// arb後にどの程度 drift を残すか（0=完全修正, 0.5=半分残す）
    pub post_trade_residual_ratio: f64,

    // arbitrage policy
    pub threshold_mode: ThresholdMode,
    pub cost_mode: CostMode,
    pub auction_mode: AuctionMode,
}

impl Default for SimulationConfig {
    fn default() -> Self {
        Self {
            slots: 1200,
            dt_seconds: 0.4,
            tvl_usd: 100_000.0,
            rebalance_notional_usd: 500.0,
            sigma_annual: 0.80,
            drift_annual: 0.0,
            seed: 42,
            weight_shift_push_per_slot: 0.00012,
            post_trade_residual_ratio: 0.50,
            threshold_mode: ThresholdMode::FixedBps(2.5),
            cost_mode: CostMode::FixedUsd(0.10),
            auction_mode: AuctionMode::Vanilla,
        }
    }
}

// =========================
// Runtime state
// =========================

#[derive(Debug, Clone)]
pub struct WindowState {
    pub window_index: usize,
    pub winner_active: bool,
    pub winner_threshold_discount_bps: f64,
    pub winner_cost_discount_usd: f64,
}

impl Default for WindowState {
    fn default() -> Self {
        Self {
            window_index: 0,
            winner_active: false,
            winner_threshold_discount_bps: 0.0,
            winner_cost_discount_usd: 0.0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SlotObservation {
    pub slot: usize,
    pub ext_price: f64,
    pub pool_price_pre: f64,
    pub pool_price_post: f64,

    pub drift_pre_abs: f64,
    pub drift_post_abs: f64,

    pub arb_fired: bool,
    pub edge_bps: f64,

    pub threshold_bps_used: f64,
    pub cost_usd_used: f64,

    pub gross_extraction_usd: f64,
    pub net_extraction_usd: f64,

    // PFDA-related
    pub pfda_winner_active: bool,
    pub protocol_revenue_usd: f64,
    pub validator_searcher_revenue_usd: f64,
    pub lp_loss_proxy_usd: f64,
}

#[derive(Debug, Clone, Default)]
pub struct RevenueBreakdown {
    pub protocol_revenue_usd: f64,
    pub validator_searcher_revenue_usd: f64,
    pub arb_net_revenue_usd: f64,
    pub lp_loss_proxy_usd: f64, // >0 を「LPから流出した価値」として扱う
}

#[derive(Debug, Clone)]
pub struct SimulationSummary {
    pub label: String,

    pub slots: usize,
    pub arb_count: usize,
    pub arb_rate: f64,
    pub avg_slots_between_arb: f64,
    pub median_slots_between_arb: f64,

    pub mean_drift_pre: f64,
    pub mean_drift_post: f64,
    pub max_drift_pre: f64,
    pub max_drift_post: f64,

    pub total_arb_gross_usd: f64,
    pub total_arb_net_usd: f64,
    pub avg_extraction_per_arb: f64,
    pub avg_net_per_arb: f64,

    pub mean_edge_bps_when_arb: f64,
    pub mean_threshold_bps_used: f64,
    pub mean_cost_usd_used: f64,

    // PFDA metrics
    pub total_protocol_revenue_usd: f64,
    pub total_validator_searcher_revenue_usd: f64,
    pub total_lp_loss_proxy_usd: f64,

    pub lvr_proxy_usd: f64,
    pub lvr_proxy_ratio: f64, // vs TVL
}

impl fmt::Display for SimulationSummary {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(f, "label                  : {}", self.label)?;
        writeln!(f, "slots                  : {}", self.slots)?;
        writeln!(f, "arb_count              : {}", self.arb_count)?;
        writeln!(f, "arb_rate               : {:.4} ({:.2}%)", self.arb_rate, self.arb_rate * 100.0)?;
        writeln!(f, "avg_slots_between_arb  : {:.2}", self.avg_slots_between_arb)?;
        writeln!(f, "median_slots_between_arb: {:.2}", self.median_slots_between_arb)?;
        writeln!(f, "mean_drift_pre         : {:.6}", self.mean_drift_pre)?;
        writeln!(f, "mean_drift_post        : {:.6}", self.mean_drift_post)?;
        writeln!(f, "max_drift_pre          : {:.6}", self.max_drift_pre)?;
        writeln!(f, "max_drift_post         : {:.6}", self.max_drift_post)?;
        writeln!(f, "total_arb_gross_usd    : {:.4}", self.total_arb_gross_usd)?;
        writeln!(f, "total_arb_net_usd      : {:.4}", self.total_arb_net_usd)?;
        writeln!(f, "avg_extraction_per_arb : {:.4}", self.avg_extraction_per_arb)?;
        writeln!(f, "avg_net_per_arb        : {:.4}", self.avg_net_per_arb)?;
        writeln!(f, "mean_edge_bps_when_arb : {:.4}", self.mean_edge_bps_when_arb)?;
        writeln!(f, "mean_threshold_bps_used: {:.4}", self.mean_threshold_bps_used)?;
        writeln!(f, "mean_cost_usd_used     : {:.6}", self.mean_cost_usd_used)?;
        writeln!(f, "total_protocol_revenue_usd          : {:.4}", self.total_protocol_revenue_usd)?;
        writeln!(f, "total_validator_searcher_revenue_usd: {:.4}", self.total_validator_searcher_revenue_usd)?;
        writeln!(f, "total_lp_loss_proxy_usd             : {:.4}", self.total_lp_loss_proxy_usd)?;
        writeln!(f, "lvr_proxy_usd           : {:.4}", self.lvr_proxy_usd)?;
        writeln!(f, "lvr_proxy_ratio         : {:.6}", self.lvr_proxy_ratio)
    }
}


// =========================
// Public entrypoint
// =========================

pub fn run_simulation(
    config: &SimulationConfig,
    label: impl Into<String>,
) -> Result<(SimulationSummary, Vec<SlotObservation>)> {
    let label = label.into();

    let mut rng = SmallRng::new(config.seed);

    let mut ext_price = 1.0_f64;
    let mut pool_price = 1.0_f64;

    let mut obs = Vec::with_capacity(config.slots);

    let mut last_arb_slot: Option<usize> = None;
    let mut gaps: Vec<usize> = Vec::new();

    let mut arb_count = 0usize;
    let mut sum_drift_pre = 0.0;
    let mut sum_drift_post = 0.0;
    let mut max_drift_pre: f64 = 0.0;
    let mut max_drift_post: f64 = 0.0;

    let mut total_gross = 0.0;
    let mut total_net = 0.0;
    let mut sum_edge_bps_when_arb = 0.0;
    let mut sum_threshold_bps_used = 0.0;
    let mut sum_cost_usd_used = 0.0;

    let mut revenue = RevenueBreakdown::default();

    let mut window_state = WindowState::default();

    for slot in 0..config.slots {
        update_window_state(slot, config, &mut window_state);

        // 1) 外部価格更新（簡易GBM近似）
        let ret = sample_log_return_per_slot(config, &mut rng);
        ext_price *= ret.exp();

        // 2) TFMMのtarget shiftによる pool implied price押し出し（簡易）
        let pool_price_pre = pool_price * (config.weight_shift_push_per_slot).exp();

        // 3) edge / drift 計算
        let drift_pre_abs = relative_diff(pool_price_pre, ext_price);
        let edge_bps = drift_pre_abs * 10_000.0;

        // 4) 発火閾値 / コスト
        let base_threshold_bps = sample_threshold_bps(&config.threshold_mode, &mut rng);
        let base_cost_usd = sample_cost_usd(&config.cost_mode, &mut rng);

        let (threshold_bps_used, cost_usd_used, winner_active) =
            effective_arb_terms(base_threshold_bps, base_cost_usd, config, &window_state);

        // 5) 裁定発火判定
        let arb_fired = edge_bps >= threshold_bps_used;

        let mut pool_price_post = pool_price_pre;
        let mut gross_extraction_usd = 0.0;
        let mut net_extraction_usd = 0.0;
        let mut protocol_revenue_usd = 0.0;
        let mut validator_searcher_revenue_usd = 0.0;
        let mut lp_loss_proxy_usd = 0.0;

        if arb_fired {
            arb_count += 1;

            if let Some(prev) = last_arb_slot {
                gaps.push(slot - prev);
            }
            last_arb_slot = Some(slot);

            // 6) 裁定後の pool price (部分修正)
            let log_pool_pre = pool_price_pre.ln();
            let log_ext = ext_price.ln();
            let residual = config.post_trade_residual_ratio.clamp(0.0, 1.0);
            let log_pool_post = log_ext + (log_pool_pre - log_ext) * residual;
            pool_price_post = log_pool_post.exp();

            // 7) 収益 proxy
            gross_extraction_usd = (edge_bps / 10_000.0) * config.rebalance_notional_usd;

            let split = apply_revenue_split(gross_extraction_usd, cost_usd_used, config, &window_state);

            protocol_revenue_usd = split.protocol_revenue_usd;
            validator_searcher_revenue_usd = split.validator_searcher_revenue_usd;
            net_extraction_usd = split.arb_net_revenue_usd;
            lp_loss_proxy_usd = split.lp_loss_proxy_usd;

            revenue.protocol_revenue_usd += protocol_revenue_usd;
            revenue.validator_searcher_revenue_usd += validator_searcher_revenue_usd;
            revenue.arb_net_revenue_usd += net_extraction_usd;
            revenue.lp_loss_proxy_usd += lp_loss_proxy_usd;

            total_gross += gross_extraction_usd;
            total_net += net_extraction_usd;
            sum_edge_bps_when_arb += edge_bps;
            sum_threshold_bps_used += threshold_bps_used;
            sum_cost_usd_used += cost_usd_used;
        }

        let drift_post_abs = relative_diff(pool_price_post, ext_price);

        sum_drift_pre += drift_pre_abs;
        sum_drift_post += drift_post_abs;
        max_drift_pre = max_drift_pre.max(drift_pre_abs);
        max_drift_post = max_drift_post.max(drift_post_abs);

        obs.push(SlotObservation {
            slot,
            ext_price,
            pool_price_pre,
            pool_price_post,
            drift_pre_abs,
            drift_post_abs,
            arb_fired,
            edge_bps,
            threshold_bps_used,
            cost_usd_used,
            gross_extraction_usd,
            net_extraction_usd,
            pfda_winner_active: winner_active,
            protocol_revenue_usd,
            validator_searcher_revenue_usd,
            lp_loss_proxy_usd,
        });

        pool_price = pool_price_post;
    }

    let slots_f = config.slots as f64;
    let arb_rate = if config.slots == 0 { 0.0 } else { arb_count as f64 / slots_f };

    let avg_gap = if gaps.is_empty() {
        0.0
    } else {
        gaps.iter().sum::<usize>() as f64 / gaps.len() as f64
    };
    let med_gap = median_usize(&gaps) as f64;

    let avg_extraction_per_arb = if arb_count == 0 { 0.0 } else { total_gross / arb_count as f64 };
    let avg_net_per_arb = if arb_count == 0 { 0.0 } else { total_net / arb_count as f64 };
    let mean_edge_bps_when_arb = if arb_count == 0 { 0.0 } else { sum_edge_bps_when_arb / arb_count as f64 };
    let mean_threshold_bps_used = if arb_count == 0 { 0.0 } else { sum_threshold_bps_used / arb_count as f64 };
    let mean_cost_usd_used = if arb_count == 0 { 0.0 } else { sum_cost_usd_used / arb_count as f64 };

    let lvr_proxy_usd = revenue.lp_loss_proxy_usd;
    let lvr_proxy_ratio = if config.tvl_usd > 0.0 { lvr_proxy_usd / config.tvl_usd } else { 0.0 };

    let summary = SimulationSummary {
        label,
        slots: config.slots,
        arb_count,
        arb_rate,
        avg_slots_between_arb: avg_gap,
        median_slots_between_arb: med_gap,
        mean_drift_pre: if config.slots == 0 { 0.0 } else { sum_drift_pre / slots_f },
        mean_drift_post: if config.slots == 0 { 0.0 } else { sum_drift_post / slots_f },
        max_drift_pre,
        max_drift_post,
        total_arb_gross_usd: total_gross,
        total_arb_net_usd: total_net,
        avg_extraction_per_arb,
        avg_net_per_arb,
        mean_edge_bps_when_arb,
        mean_threshold_bps_used,
        mean_cost_usd_used,
        total_protocol_revenue_usd: revenue.protocol_revenue_usd,
        total_validator_searcher_revenue_usd: revenue.validator_searcher_revenue_usd,
        total_lp_loss_proxy_usd: revenue.lp_loss_proxy_usd,
        lvr_proxy_usd,
        lvr_proxy_ratio,
    };

    Ok((summary, obs))
}

// =========================
// Revenue split logic (PFDA heart)
// =========================

fn apply_revenue_split(
    gross_extraction_usd: f64,
    cost_usd: f64,
    config: &SimulationConfig,
    _window_state: &WindowState,
) -> RevenueBreakdown {
    let mut out = RevenueBreakdown::default();

    match &config.auction_mode {
        AuctionMode::Vanilla => {
            let arb_net = (gross_extraction_usd - cost_usd).max(0.0);

            // 最小モデル: VanillaのMEV利得は validator/searcher に吸われる
            out.protocol_revenue_usd = 0.0;
            out.validator_searcher_revenue_usd = arb_net;
            out.arb_net_revenue_usd = 0.0;

            // 修正箇所: protocol_revenue_usd を LPの損失に含めない
            out.lp_loss_proxy_usd =
                out.validator_searcher_revenue_usd + out.arb_net_revenue_usd;
        }
        AuctionMode::PfdaWindowed(p) => {
            let pre_payment_net = (gross_extraction_usd - cost_usd).max(0.0);

            let protocol_payment = match p.auction_payment_mode {
                AuctionPaymentMode::None => 0.0,
                AuctionPaymentMode::RealizedExcessShare => {
                    (pre_payment_net * p.auction_competitiveness_alpha.clamp(0.0, 1.0))
                        .min(pre_payment_net)
                }
                AuctionPaymentMode::FixedPerWindowUsd(x) => {
                    if p.window_slots == 0 { 0.0 } else { x / p.window_slots as f64 }
                }
            };

            let winner_net = (pre_payment_net - protocol_payment).max(0.0);

            // PFDAでは「検索者/バリデータへ漏れる分」を小さく置く簡易モデル
            out.protocol_revenue_usd = protocol_payment;
            out.validator_searcher_revenue_usd = 0.0;
            out.arb_net_revenue_usd = winner_net;

            // 修正箇所: protocol_revenue_usd を LPの損失に含めない
            out.lp_loss_proxy_usd =
                out.validator_searcher_revenue_usd + out.arb_net_revenue_usd;
        }
    }

    out
}

// =========================
// Effective threshold / cost under PFDA
// =========================

fn effective_arb_terms(
    base_threshold_bps: f64,
    base_cost_usd: f64,
    config: &SimulationConfig,
    window_state: &WindowState,
) -> (f64, f64, bool) {
    match &config.auction_mode {
        AuctionMode::Vanilla => (base_threshold_bps, base_cost_usd, false),
        AuctionMode::PfdaWindowed(p) => {
            if !window_state.winner_active {
                return (base_threshold_bps, base_cost_usd, false);
            }

            // discountはまず threshold に反映（小さいedgeでも取れる）
            let th = (base_threshold_bps - p.fee_discount_bps).max(0.0);

            // costも少し下がる近似（後で実測ベースに置換）
            let cost_discount_usd = (base_cost_usd * 0.2).min(base_cost_usd);
            let c = (base_cost_usd - cost_discount_usd).max(0.0);

            (th, c, true)
        }
    }
}

fn update_window_state(slot: usize, config: &SimulationConfig, state: &mut WindowState) {
    match &config.auction_mode {
        AuctionMode::Vanilla => {
            state.window_index = 0;
            state.winner_active = false;
            state.winner_threshold_discount_bps = 0.0;
            state.winner_cost_discount_usd = 0.0;
        }
        AuctionMode::PfdaWindowed(p) => {
            let ws = p.window_slots.max(1);
            state.window_index = slot / ws;
            state.winner_active = true; // 最小版: 毎window必ず勝者あり
            state.winner_threshold_discount_bps = p.fee_discount_bps;
            state.winner_cost_discount_usd = 0.0;
        }
    }
}

// =========================
// Sampling helpers (deterministic pseudo-rng)
// =========================

#[derive(Debug, Clone)]
struct SmallRng {
    state: u64,
}

impl SmallRng {
    fn new(seed: u64) -> Self {
        Self { state: seed ^ 0x9E3779B97F4A7C15 }
    }

    fn next_u64(&mut self) -> u64 {
        // xorshift64*
        let mut x = self.state;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.state = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }

    fn next_f64(&mut self) -> f64 {
        let v = self.next_u64() >> 11;
        (v as f64) / ((1u64 << 53) as f64)
    }

    fn sample_standard_normal(&mut self) -> f64 {
        // Box-Muller
        let u1 = (1.0 - self.next_f64()).max(1e-12);
        let u2 = self.next_f64();
        (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos()
    }
}

fn sample_log_return_per_slot(cfg: &SimulationConfig, rng: &mut SmallRng) -> f64 {
    let dt_years = cfg.dt_seconds / (365.0 * 24.0 * 3600.0);
    let mu = cfg.drift_annual;
    let sigma = cfg.sigma_annual;
    let z = rng.sample_standard_normal();
    (mu - 0.5 * sigma * sigma) * dt_years + sigma * dt_years.sqrt() * z
}

fn sample_threshold_bps(mode: &ThresholdMode, rng: &mut SmallRng) -> f64 {
    match mode {
        ThresholdMode::FixedBps(x) => *x,
        ThresholdMode::MixtureBps {
            low_bps,
            base_bps,
            high_bps,
            w_low,
            w_base,
            w_high: _,
        } => {
            let u = rng.next_f64();
            if u < *w_low {
                *low_bps
            } else if u < (*w_low + *w_base) {
                *base_bps
            } else {
                *high_bps
            }
        }
    }
}

fn sample_cost_usd(mode: &CostMode, rng: &mut SmallRng) -> f64 {
    match mode {
        CostMode::FixedUsd(x) => *x,
        CostMode::MixtureUsd {
            low_usd,
            base_usd,
            high_usd,
            w_low,
            w_base,
            w_high: _,
        } => {
            let u = rng.next_f64();
            if u < *w_low {
                *low_usd
            } else if u < (*w_low + *w_base) {
                *base_usd
            } else {
                *high_usd
            }
        }
    }
}

// =========================
// Utilities
// =========================

fn relative_diff(a: f64, b: f64) -> f64 {
    if b == 0.0 {
        0.0
    } else {
        ((a - b) / b).abs()
    }
}

fn median_usize(xs: &[usize]) -> usize {
    if xs.is_empty() {
        return 0;
    }
    let mut v = xs.to_vec();
    v.sort_unstable();
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2
    }
}

// =========================
// Preset experiment helpers
// =========================

fn default_real_calibrated_base_config() -> SimulationConfig {
    let mut cfg = SimulationConfig::default();

    // Phase 4.2 実測からの近似値をデフォルトに入れる（あとで差し替えやすく）
    cfg.threshold_mode = ThresholdMode::MixtureBps {
        low_bps: 0.150,   // p10 edge_bps 近似
        base_bps: 1.801,  // p50 edge_bps 近似
        high_bps: 4.384,  // p90 edge_bps 近似
        w_low: 0.2,
        w_base: 0.6,
        w_high: 0.2,
    };

    cfg.cost_mode = CostMode::MixtureUsd {
        low_usd: 0.000409,   // p10 fee_usd_proxy
        base_usd: 0.000828,  // p50 fee_usd_proxy
        high_usd: 0.001779,  // p90 fee_usd_proxy
        w_low: 0.2,
        w_base: 0.6,
        w_high: 0.2,
    };

    cfg
}

// =========================
// Preset experiment helpers (3 Pools Validation)
// =========================

pub fn run_pfda_baseline_vs_pfda() -> Result<Vec<SimulationSummary>> {
    let mut out = Vec::new();

    // 共通のPFDAパラメータ（最適な結果が出た設定）
    let optimal_pfda_params = PfdaParams {
        window_slots: 50,
        fee_discount_bps: 1.0,
        auction_payment_mode: AuctionPaymentMode::RealizedExcessShare,
        auction_competitiveness_alpha: 0.9, // 競争激化を想定
    };

    // ---------------------------------------------------------
    // プール1: SOL/USDT (標準的なボラティリティ・高流動性)
    // ---------------------------------------------------------
    let mut cfg_standard = SimulationConfig::default();
    cfg_standard.sigma_annual = 0.80; // 年次ボラティリティ 80%
    cfg_standard.threshold_mode = ThresholdMode::MixtureBps {
        low_bps: 0.150, base_bps: 1.800, high_bps: 4.300,
        w_low: 0.2, w_base: 0.6, w_high: 0.2,
    };
    cfg_standard.cost_mode = CostMode::FixedUsd(0.0008); // 手数料平均

    // Vanilla (SOL/USDT)
    cfg_standard.auction_mode = AuctionMode::Vanilla;
    let (s1_v, _) = run_simulation(&cfg_standard, "[Pool 1: SOL/USDT] Vanilla TFMM")?;
    out.push(s1_v);

    // PFDA (SOL/USDT)
    cfg_standard.auction_mode = AuctionMode::PfdaWindowed(optimal_pfda_params.clone());
    let (s1_p, _) = run_simulation(&cfg_standard, "[Pool 1: SOL/USDT] PFDA TFMM")?;
    out.push(s1_p);


    // ---------------------------------------------------------
    // プール2: SOL/pippin (ミームコイン・超高ボラティリティ)
    // ---------------------------------------------------------
    let mut cfg_meme = SimulationConfig::default();
    cfg_meme.sigma_annual = 3.50; // 年次ボラティリティ 350% (激しい乱高下)
    cfg_meme.threshold_mode = ThresholdMode::MixtureBps {
        low_bps: 5.0, base_bps: 15.0, high_bps: 35.0, // スプレッドが非常に広い
        w_low: 0.2, w_base: 0.6, w_high: 0.2,
    };
    cfg_meme.cost_mode = CostMode::FixedUsd(0.0020); // 優先手数料が高騰しやすい

    // Vanilla (SOL/pippin)
    cfg_meme.auction_mode = AuctionMode::Vanilla;
    let (s2_v, _) = run_simulation(&cfg_meme, "[Pool 2: SOL/pippin] Vanilla TFMM")?;
    out.push(s2_v);

    // PFDA (SOL/pippin)
    cfg_meme.auction_mode = AuctionMode::PfdaWindowed(optimal_pfda_params.clone());
    let (s2_p, _) = run_simulation(&cfg_meme, "[Pool 2: SOL/pippin] PFDA TFMM")?;
    out.push(s2_p);


    // ---------------------------------------------------------
    // プール3: SOL/jitoSOL (LST・超低ボラティリティ)
    // ---------------------------------------------------------
    let mut cfg_lst = SimulationConfig::default();
    cfg_lst.sigma_annual = 0.10; // 年次ボラティリティ 10% (ほぼ価格が連動)
    cfg_lst.threshold_mode = ThresholdMode::MixtureBps {
        low_bps: 0.05, base_bps: 0.20, high_bps: 0.50, // スプレッドが極端に狭い
        w_low: 0.2, w_base: 0.6, w_high: 0.2,
    };
    cfg_lst.cost_mode = CostMode::FixedUsd(0.0004); // 安い手数料で細かく抜かれる

    // Vanilla (SOL/jitoSOL)
    cfg_lst.auction_mode = AuctionMode::Vanilla;
    let (s3_v, _) = run_simulation(&cfg_lst, "[Pool 3: SOL/jitoSOL] Vanilla TFMM")?;
    out.push(s3_v);

    // PFDA (SOL/jitoSOL)
    cfg_lst.auction_mode = AuctionMode::PfdaWindowed(optimal_pfda_params.clone());
    let (s3_p, _) = run_simulation(&cfg_lst, "[Pool 3: SOL/jitoSOL] PFDA TFMM")?;
    out.push(s3_p);

    Ok(out)
}

// =========================
// Phase 5.1: PFDA parameter sweep
// =========================

#[derive(Debug, Clone)]
pub struct PfdaSweepRow {
    pub label: String,

    // parameters
    pub window_slots: usize,
    pub fee_discount_bps: f64,
    pub alpha: f64,

    // baseline metrics
    pub vanilla_lvr_proxy_usd: f64,
    pub vanilla_lvr_proxy_ratio: f64,
    pub vanilla_arb_rate: f64,
    pub vanilla_total_protocol_revenue_usd: f64,
    pub vanilla_total_validator_searcher_revenue_usd: f64,
    pub vanilla_total_lp_loss_proxy_usd: f64,

    // pfda metrics
    pub pfda_lvr_proxy_usd: f64,
    pub pfda_lvr_proxy_ratio: f64,
    pub pfda_arb_rate: f64,
    pub pfda_total_protocol_revenue_usd: f64,
    pub pfda_total_validator_searcher_revenue_usd: f64,
    pub pfda_total_lp_loss_proxy_usd: f64,

    // deltas
    pub lvr_reduction_usd: f64,
    pub lvr_reduction_ratio: f64,      // absolute ratio-point reduction
    pub lvr_reduction_pct: f64,        // percent reduction vs vanilla
    pub protocol_revenue_delta_usd: f64,
    pub validator_revenue_delta_usd: f64,
    pub lp_loss_delta_usd: f64,
}

pub fn run_pfda_parameter_sweep() -> Result<Vec<PfdaSweepRow>> {
    let mut rows = Vec::new();

    // ---- Shared calibrated baseline config (from Phase 4.x outputs) ----
    let mut base = SimulationConfig::default();

    // Threshold calibration (Phase 3.7/3.8-ish proxy)
    base.threshold_mode = ThresholdMode::MixtureBps {
        low_bps: 1.0,
        base_bps: 2.5,
        high_bps: 4.5,
        w_low: 0.2,
        w_base: 0.6,
        w_high: 0.2,
    };

    // Cost calibration (replace these if newer Phase 4.2 quantiles differ)
    // You can wire these from CSV later; for now fixed constants are fine.
    base.cost_mode = CostMode::MixtureUsd {
        low_usd: 0.000409,
        base_usd: 0.000828,
        high_usd: 0.001779,
        w_low: 0.2,
        w_base: 0.6,
        w_high: 0.2,
    };

    // Make sim a bit more stable for sweep comparisons
    base.slots = 5000;
    base.seed = 42;

    // ---- Vanilla once (reference) ----
    let mut vanilla_cfg = base.clone();
    vanilla_cfg.auction_mode = AuctionMode::Vanilla;
    let (vanilla_summary, _vanilla_obs) = run_simulation(&vanilla_cfg, "Vanilla baseline")?;

    // ---- Sweep grids ----
    let window_slots_grid = [10_usize, 25, 50, 100, 250];
    let fee_discount_bps_grid = [0.5_f64, 1.0, 2.0, 3.0];
    let alpha_grid = [0.25_f64, 0.50, 0.75, 0.90];

    for &window_slots in &window_slots_grid {
        for &fee_discount_bps in &fee_discount_bps_grid {
            for &alpha in &alpha_grid {
                let mut cfg = base.clone();
                cfg.auction_mode = AuctionMode::PfdaWindowed(PfdaParams {
                    window_slots,
                    fee_discount_bps,
                    auction_payment_mode: AuctionPaymentMode::RealizedExcessShare,
                    auction_competitiveness_alpha: alpha,
                });

                let label = format!(
                    "PFDA ws={} disc={:.2}bps alpha={:.2}",
                    window_slots, fee_discount_bps, alpha
                );

                let (pfda_summary, _obs) = run_simulation(&cfg, label.clone())?;

                let vanilla_lvr = vanilla_summary.lvr_proxy_usd;
                let pfda_lvr = pfda_summary.lvr_proxy_usd;

                let lvr_reduction_usd = vanilla_lvr - pfda_lvr;
                let lvr_reduction_ratio =
                    vanilla_summary.lvr_proxy_ratio - pfda_summary.lvr_proxy_ratio;

                let lvr_reduction_pct = if vanilla_lvr.abs() > 1e-12 {
                    lvr_reduction_usd / vanilla_lvr.abs()
                } else {
                    0.0
                };

                rows.push(PfdaSweepRow {
                    label,

                    window_slots,
                    fee_discount_bps,
                    alpha,

                    vanilla_lvr_proxy_usd: vanilla_summary.lvr_proxy_usd,
                    vanilla_lvr_proxy_ratio: vanilla_summary.lvr_proxy_ratio,
                    vanilla_arb_rate: vanilla_summary.arb_rate,
                    vanilla_total_protocol_revenue_usd: vanilla_summary.total_protocol_revenue_usd,
                    vanilla_total_validator_searcher_revenue_usd:
                        vanilla_summary.total_validator_searcher_revenue_usd,
                    vanilla_total_lp_loss_proxy_usd: vanilla_summary.total_lp_loss_proxy_usd,

                    pfda_lvr_proxy_usd: pfda_summary.lvr_proxy_usd,
                    pfda_lvr_proxy_ratio: pfda_summary.lvr_proxy_ratio,
                    pfda_arb_rate: pfda_summary.arb_rate,
                    pfda_total_protocol_revenue_usd: pfda_summary.total_protocol_revenue_usd,
                    pfda_total_validator_searcher_revenue_usd:
                        pfda_summary.total_validator_searcher_revenue_usd,
                    pfda_total_lp_loss_proxy_usd: pfda_summary.total_lp_loss_proxy_usd,

                    lvr_reduction_usd,
                    lvr_reduction_ratio,
                    lvr_reduction_pct,
                    protocol_revenue_delta_usd:
                        pfda_summary.total_protocol_revenue_usd
                            - vanilla_summary.total_protocol_revenue_usd,
                    validator_revenue_delta_usd:
                        pfda_summary.total_validator_searcher_revenue_usd
                            - vanilla_summary.total_validator_searcher_revenue_usd,
                    lp_loss_delta_usd:
                        pfda_summary.total_lp_loss_proxy_usd
                            - vanilla_summary.total_lp_loss_proxy_usd,
                });
            }
        }
    }

    Ok(rows)
}
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns
import numpy as np
import os

# グラフの保存先ディレクトリ
OUTPUT_DIR = "figures/paper"
os.makedirs(OUTPUT_DIR, exist_ok=True)

# 論文用にスタイルを綺麗に設定
sns.set_theme(style="whitegrid", context="paper", font_scale=1.2)

# ==========================================
# Figure 1: MEVのスピード競争（散布図）
# ==========================================
def plot_edge_vs_dt():
    print("Generating Figure 1: Edge vs DT Scatter...")
    if not os.path.exists("results/edge_dt_points.csv"):
        print("  -> Skipping Figure 1: 'results/edge_dt_points.csv' not found.")
        return

    df = pd.read_csv("results/edge_dt_points.csv")
    plt.figure(figsize=(8, 6))
    sns.scatterplot(
        data=df, 
        x="match_time_diff_ms", 
        y="edge_bps", 
        size="notional_usdc", 
        hue="edge_bps", 
        palette="flare",
        sizes=(20, 200),
        alpha=0.7
    )
    
    plt.title("Solana MEV Speed vs Profitability (Real Market Data)", fontweight='bold')
    plt.xlabel("Delay to External Price Match (dt_ms)")
    plt.ylabel("Price Discrepancy (edge_bps)")
    plt.legend(bbox_to_anchor=(1.05, 1), loc=2, borderaxespad=0.)
    plt.tight_layout()
    plt.savefig(f"{OUTPUT_DIR}/fig1_edge_vs_dt.png", dpi=300, bbox_inches='tight')
    plt.close()

# ==========================================
# Figure 2: Vanilla vs PFDA LVR比較（3プール版）
# ==========================================
def plot_lvr_comparison():
    print("Generating Figure 2: 3-Pool LVR Comparison Bar Chart...")
    df = pd.read_csv("results/sim_summaries.csv")
    
    # VanillaとPFDAを分離して整理
    df_vanilla = df[df['label'].str.contains("Vanilla")].reset_index(drop=True)
    df_pfda = df[df['label'].str.contains("PFDA")].reset_index(drop=True)
    
    # ラベルからプール名を抽出（例: "[Pool 1: SOL/USDT]" -> "Pool 1: SOL/USDT"）
    labels = df_vanilla['label'].apply(lambda x: x.split(']')[0].replace('[', '')).tolist()
    
    x = np.arange(len(labels))
    width = 0.35
    
    fig, ax = plt.subplots(figsize=(10, 6))
    
    # VanillaのLVR (既存AMMのLP損失)
    rects1 = ax.bar(x - width/2, df_vanilla['total_lp_loss_proxy_usd'], width, 
                    label='Vanilla TFMM (Net LVR)', color='#e74c3c', alpha=0.8)
    
    # PFDAのLVR (提案AMMのLP損失)
    rects2 = ax.bar(x + width/2, df_pfda['total_lp_loss_proxy_usd'], width, 
                    label='PFDA TFMM (Net LVR)', color='#3498db', alpha=0.9)
    
    # プロトコルが取り返した利益（注釈として表示）
    for i in range(len(labels)):
        prot_rev = df_pfda.loc[i, 'total_protocol_revenue_usd']
        ax.annotate(f"Recaptured:\n${prot_rev:.1f}",
                    xy=(x[i] + width/2, df_pfda.loc[i, 'total_lp_loss_proxy_usd']),
                    xytext=(0, 20), textcoords="offset points",
                    ha='center', va='bottom', fontsize=10,
                    bbox=dict(boxstyle="round,pad=0.3", fc="#2ecc71", alpha=0.2),
                    arrowprops=dict(arrowstyle="->", connectionstyle="arc3,rad=.2", color="#2ecc71"))

    ax.set_ylabel('Total LP Loss (USD)')
    ax.set_title('LVR Reduction Across Different Volatility Regimes', fontweight='bold', fontsize=14)
    ax.set_xticks(x)
    ax.set_xticklabels(labels, fontsize=11)
    ax.legend(loc='upper right')
    
    # LVR削減率（%）を計算して赤字で表示
    for i in range(len(labels)):
        vanilla_lvr = df_vanilla.loc[i, 'total_lp_loss_proxy_usd']
        pfda_lvr = df_pfda.loc[i, 'total_lp_loss_proxy_usd']
        if vanilla_lvr > 0:
            reduction_pct = (vanilla_lvr - pfda_lvr) / vanilla_lvr * 100
            ax.annotate(f"▼{reduction_pct:.1f}%",
                        xy=(x[i] - width/2, vanilla_lvr),
                        xytext=(0, 5), textcoords="offset points",
                        ha='center', va='bottom', fontsize=11, fontweight='bold', color='#c0392b')

    plt.tight_layout()
    plt.savefig(f"{OUTPUT_DIR}/fig2_lvr_comparison.png", dpi=300, bbox_inches='tight')
    plt.close()

# ==========================================
# Figure 3: PFDA パラメータスイープ（ヒートマップ）
# ==========================================
def plot_pfda_heatmap():
    print("Generating Figure 3: PFDA Sweep Heatmap...")
    if not os.path.exists("results/pfda_sweep_summary.csv"):
        print("  -> Skipping Figure 3: 'results/pfda_sweep_summary.csv' not found.")
        return
        
    df = pd.read_csv("results/pfda_sweep_summary.csv")
    
    # discount=1.0bps のデータに絞る
    df_slice = df[df['fee_discount_bps'] == 1.0].copy()
    if df_slice.empty:
        return
        
    # Pivot for heatmap
    heatmap_data = df_slice.pivot(index="alpha", columns="window_slots", values="lvr_reduction_pct")
    
    # %表記にするために100倍
    heatmap_data = heatmap_data * 100
    
    plt.figure(figsize=(8, 6))
    sns.heatmap(heatmap_data, annot=True, fmt=".2f", cmap="YlGnBu", cbar_kws={'label': 'LVR Reduction (%)'})
    plt.title('LVR Reduction % (Discount = 1.0 bps)', fontweight='bold')
    plt.xlabel('Window Slots (Duration)')
    plt.ylabel('Competitiveness Alpha')
    
    plt.tight_layout()
    plt.savefig(f"{OUTPUT_DIR}/fig3_pfda_heatmap.png", dpi=300, bbox_inches='tight')
    plt.close()

if __name__ == "__main__":
    print("Starting paper figure generation...")
    plot_edge_vs_dt()
    plot_lvr_comparison()
    plot_pfda_heatmap()
    print(f"\n✅ All paper figures generated successfully in '{OUTPUT_DIR}/'")
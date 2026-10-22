"""Figures and summary statistics from the Earth Engine CSV exports.

Usage: python make_figures.py   (run from the repo folder)
Needs: pandas, matplotlib, scipy
"""
import matplotlib.pyplot as plt
import pandas as pd
from scipy import stats

BLUE, ORANGE, AQUA = '#2a78d6', '#eb6834', '#1baf7a'
INK, MUTED, GRID = '#0b0b0b', '#52514e', '#e4e3df'
L8_YEAR = 2013   # first summer with Landsat 8 OLI in the record

plt.rcParams.update({
    'font.size': 10, 'axes.edgecolor': MUTED, 'axes.labelcolor': INK,
    'xtick.color': MUTED, 'ytick.color': MUTED, 'axes.grid': True,
    'grid.color': GRID, 'grid.linewidth': 0.8, 'axes.spines.top': False,
    'axes.spines.right': False, 'legend.frameon': False, 'figure.dpi': 150,
})

d = pd.read_csv('annual_water_area.csv')
d['year'] = d['year'].astype(int)
d['precip_3yr_mm'] = d['wy_precip_mm'].rolling(3).sum()


def mark_l8(ax):
    ax.axvline(L8_YEAR - 0.5, color=MUTED, lw=1, ls=':')
    ax.text(L8_YEAR - 0.3, ax.get_ylim()[1] * 0.97, 'Landsat 8 added',
            color=MUTED, fontsize=8, va='top')


# 1. Annual open water: Landsat vs JRC, and river vs off-river
fig, (a, b) = plt.subplots(2, 1, figsize=(8, 6.5), sharex=True)
a.plot(d.year, d.water_ha, color=BLUE, lw=2, marker='o', ms=4, label='This study (Landsat, freq >= 0.25)')
a.plot(d.year, d.jrc_water_ha, color=ORANGE, lw=2, marker='o', ms=4, label='JRC Global Surface Water')
a.set_ylabel('Open water (ha)')
a.set_title('Open-water area around Saskatoon, May–September', loc='left', color=INK)
a.legend(loc='upper left')
a.set_ylim(0, None)
mark_l8(a)
b.plot(d.year, d.offriver_ha, color=AQUA, lw=2, marker='o', ms=4, label='Off-river (wetlands, sloughs, lakes)')
b.plot(d.year, d.river_ha, color=BLUE, lw=2, marker='o', ms=4, label='South Saskatchewan River corridor')
b.set_ylabel('Open water (ha)')
b.set_xlabel('Year')
b.legend(loc='upper left')
b.set_ylim(0, None)
mark_l8(b)
fig.tight_layout()
fig.savefig('annual_water_area.png')

# 2. Off-river water vs climate
c = d.dropna(subset=['pdsi', 'precip_3yr_mm'])
fig, axes = plt.subplots(1, 2, figsize=(9, 4), sharey=True)
for ax, x, label in [(axes[0], 'pdsi', 'Mean PDSI, May–September'),
                     (axes[1], 'precip_3yr_mm', 'Precipitation, 3 water years (mm)')]:
    for period, color, name in [(c.year < L8_YEAR, BLUE, f'1984–{L8_YEAR - 1}'),
                                (c.year >= L8_YEAR, ORANGE, f'{L8_YEAR}–{c.year.max()}')]:
        ax.scatter(c.loc[period, x], c.loc[period, 'offriver_ha'], s=30, color=color,
                   edgecolor='white', linewidth=1, label=name, zorder=3)
    r = stats.pearsonr(c[x], c.offriver_ha)
    ax.set_title(f'r = {r.statistic:.2f}, p = {r.pvalue:.3f}, n = {len(c)}', loc='left',
                 color=MUTED, fontsize=9)
    ax.set_xlabel(label)
axes[0].set_ylabel('Off-river open water (ha)')
axes[0].legend(loc='upper left')
fig.suptitle('Off-river water vs drought and multi-year precipitation', x=0.01, ha='left', color=INK)
fig.tight_layout()
fig.savefig('offriver_vs_climate.png')

# 3. JRC transitions
t = pd.read_csv('jrc_transition_area.csv').sort_values('area_ha')
fig, ax = plt.subplots(figsize=(7, 4))
ax.barh(t.name, t.area_ha, color=BLUE, height=0.7)
for y, v in enumerate(t.area_ha):
    ax.text(v + 80, y, f'{v:,.0f}', va='center', fontsize=8, color=MUTED)
ax.grid(axis='y', visible=False)
ax.set_xlabel('Area (ha)')
ax.set_title('Surface-water transitions, 1984–99 vs 2000–21 (JRC)', loc='left', color=INK)
fig.tight_layout()
fig.savefig('jrc_transitions.png')

# Summary statistics
print('Coverage (%):', d.coverage_pct.min(), '-', d.coverage_pct.max())
for col in ['water_ha', 'offriver_ha', 'river_ha', 'jrc_water_ha']:
    s = d.dropna(subset=[col])
    sen = stats.theilslopes(s[col], s.year)
    tau = stats.kendalltau(s.year, s[col])
    print(f'{col}: Sen slope {sen.slope:.0f} ha/yr, Kendall tau {tau.statistic:.2f} (p={tau.pvalue:.4f})')
j = d.dropna(subset=['jrc_water_ha'])
for lo, hi in [(1984, L8_YEAR - 1), (L8_YEAR, j.year.max())]:
    s = j[(j.year >= lo) & (j.year <= hi)]
    print(f'JRC / Landsat ratio {lo}-{hi}: {(s.jrc_water_ha / s.water_ha).mean():.2f}')
for x in ['wy_precip_mm', 'precip_3yr_mm', 'pdsi']:
    for y in ['offriver_ha', 'river_ha']:
        s = d.dropna(subset=[x])
        r = stats.pearsonr(s[x], s[y])
        print(f'{y} vs {x}: r={r.statistic:.2f}, p={r.pvalue:.4f}, n={len(s)}')

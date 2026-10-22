"""Figures and summary statistics from the Earth Engine CSV exports.

Usage: python make_figures.py   (run from the repo folder)
Needs: pandas, matplotlib, scipy, tifffile, imagecodecs
"""
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import tifffile
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
    ax.text(L8_YEAR - 0.3, ax.get_ylim()[1] * 0.35, 'Landsat 8\nadded',
            color=MUTED, fontsize=8, va='center')


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

# 4. Sensor check: Landsat 7 alone vs Landsat 8 alone
sc = pd.read_csv('sensor_check_L7_L8.csv')
sc['year'] = sc['year'].astype(int)
fig, (a, b) = plt.subplots(1, 2, figsize=(9.5, 4))
a.plot(sc.year, sc.water_ha_L8, color=ORANGE, lw=2, marker='o', ms=4, label='Landsat 8 only')
a.plot(sc.year, sc.water_ha_L7, color=BLUE, lw=2, marker='o', ms=4, label='Landsat 7 only')
a.set_ylim(0, None)
a.set_ylabel('Open water (ha)')
a.set_title('Same years, same pixels, two sensors', loc='left', color=INK)
a.legend(loc='lower left')
for col, color, name in [('water_ha', BLUE, 'Open water'), ('permanent_ha', ORANGE, 'Permanent water'),
                         ('offriver_ha', AQUA, 'Off-river water')]:
    b.plot(sc.year, sc[col + '_L8'] / sc[col + '_L7'], color=color, lw=2, marker='o', ms=4, label=name)
b.axhline(1, color=MUTED, lw=1)
b.set_ylim(0, None)
b.set_ylabel('Landsat 8 / Landsat 7 area')
b.set_title('Ratio', loc='left', color=INK)
b.legend(loc='lower left')
fig.tight_layout()
fig.savefig('sensor_check_L7_L8.png')

# 5. Sentinel-2 monthly water (2019 onwards)
m = pd.read_csv('s2_monthly_water_area.csv')
low = m.coverage_pct < 90
cmap = plt.get_cmap('Blues')
years = sorted(m.year.unique())
fig, (a, b) = plt.subplots(1, 2, figsize=(9.5, 4), sharey=True)
for ax, col, title in [(a, 'offriver_ha', 'Off-river'), (b, 'river_ha', 'River corridor')]:
    for i, y in enumerate(years):
        g = m[m.year == y]
        ax.plot(g.month, g[col], color=cmap(0.35 + 0.65 * i / (len(years) - 1)), lw=2,
                marker='o', ms=4, label=str(y))
    ax.scatter(m.month[low], m[col][low], s=70, facecolor='none', edgecolor=INK, lw=1, zorder=3,
               label='< 90% observed')
    ax.set_xticks(range(5, 10), ['May', 'Jun', 'Jul', 'Aug', 'Sep'])
    ax.set_title(title, loc='left', color=INK)
    ax.set_ylim(0, None)
a.set_ylabel('Open water (ha)')
b.legend(loc='upper right', ncol=2, fontsize=8)
fig.suptitle('Monthly open water from Sentinel-2', x=0.01, ha='left', color=INK)
fig.tight_layout()
fig.savefig('s2_monthly_water.png')

# 6. Per-pixel trend map
r = tifffile.imread(f'water_trend_1984_{d.year.max()}.tif')
trend, river = r[..., 0], r[..., 5]
km = 0.03   # 30 m pixels
extent = [0, trend.shape[1] * km, 0, trend.shape[0] * km]
fig, ax = plt.subplots(figsize=(8, 6.5))
ax.imshow(np.where(np.isfinite(river), 1.0, np.nan), cmap='Greys', vmin=0, vmax=8, extent=extent,
          interpolation='nearest')
im = ax.imshow(np.ma.masked_invalid(trend), cmap='RdBu', vmin=-0.2, vmax=0.2, extent=extent,
               interpolation='nearest')
ax.contour(np.flipud(river == 1), levels=[0.5], colors=MUTED, linewidths=0.6, extent=extent)
ax.grid(False)
ax.set_xlabel('km')
ax.set_ylabel('km')
ax.set_title(f'Change in water frequency per decade, 1984–{d.year.max()} (Sen\'s slope)',
             loc='left', color=INK)
fig.colorbar(im, ax=ax, shrink=0.7, label='Frequency change per decade (blue = wetter)')
fig.tight_layout()
fig.savefig('water_trend_map.png')

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
for col in ['water_ha', 'permanent_ha', 'offriver_ha']:
    ratio = sc[col + '_L8'] / sc[col + '_L7']
    print(f'L8 / L7 {col}: mean {ratio.mean():.2f} ({ratio.min():.2f}-{ratio.max():.2f})')
print('S2 mean by month (ha):')
print(m.groupby('month')[['water_ha', 'offriver_ha', 'river_ha']].mean().round(0).to_string())
q = m.groupby('year').water_ha.mean().to_frame('s2_ha').join(d.set_index('year').water_ha)
print(f'S2 May-Sep mean / Landsat annual: {(q.s2_ha / q.water_ha).mean():.2f}')
for name, mask in [('river', river == 1), ('off-river', river == 0)]:
    t = trend[mask & np.isfinite(trend)]
    print(f'Trend {name}: wetter {(t > 0.05).sum() * 0.09:,.0f} ha, drier {(t < -0.05).sum() * 0.09:,.0f} ha')

# PowMr 12.8V 100Ah LiFePO4: 4S voltage and SOC

The battery bank is four PowMr POW-100AH-12.8V batteries in series (4S, 16 cells). The pack is 51.2 V nominal, 100 Ah and 5.12 kWh. Series wiring raises the voltage and keeps the amp-hours of one battery.

Sources, both captured 2026-11-06:

- [Guide for LiFePO4 Voltage Chart & SOC 12V/24V/48V](https://powmr.com/blogs/news/lifepo4-voltage-chart-and-soc), PowMr blog, published 2024-08-26. The 4S pack uses the "51.2V (16s)" column. The guide's "48V (15s)" column is for 15-cell packs and does not apply.
- [POW-100AH-12.8V specification sheet](https://cdn.shopify.com/s/files/1/0746/0415/1079/files/PowMr_POW-100AH-12.8V_LiFePO4_Battery_Specification_Sheet_dd924441-3823-4b0d-85bb-7e1921140ad3.pdf?v=1783672150), linked from the [product page](https://powmr.com/products/lithium-battery-100ah-12-8v).

## Voltage to SOC

| SOC | Per cell | Per battery (12.8 V) | 4S pack (51.2 V) |
|---|---|---|---|
| 100% | 3.65 V | 14.6 V | 58.4 V |
| 99.5% | 3.45 V | 13.8 V | 55.2 V |
| 99% | 3.38 V | 13.52 V | 54.08 V |
| 90% | 3.35 V | 13.4 V | 53.6 V |
| 80% | 3.33 V | 13.32 V | 53.28 V |
| 70% | 3.30 V | 13.2 V | 52.8 V |
| 60% | 3.28 V | 13.12 V | 52.48 V |
| 50% | 3.26 V | 13.04 V | 52.16 V |
| 40% | 3.25 V | 13.0 V | 52.0 V |
| 30% | 3.23 V | 12.92 V | 51.68 V |
| 20% | 3.20 V | 12.8 V | 51.2 V |
| 15% | 3.05 V | 12.2 V | 48.8 V |
| 9.5% | 3.00 V | 12.0 V | 48.0 V |
| 5% | 2.80 V | 11.2 V | 44.8 V |
| 0.5% | 2.54 V | 10.16 V | 40.64 V |
| 0% | 2.50 V | 10.0 V | 40.0 V |

The pack column is the per-cell voltage times 16. The values are open-circuit voltages: PowMr says to disconnect loads and chargers and rest the battery for 15 to 30 minutes before measuring. Between 20% and 99% the pack voltage changes by only 2.88 V, so voltage measured under load or while charging gives a rough SOC estimate. Interpolate linearly between rows.

## Pack limits

From the specification sheet, multiplied by four for the pack:

| Limit | Per battery | 4S pack |
|---|---|---|
| Recommended charge voltage | 14.0 V | 56.0 V |
| Maximum charge voltage | 14.6 V | 58.4 V |
| Charging voltage range | 10.8 to 14.6 V | 43.2 to 58.4 V |
| Recommended discharge cutoff | 11.2 V | 44.8 V (5% SOC) |
| Maximum discharge cutoff | 10.8 V | 43.2 V |
| BMS over-voltage protection | 14.8 V | 59.2 V |
| BMS under-voltage protection | 10.0 V | 40.0 V |
| Maximum continuous charge and discharge current | 100 A | 100 A |

Before connecting batteries in series, PowMr says each battery should have the same remaining capacity.

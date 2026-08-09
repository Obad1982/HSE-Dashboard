# CO₂ Emission Factor Verification Note

**Energya — ITR HSE Dashboard 2026 · Environmental Data**
**Date:** 6 August 2026 · **Scope:** Fugitive refrigerants, process gases, Scope 1 & Scope 2
**Benchmark:** EPA 40 CFR Part 98 Subpart A, Table A-1 (AR5 GWPs, effective 1 Jan 2025) + EPA GHG Emission Factors Hub

---

## 1. Global Warming Potentials — verified

| Refrigerant | EPA Table A-1 (AR5) | Factor in workbook | Status |
|---|---|---|---|
| R‑11 (CFC‑11) | 4,660 | 4.66 | ✔ correct |
| R‑22 (HCFC‑22) | 1,760 | 1.76 | ✔ correct |
| R‑32 (HFC‑32) | 677 | 0.677 | ✔ correct |
| R‑134a (HFC‑134a) | 1,300 | 1.3 | ✔ correct |
| R‑410A (50 % HFC‑32 + 50 % HFC‑125) | 0.5×677 + 0.5×3,170 = 1,923.5 | 1.924 | ✔ correct |

The `/1000` is embedded in the factor, so `kg charged × factor = tonnes CO₂e`. This is dimensionally correct.

## 2. Non-conformity found and corrected

The workbook applied an additional **× 10 %** to R‑22, R‑134a and R‑410A only — and to neither R‑11 nor R‑32. No EPA, IPCC or GHG Protocol methodology supports this factor, and its application to three of five gases indicates a data-entry error rather than a methodological choice.

**Effect on reported fugitive emissions (t CO₂e):**

| Month | As reported | Corrected | Understated by |
|---|---:|---:|---:|
| Jan | 40.05 | 88.30 | ×2.2 |
| Feb | 40.05 | 88.30 | ×2.2 |
| Mar | 40.05 | 88.30 | ×2.2 |
| Apr | 40.05 | 88.30 | ×2.2 |
| May | 141.29 | 280.53 | ×2.0 |
| Jun | 11.53 | 115.29 | **×10.0** |
| **YTD** | **313.03** | **749.03** | **+436.00** |

June shows the full 10× gap because that month's charge was entirely R‑22 and R‑410A.

**Correction applied:** the `*10%` term is removed from columns I, K and L of the Environmental Data sheet, and from `ENV_FACT_DEF` in the monthly report application.

## 3. Other emission factors

| Source | Factor used | Reference value | Status |
|---|---|---|---|
| Diesel | 2.7 kg CO₂/L | EPA 10.18–10.21 kg CO₂/gal ÷ 3.785 = 2.69–2.70 | ✔ correct |
| LPG | 3.0 kg CO₂/kg | Propane stoichiometric = 2.99; EPA 5.72 kg/gal ÷ 1.923 kg/gal = 2.97 | ✔ correct |
| CO₂ cylinder / tank | 1.0 kg CO₂/kg | Direct release of purchased CO₂ | ✔ correct (inputs confirmed as kg) |
| Electricity | 0.42 kg CO₂/kWh | **Site-supplied.** Not an EPA figure — eGRID covers the US grid only. IEA Egypt grid ≈ 0.45–0.46 | ⚠ retain source documentation |

**Action required:** keep the utility letter or official national grid-factor publication on file. If the official Egyptian factor is 0.4576, Scope 2 for Jan–May rises from 5,164 t to 5,627 t (+462 t).

## 4. Structural defects repaired in the workbook

| Cell(s) | Defect | Fix |
|---|---|---|
| C35:C45 | Referenced only the refrigerant column; process-gas CO₂ (column I) was dropped from February onward, while C34 included it | Now `M{n}+I{n}` for all twelve months |
| H34:H45 | Test `IF(E+F="",…)` can never be true, and returns `#VALUE!` in any month where column F is blank | `IF(B{n}="",NA(),SUM(E{n}:F{n}))` |
| B46:M46 | YTD row had no totals; `SUBTOTAL` would propagate `#N/A` from future months | `AGGREGATE(9,6,…)`, which ignores errors; L46/M46 computed as ratios |
| C33 | Labelled "(Kg)" but holds tonnes CO₂e | Relabelled "Fugitive + Process Gases (Ton CO₂e)" |
| B17:D17 | "Cylinder /10 KG", "/25 KG" implied unit counts; inputs are actual kilograms | Relabelled "LPG (Kg)", "CO₂ Cylinder (Kg)", "CO₂ Tank (Kg)" |
| A3, A4 | `"Jan "` with a trailing space, `"feb"` lower-case — breaks lookups | Normalised to `Jan`, `Feb` |

## 5. Restated results (Jan–May 2026)

| | As reported | Corrected | Δ |
|---|---:|---:|---:|
| Scope 1 (t CO₂e) | 6,004 | 6,319 | +315 |
| Scope 2 (t CO₂e) | 5,164 | 5,164 | — |
| **Total (t CO₂e)** | **11,151** | **11,483** | **+332 (+2.98 %)** |
| Intensity (t CO₂e/t product) | 0.127 | 0.130 | +0.003 |

## 6. Verification performed

Recalculated the corrected workbook in a clean calculation engine and compared every monthly total against an independent Python implementation of the EPA factors. All five populated months reconcile to **0.00 t** difference. All 27 charts and 18 images in the Monthly Report sheet are intact.

---

*Prepared for internal HSE review. The original workbook is unchanged; corrections are delivered in a separate file for approval before replacing the master.*

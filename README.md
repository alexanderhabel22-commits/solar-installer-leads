# US Solar & Battery Installer Leads, Ranked by Real Installs

See which solar and battery companies actually install the most systems in any county or ZIP radius. This Actor reads every installation recorded in public utility interconnection and state incentive records and turns them into one ranked row per installer: how many systems they put in, how many had a battery, their market share in your area, total kW, the panel, inverter and battery brands they use, how their jobs are financed, and (for California installers) phone number, headquarters and state license number. No login, no API key.

Directory scrapers tell you who *says* they install solar. This tells you who *did*, how much, where and how recently.

## Who uses it

- **Solar distributors and equipment makers** (panels, inverters, batteries, racking): find the busiest installers in a territory, see which brands they use today, and spot fast-growing accounts.
- **Solar lenders, lease and PPA providers**: find installers that mostly sell cash or loan deals, or those already working with third-party owners.
- **Software and service vendors** (design, CRM, permitting, lead gen, insurance, staffing): build a list of installers sized by real job volume, not guesses.
- **Installers and investors**: benchmark competitors, track market share by county, and find acquisition targets.

## What you get

| rank | installer_name | installs | storage_installs | share_of_area_installs | total_kw_dc | last_install_date | phone | hq_city |
|---|---|---|---|---|---|---|---|---|
| 1 | Example Solar Inc | 2,917 | 1,541 | 0.071 | 21,400 | 2026-08-29 | (760) 555-0100 | Escondido |
| 2 | Example Home Energy | 2,465 | 1,176 | 0.060 | 17,900 | 2026-08-30 | (619) 555-0142 | San Diego |

*(Illustrative rows.)* Each row also has: other spellings of the company name, solar-only and battery installs, projects still in the pipeline (New York and Connecticut), average system size, total battery kWh, residential share, commercial jobs, share of jobs that are leased or on a PPA, top third-party owners, average price per watt, first and last install date, installs per year, every state the company is active in, top counties and cities, top panel, inverter and battery brands, headquarters city, state and ZIP, California CSLB license number with a link to the license page, and the public records each number came from.

Typical results for installs since January 2024: all five states give about 485,000 installs from about 2,100 companies with 5 or more jobs; San Diego County alone (2025 onward) gives about 41,000 installs from 300 companies. A full five-state run takes about a minute.

## Where the data comes from

All public, published by state agencies and utilities, updated monthly unless noted:

| State | Source | What it covers | Contact details |
|---|---|---|---|
| California | CPUC California Distributed Generation Statistics | Every solar and battery system interconnected to PG&E, SCE and SDG&E (over 2 million systems) | Phone, city, CSLB license |
| New York | NYSERDA solar and energy storage program data | Solar and battery projects supported by NYSERDA, including pipeline projects | None in the data |
| Massachusetts | MassCEC Production Tracking System report | Registered solar systems (refreshed a few times a year; recent SMART-era years are partial) | None in the data |
| Connecticut | Connecticut Green Bank RSIP and Energy Storage Solutions | Residential solar (to early 2024) and batteries (2022 onward) | None in the data |
| Oregon | Oregon Department of Energy Solar + Storage Rebates | Paid rebates by funding year (2023 onward) | None in the data |

The run summary (`RUN_SUMMARY` in the key-value store) shows how many records each source gave and the latest install date in each, so you always know how current the numbers are.

Companies that install in several states are merged into one row (same name, same California license or same phone number, with checks so that a shared call-centre number or a partner's license does not merge two different companies). National brands that changed names (SolarCity and Tesla, for example) are kept together.

## Input

- **States**: any of California, New York, Massachusetts, Connecticut and Oregon. Leave empty for all five.
- **Counties** (optional), e.g. `San Diego`, `Suffolk`, or a **ZIP code and radius** in miles. Only installs inside the area count, so the ranking and market share are for that area.
- **Installed on or after / before**: the date range. The default, January 2024 onward, shows who is active now.
- **Customer sector**: residential, commercial, or both.
- **Technology**: everything, solar only, batteries only, or solar plus battery together.
- **Minimum installs**, **only companies with a phone number**, **rank by** (installs, kW, battery installs, most recent install, pipeline) and **maximum results**.

## Pricing

You pay per installer company returned, plus a small fee per run. Rows come out best-ranked first, so a low maximum still gets you the top companies. You can also set a spending limit on the run.

## Data and privacy

Only business information: installer company names and the business phone, city and license number they filed with the utility. The public records hold no homeowner names; this Actor never outputs customer addresses, and self-installed systems (where the installer would be the homeowner) are left out.

## Tips

- Run it monthly on a schedule to watch market share move and catch new installers as they appear.
- Use **Rank by: Most recent install** to find companies that are active this month, or a recent **Installed on or after** date for momentum.
- For phone numbers outside California, export the list and run it through a contact-enrichment tool; the install counts are the part no other dataset has.

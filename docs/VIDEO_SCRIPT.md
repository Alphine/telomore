# Demo video script: Kaggle "AI4S Open Innovation: AI for Life Science"

Length: 5:00 (target 4:50 to 5:00). Language: English narration, about 650 words at a calm 135 words per minute.
Two products on screen, one story: **a transparent AI-for-science lab, including the results that did not work.**

Hard rules for every line of narration and every overlay:

* No clinical, diagnostic or anti-ageing claim. It is a model, not a patient.
* Say "model output", "simulated", "precomputed example" where applicable.
* The foci counter is **unvalidated**. The pairing finding is **strongly supported, not confirmed by IDR**.
* Numbers shown on screen must come from the app or `docs/EXPERIMENT_PROTOCOL.md`. Do not invent any.

## Timed beats

| Time | Beat | On screen | Narration (read as written) |
|---|---|---|---|
| 0:00-0:20 | Hook and scope | Landing page `studylab.id`, two cards (Telomere Lab, Foci Lab). Overlay: "computational research prototype - no medical claims". | "This is Telomere Evolution Lab and its companion, Foci Lab. Telomeres shorten every time a cell divides, and when one gets too short the cell stops dividing. We built a simulator of that process, an AI that searches it, and a second tool that analyses real microscopy. Everything you will see is a model or an open dataset. Nothing here is medical advice." |
| 0:20-0:50 | Demo mode, cached scenarios | `/telomore/simulate` as an anonymous visitor. Banner "Precomputed example - not live compute". Scenario cards: Normal fibroblast aging, High oxidative stress, Telomerase-positive. Click Fibroblast aging; locked form, charts. | "Anyone can open the app without an account. Visitors see precomputed example runs with fixed seeds: the banner says so. This is a normal culture without telomerase. Mean telomere length falls, the shortest telomere crosses the senescence limit, and the culture stops growing. The numbers are plain model outputs, not a prediction for any person." |
| 0:50-1:20 | Pro live run | Switch to a Pro account (already logged in). Live/Demo switch to Live. Edit stress level, press Run; progress; WebGL particle dish, age-index gauge with its disclaimer. | "Live computation is reserved for Pro accounts that an admin approves, so a public site cannot be used as free compute. As Pro I change the stress level and run it for real on the server. The dish is every simulated cell. The gauge is a synthetic vitality index of the model, and the disclaimer is always shown next to it." |
| 1:20-1:50 | 3D cell viewer | Click "Show 3D telomere view". Orbit; play cycles: caps teal to amber to red; grey body and bridges when senescent. | "A three-dimensional view makes the same numbers visible. Each cap is a telomere. Its length and colour follow the run's statistics until the cell is depleted. It is an illustration rebuilt from summary statistics, not a measured cell." |
| 1:50-2:35 | AI search and experiments | `/evolve` (demo scenario "Genetic algorithm on a stressed culture"), then `/pareto` "Survival vs intervention cost" front; then Experiments page. | "The AI part is an evolutionary search. A genetic algorithm proposes intervention settings, the simulator scores them, and the best survive. Because any weighting is a choice, the Pareto page shows the whole trade-off between survival and intervention cost instead of one winner. Every run is written to a ledger with its seed, configuration hash and code version, so it can be repeated." |
| 2:35-3:05 | Honest negative results | Experiments doc / app page showing Experiment E (protocol no better than constant at locked stress) and Experiment J (GA less robust than expected). Highlight the words "negative result". | "We also report what failed. Letting the optimiser time its interventions did not beat constant ones when the stress was locked. And a method we expected to degrade in high dimensions, the Gaussian-process learner, turned out to be the steadier one. Fourteen experiments are documented, including these, with the commands to rerun them." |
| 3:05-3:20 | Bridge to real data | Foci Lab home, gene explorer search "RNF168". | "To keep the simulator honest we added Foci Lab, built on a public genome-wide screen of DNA-damage foci, idr0010 from Doil and colleagues, with the original images and licence credited." |
| 3:20-4:05 | Browser compute and privacy | Foci Lab `lab.html`: drag two images in, pairing, Run, backend badge (GPU or CPU), overlay with nuclei and foci, export CSV and provenance JSON. Then DevTools Network tab empty, and a visible CSP line `connect-src 'none'`. | "Foci Lab can analyse your own images. The analysis engine runs inside your browser, on the GPU when available and otherwise on the CPU. Your pictures are never uploaded, and our server never runs your analysis. The page is forbidden from making network requests by its security policy, and a test fails if any network call is ever added. The counter is classical and unvalidated: tune it on your own controls. Results export with file hashes and parameters, so another lab can repeat them." |
| 4:05-4:40 | Plate mode and the pairing finding | `screen.html` plate 7-14: heatmap, table, side-by-side "pairing A by name / pairing B column-major". Overlay numbers: nuclei vs authors' cell counts 0.07 vs 0.56. | "Plate mode analyses a whole screen plate in the browser. While doing so we saw that the images match the authors' cell counts only when wells are numbered column by column. Three independent checks agree, including lethal-knockdown controls. We call this strongly supported but not confirmed. It may be a convention we missed, so we show both pairings and have prepared a polite report for the data curators." |
| 4:40-5:00 | Close | Admin dashboard glance (users, usage, no raw IPs), then repo/site URLs. | "Pro access is approved by an admin, and usage logs keep no images, no bodies and no raw addresses. Everything is open source with a reproducibility ledger and about eleven hundred automated tests. We built it to be checked, not just believed. Thank you." |

Word count of the narration column is about 650; trim the 2:35 and 4:05 beats first if you run long.

## Shot list

1. Landing page (two cards), 5 s hold.
2. Telomere Lab, anonymous: banner close-up, scenario cards (3 clicks), results charts. Screen record at 100 % zoom.
3. Login as the demo Pro account, Live switch, edit one parameter, Run, wait for the particle dish (cut the wait).
4. 3D view: slow orbit, scrub cycle slider across senescence.
5. Evolve live-curve scenario (cached), Pareto front hover on one point.
6. Experiments page or `docs/EXPERIMENT_PROTOCOL.md` headings E and J, highlight "negative result" text.
7. Foci Lab home, gene search.
8. Lab mode: files in, pairing, run, overlay zoom, CSV export click. DevTools Network panel visible and empty during the run.
9. CSP: view-source of `lab.html` showing `connect-src 'none'` (zoomed, 3 s).
10. Plate mode 7-14: heatmap fill, switch pairing A/B, show the two correlations.
11. Admin dashboard: stats cards and usage table (blur or use a throwaway dataset; no real usernames or emails).
12. End card: site URLs and "computational research prototype - not medical advice".

## Recording checklist

Before recording

- [ ] Resolution 1920x1080, 30 fps, browser zoom 100 %, window maximised, bookmarks bar hidden, notifications off.
- [ ] Light theme for Telomere Lab (higher contrast in video), same theme for Foci Lab.
- [ ] Two accounts on the deployed site: an anonymous window (no login) and a **throwaway demo Pro account** granted via the
  admin panel with a short expiry. Do not show real user emails, the admin credentials, the JWT, or the `.env`.
- [ ] Demo cache is current: run `python scripts/build_demo_cache.py` after any model change and confirm the banner reads
  "Precomputed example - not live compute". Scenarios used: simulate `fibroblast-aging`, `high-oxidative-stress`,
  `telomerase-positive`; evolve `stressed-culture-balanced`; pareto `survival-vs-cost`.
- [ ] Warm up the Railway service once (first request cold-starts), and pre-run the Pro simulation so the timing is known.
- [ ] Foci Lab: prepare two small sample images (nuclei + 53BP1) you have the right to show, plus pre-load plate 7-14 so the
  heatmap fills quickly (it is cached; an uncached plate takes about 13 minutes).
- [ ] Use a browser with WebGPU for the backend badge shot (Chrome or Edge on Windows); also check the CPU fallback label.
- [ ] Open DevTools Network (filter: all) docked at the bottom for the privacy shot; clear it before the Run.
- [ ] Narration recorded separately in a quiet room, 135 wpm; captions on (English), burned in or uploaded as SRT.

During

- [ ] Never type a password on camera; start already logged in.
- [ ] Keep the cursor slow and the clicks deliberate; cut load waits.
- [ ] Do not zoom into numbers that are not in the docs.

After

- [ ] Check every on-screen number against the app or `docs/EXPERIMENT_PROTOCOL.md`.
- [ ] Check that the words "unvalidated", "not confirmed", "precomputed example" and "model" each appear at least once.
- [ ] Final length at or under the contest limit; export 1080p H.264; upload and test the link logged out.

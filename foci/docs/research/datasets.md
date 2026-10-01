# Datasets for measuring Foci Lab accuracy

Verified 2026-09-30 / 2026-10-01. Full context and caveats: `docs/FOCI_BROWSER_COMPUTE.md` section 6.

| ID | What | Geometry | Ground truth | Licence | Size | Source | Use |
|---|---|---|---|---|---|---|---|
| BBBC039 | U2OS Hoechst, 200 fields | 520x696, uint16 (observed max 4095 = 12-bit) | instance masks, about 23,000 nuclei; RGBA PNG, red channel values 0-3, touching nuclei get different values, decode per value with connected components | CC0 | images 77.9 MB, masks 2.8 MB, metadata 18 KB | https://bbbc.broadinstitute.org/BBBC039 (files under https://data.broadinstitute.org/bbbc/BBBC039/) | nuclei F1, count bias; official split train 100 / validation 50 / test 50 (`metadata/training.txt`, `validation.txt`, `test.txt`) |
| BBBC006 | U2OS Hoechst, 768 fields x 32 focal planes | 696x520, 16-bit LZW TIFF | nucleus counts (CSV), foreground masks, labels | CC0 | about 26.4 GB (33 zips) | https://bbbc.broadinstitute.org/BBBC006 | focus robustness; use selected planes only |
| S-BSST265 (Kromp et al. 2020) | annotated DAPI nuclei, various cell/tissue types | mixed | expert annotations | not stated in API fields read: UNVERIFIED | 76.3 MB | https://www.ebi.ac.uk/biostudies/studies/S-BSST265 | generalisation check, after licence is confirmed |
| Zenodo 4067741 (pt.1), 5549971 (pt.2) | gH2AX / 53BP1 IRIF, 3-D confocal, head-and-neck primocultures, U-87, NHDF after irradiation | 3-D | manual focus coordinates by two experts (CSV), nuclei masks, train/val/test | CC BY 4.0 | 10-52 GB per archive | https://zenodo.org/records/4067741 , https://zenodo.org/records/5549971 | only open point-annotated foci set found; different modality, so tests foci logic, not idr0010 performance |
| idr0010 per-well table | authors' Cell Count, foci count, foci/cell | per well | aggregate of unpublished ImageJ routine, manual exclusions | CC BY 4.0 | small (already in repo) | IDR repository `idr0010-screenA-annotation.csv` | rank agreement only, under both image-to-row pairings |
| S-BIAD885 | idr0010 as OME-Zarr zips, 147 plates | 696x520, >u2, blosc lz4 | none (images) | CC BY 4.0 | 475,572,589 B for plate 7-14; about 356 MB of it is level-0 pixels | https://www.ebi.ac.uk/biostudies/BioImages/studies/S-BIAD885 | real-data parity and per-well tests |

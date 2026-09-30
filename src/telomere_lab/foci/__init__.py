"""53BP1 DNA-damage foci from real microscopy (IDR screen idr0010, Doil et al. 2009).

Image data: Image Data Resource (idr.openmicroscopy.org), study idr0010,
licensed CC BY 4.0, copyright Doil et al. Every page and export that shows it
must carry that attribution (see ATTRIBUTION).

53BP1 foci mark DNA double-strand breaks in general -- not telomeres
specifically. Anything this package says about the Telomere Lab model is a
qualitative comparison, not a calibration (docs/SCIENTIFIC_SCOPE.md).
"""

from .segment import FociParams, SegmentationResult, count_foci, nucleus_table, overlay_rgb
from .idr import IdrClient, fetch_image_channels

ATTRIBUTION = (
    "Images: Doil C, et al. RNF168 binds and amplifies ubiquitin conjugates on damaged chromosomes "
    "to allow accumulation of repair proteins. Cell 2009;136:435-446 (doi:10.1016/j.cell.2008.12.041). "
    "Via the Image Data Resource, study idr0010 (https://idr.openmicroscopy.org), CC BY 4.0."
)

__all__ = ["ATTRIBUTION", "FociParams", "SegmentationResult", "count_foci", "nucleus_table", "overlay_rgb",
           "IdrClient", "fetch_image_channels"]

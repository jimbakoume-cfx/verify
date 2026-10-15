# OCR-B font (test and training images only)

`OCRB.otf` is the OCR-B font from Matthew Skala's "OCR fonts" package, version 0.3.1
(https://tsukurimashou.org/ocr.php.en, file `ocr-0.3.1.zip`). It only draws images of fictitious
documents: the synthetic MRZ test images (`scripts/make-mrz-fixtures.py`), the worker's test specimens
(`scripts/make-specimens.py`), and the training images of our own MRZ model (`training/mrz/`). Only
rendered images are used; the font itself is never shipped to riders or deployed.

Licence: the font descends from Norbert Schwarz's METAFONT OCR-B, whose sources state
"Copyright 1995, 2010 Norbert Schwarz. You may freely use, modify and/or distribute this file,
without limitation." Matthew Skala states in the package documentation: "I make no copyright claim
on these fonts myself." The OCR-A font from the same package has a non-commercial restriction and is
deliberately not included.

SHA-256: 87c8d5bfd541d28023d2ba3383169c49f565e10d487ebb027ea0d735ef558707

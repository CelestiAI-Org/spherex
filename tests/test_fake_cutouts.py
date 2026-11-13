import json
import sys

from api.load_cache import CACHE_DIR, load_cutouts


def test_fake_mover_loads_as_cutouts():
    sys.path.insert(0, "scripts")
    import make_fake_cutouts
    make_fake_cutouts.main()
    cutouts = load_cutouts("fake_mover")
    assert 15 <= len(cutouts) <= 24
    c = cutouts[0]
    assert c.image.shape == c.flags.shape and c.flags.any() and 1 <= c.detector <= 6
    assert len({round(x.wcs.wcs.crpix[0], 3) for x in cutouts}) > 1  # WCS differ per cutout
    truth = json.loads((CACHE_DIR / "fake_mover" / "truth.json").read_text())
    assert len(truth["mover"]["positions"]) == 3
